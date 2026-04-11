import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface TaskStoreWriteLock {
  release(): Promise<void>;
}

export type TaskStoreWriteLockPayload = {
  pid?: number;
  createdAt?: string;
  starttime?: number;
};

type HeldTaskStoreWriteLock = {
  count: number;
  handle: fs.FileHandle;
  lockPath: string;
  releasePromise?: Promise<void>;
};

type CleanupState = {
  registered: boolean;
  cleanupHandlers: Map<CleanupSignal, () => void>;
};

type LockInspection = {
  pid: number | null;
  stale: boolean;
  staleReasons: string[];
};

const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;
type CleanupSignal = (typeof CLEANUP_SIGNALS)[number];

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30 * 60 * 1000;
const HELD_LOCKS = new Map<string, HeldTaskStoreWriteLock>();

let cleanupState: CleanupState = {
  registered: false,
  cleanupHandlers: new Map(),
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function resolvePositiveMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return fallback;
  }

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return value;
}

function isZombieProcess(pid: number): boolean {
  if (process.platform !== "linux") {
    return false;
  }

  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const stateMatch = status.match(/^State:\s+(\S)/m);
    return stateMatch?.[1] === "Z";
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  if (!isPositiveInteger(pid)) {
    return false;
  }

  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  return !isZombieProcess(pid);
}

function getProcessStartTime(pid: number): number | null {
  if (process.platform !== "linux" || !isPositiveInteger(pid)) {
    return null;
  }

  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEndIndex = stat.lastIndexOf(")");

    if (commEndIndex < 0) {
      return null;
    }

    const afterComm = stat.slice(commEndIndex + 1).trimStart();
    const fields = afterComm.split(/\s+/);
    const starttime = Number(fields[19]);
    return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
  } catch {
    return null;
  }
}

async function readLockPayload(lockPath: string): Promise<TaskStoreWriteLockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const payload: TaskStoreWriteLockPayload = {};

    if (isPositiveInteger(parsed.pid)) {
      payload.pid = parsed.pid;
    }

    if (typeof parsed.createdAt === "string") {
      payload.createdAt = parsed.createdAt;
    }

    if (
      typeof parsed.starttime === "number" &&
      Number.isInteger(parsed.starttime) &&
      parsed.starttime >= 0
    ) {
      payload.starttime = parsed.starttime;
    }

    return payload;
  } catch {
    return null;
  }
}

function inspectLockPayload(
  payload: TaskStoreWriteLockPayload | null,
  staleMs: number,
  nowMs: number,
): LockInspection {
  const pid = isPositiveInteger(payload?.pid) ? payload.pid : null;
  const pidAlive = pid !== null ? isPidAlive(pid) : false;
  const staleReasons: string[] = [];

  if (pid === null) {
    staleReasons.push("missing-pid");
  } else if (!pidAlive) {
    staleReasons.push("dead-pid");
  }

  if (pidAlive && pid !== null && typeof payload?.starttime === "number") {
    const currentStarttime = getProcessStartTime(pid);

    if (currentStarttime !== null && currentStarttime !== payload.starttime) {
      staleReasons.push("recycled-pid");
    }
  }

  const createdAtMs =
    typeof payload?.createdAt === "string" ? Date.parse(payload.createdAt) : Number.NaN;

  if (!Number.isFinite(createdAtMs)) {
    staleReasons.push("invalid-createdAt");
  } else if (nowMs - createdAtMs > staleMs) {
    staleReasons.push("too-old");
  }

  return {
    pid,
    stale: staleReasons.length > 0,
    staleReasons,
  };
}

function needsMtimeFallback(inspection: LockInspection): boolean {
  return (
    inspection.stale &&
    inspection.staleReasons.every(
      (reason) => reason === "missing-pid" || reason === "invalid-createdAt",
    )
  );
}

async function shouldReclaimLock(
  lockPath: string,
  inspection: LockInspection,
  staleMs: number,
  nowMs: number,
): Promise<boolean> {
  if (!inspection.stale) {
    return false;
  }

  if (!needsMtimeFallback(inspection)) {
    return true;
  }

  try {
    const stat = await fs.stat(lockPath);
    return nowMs - stat.mtimeMs > staleMs;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function releaseHeldLock(
  normalizedLockPath: string,
  held: HeldTaskStoreWriteLock,
): Promise<boolean> {
  const current = HELD_LOCKS.get(normalizedLockPath);

  if (current !== held) {
    return false;
  }

  held.count -= 1;

  if (held.count > 0) {
    return false;
  }

  if (held.releasePromise) {
    await held.releasePromise.catch(() => undefined);
    return true;
  }

  held.releasePromise = (async () => {
    try {
      await held.handle.close();
    } catch {
      // Best effort during shutdown and release.
    }

    try {
      await fs.rm(held.lockPath, { force: true });
    } catch {
      // Best effort during shutdown and release.
    }
  })();

  try {
    await held.releasePromise;
    return true;
  } finally {
    HELD_LOCKS.delete(normalizedLockPath);
    held.releasePromise = undefined;
  }
}

function releaseAllLocksSync(): void {
  for (const [normalizedLockPath, held] of HELD_LOCKS) {
    void held.handle.close().catch(() => undefined);

    try {
      fsSync.rmSync(held.lockPath, { force: true });
    } catch {
      // Best effort during process exit.
    }

    HELD_LOCKS.delete(normalizedLockPath);
  }
}

function handleTerminationSignal(signal: CleanupSignal): void {
  releaseAllLocksSync();

  const handler = cleanupState.cleanupHandlers.get(signal);
  const shouldReraise = process.listenerCount(signal) === 1;

  if (!handler || !shouldReraise) {
    return;
  }

  process.off(signal, handler);
  cleanupState.cleanupHandlers.delete(signal);

  try {
    process.kill(process.pid, signal);
  } catch {
    // Ignore shutdown errors.
  }
}

function registerCleanupHandlers(): void {
  if (!cleanupState.registered) {
    cleanupState.registered = true;
    process.on("exit", releaseAllLocksSync);
  }

  for (const signal of CLEANUP_SIGNALS) {
    if (cleanupState.cleanupHandlers.has(signal)) {
      continue;
    }

    try {
      const handler = () => handleTerminationSignal(signal);
      cleanupState.cleanupHandlers.set(signal, handler);
      process.on(signal, handler);
    } catch {
      // Ignore unsupported signals on this platform.
    }
  }
}

function unregisterCleanupHandlers(): void {
  if (cleanupState.registered) {
    process.off("exit", releaseAllLocksSync);
  }

  for (const [signal, handler] of cleanupState.cleanupHandlers) {
    process.off(signal, handler);
  }

  cleanupState = {
    registered: false,
    cleanupHandlers: new Map(),
  };
}

export async function acquireTaskStoreWriteLock(params: {
  lockPath: string;
  timeoutMs?: number;
  staleMs?: number;
  maxHoldMs?: number;
}): Promise<TaskStoreWriteLock> {
  registerCleanupHandlers();

  const timeoutMs = resolvePositiveMs(params.timeoutMs, DEFAULT_TIMEOUT_MS);
  const staleMs = resolvePositiveMs(params.staleMs, DEFAULT_STALE_MS);
  const requestedLockPath = path.resolve(params.lockPath);
  const lockDir = path.dirname(requestedLockPath);

  await fs.mkdir(lockDir, { recursive: true });

  let normalizedDir = lockDir;
  try {
    normalizedDir = await fs.realpath(lockDir);
  } catch {
    // Fall back to the resolved directory path.
  }

  const normalizedLockPath = path.join(normalizedDir, path.basename(requestedLockPath));
  const held = HELD_LOCKS.get(normalizedLockPath);

  if (held) {
    if (held.releasePromise) {
      await held.releasePromise.catch(() => undefined);
      return acquireTaskStoreWriteLock(params);
    }

    held.count += 1;
    return {
      release: async () => {
        await releaseHeldLock(normalizedLockPath, held);
      },
    };
  }

  const acquiredAt = Date.now();
  let attempt = 0;

  while (Date.now() - acquiredAt < timeoutMs) {
    attempt += 1;

    let handle: fs.FileHandle | null = null;

    try {
      handle = await fs.open(normalizedLockPath, "wx");
      const payload: TaskStoreWriteLockPayload = {
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      const starttime = getProcessStartTime(process.pid);

      if (starttime !== null) {
        payload.starttime = starttime;
      }

      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");

      const createdLock: HeldTaskStoreWriteLock = {
        count: 1,
        handle,
        lockPath: normalizedLockPath,
      };
      HELD_LOCKS.set(normalizedLockPath, createdLock);

      return {
        release: async () => {
          await releaseHeldLock(normalizedLockPath, createdLock);
        },
      };
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Best effort cleanup for partial acquisitions.
        }

        try {
          await fs.rm(normalizedLockPath, { force: true });
        } catch {
          // Best effort cleanup for partial acquisitions.
        }
      }

      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const payload = await readLockPayload(normalizedLockPath);
      const nowMs = Date.now();
      const inspection = inspectLockPayload(payload, staleMs, nowMs);

      if (await shouldReclaimLock(normalizedLockPath, inspection, staleMs, nowMs)) {
        await fs.rm(normalizedLockPath, { force: true });
        continue;
      }

      const delayMs = Math.min(1_000, 50 * attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const payload = await readLockPayload(normalizedLockPath);
  const owner = isPositiveInteger(payload?.pid) ? ` pid=${payload.pid}` : "";
  throw new Error(
    `Task store writer lock timed out after ${timeoutMs}ms:${owner} ${normalizedLockPath}`,
  );
}

export async function drainTaskStoreWriteLockStateForTest(): Promise<void> {
  for (const [normalizedLockPath, held] of Array.from(HELD_LOCKS.entries())) {
    await releaseHeldLock(normalizedLockPath, held).catch(() => undefined);
  }

  unregisterCleanupHandlers();
}

export function resetTaskStoreWriteLockStateForTest(): void {
  releaseAllLocksSync();
  unregisterCleanupHandlers();
}
