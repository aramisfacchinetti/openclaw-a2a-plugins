import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import type { A2AInboundTaskStoreConfig } from "./config.js";
import {
  classifyTaskState,
  createTaskStatusUpdate,
  isActiveExecutionTaskState,
} from "./response-mapping.js";

type JsonRecord = Record<string, unknown>;
type JournalEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
type TaskRuntimeLeaseState = "active" | "released";

export const TASK_HEARTBEAT_INTERVAL_MS = 5_000;
export const TASK_LEASE_TTL_MS = 20_000;
export const INTERRUPTED_TASK_FAILURE_TEXT =
  "Task execution was interrupted by process loss before completion.";

export interface TaskExecutionLease {
  ownerId?: string;
  runId?: string;
  state: TaskRuntimeLeaseState;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  releasedAt?: string;
}

export interface StoredTaskRuntime {
  currentSequence: number;
  lease?: TaskExecutionLease;
}

export interface TaskEventProvenance {
  runId?: string;
  agentEventSeq?: number;
  agentEventTs?: number;
}

export interface StoredTaskJournalRecord {
  sequence: number;
  committedAt: string;
  event: JournalEvent;
  provenance: TaskEventProvenance;
}

export interface TaskJournalSubscriptionHandle {
  next(): Promise<StoredTaskJournalRecord | undefined>;
  close(): void;
}

type TaskRuntimeSubscriber = (record: StoredTaskJournalRecord) => void;

type PreparedLiveTail = {
  subscription?: TaskJournalSubscriptionHandle;
  task: Task;
};

type PreparedReplayTail = {
  subscription?: TaskJournalSubscriptionHandle;
  task: Task;
  events: StoredTaskJournalRecord[];
};

type MaterializedTaskState = {
  task: Task;
  currentSequence: number;
  runtime: StoredTaskRuntime;
};

interface TaskRuntimeStorage {
  readonly kind: A2AInboundTaskStoreConfig["kind"];
  close(): void;
  listTaskIds(): Promise<string[]>;
  readSnapshot(taskId: string): Promise<Task | undefined>;
  writeSnapshot(taskId: string, task: Task): Promise<void>;
  readRuntime(taskId: string): Promise<StoredTaskRuntime | undefined>;
  writeRuntime(taskId: string, runtime: StoredTaskRuntime): Promise<void>;
  readEventsAfter(
    taskId: string,
    afterSequence: number,
  ): Promise<StoredTaskJournalRecord[]>;
  appendEvent(taskId: string, record: StoredTaskJournalRecord): Promise<void>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneTask(task: Task): Task {
  return structuredClone(task);
}

function cloneMessage(message: Message): Message {
  return structuredClone(message);
}

function cloneJournalEvent(event: JournalEvent): JournalEvent {
  return structuredClone(event);
}

function cloneJournalRecord(record: StoredTaskJournalRecord): StoredTaskJournalRecord {
  return structuredClone(record);
}

function toIsoString(value: Date | number | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  return new Date(value).toISOString();
}

function encodeTaskId(taskId: string): string {
  return Buffer.from(taskId, "utf8").toString("base64url");
}

function decodeTaskId(encodedTaskId: string): string | undefined {
  try {
    return Buffer.from(encodedTaskId, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function normalizeCurrentSequence(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : 0;
}

function normalizeLease(value: unknown): TaskExecutionLease | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const state = value.state === "active" ? "active" : value.state === "released" ? "released" : undefined;

  if (!state) {
    return undefined;
  }

  return {
    state,
    ...(typeof value.ownerId === "string" ? { ownerId: value.ownerId } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.heartbeatAt === "string"
      ? { heartbeatAt: value.heartbeatAt }
      : {}),
    ...(typeof value.leaseExpiresAt === "string"
      ? { leaseExpiresAt: value.leaseExpiresAt }
      : {}),
    ...(typeof value.releasedAt === "string"
      ? { releasedAt: value.releasedAt }
      : {}),
  };
}

function normalizeRuntimeRecord(value: unknown): StoredTaskRuntime {
  const record = isRecord(value) ? value : {};
  return {
    currentSequence: normalizeCurrentSequence(record.currentSequence),
    ...(normalizeLease(record.lease) ? { lease: normalizeLease(record.lease) } : {}),
  };
}

function readEventProvenance(
  event: Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): TaskEventProvenance {
  const openclaw = extractOpenClawMetadata(event.metadata);

  return {
    ...(typeof openclaw.runId === "string" ? { runId: openclaw.runId } : {}),
    ...(typeof openclaw.agentEventSeq === "number" &&
    Number.isInteger(openclaw.agentEventSeq)
      ? { agentEventSeq: openclaw.agentEventSeq }
      : {}),
    ...(typeof openclaw.agentEventTs === "number" &&
    Number.isFinite(openclaw.agentEventTs)
      ? { agentEventTs: openclaw.agentEventTs }
      : {}),
  };
}

function extractOpenClawMetadata(metadata: unknown): JsonRecord {
  if (!isRecord(metadata)) {
    return {};
  }

  const openclaw = metadata.openclaw;
  return isRecord(openclaw) ? openclaw : {};
}

function mergeMetadata(
  metadata: JsonRecord | undefined,
  patch: JsonRecord,
): JsonRecord {
  const nextMetadata = metadata ? structuredClone(metadata) : {};
  const nextOpenclaw = extractOpenClawMetadata(nextMetadata);

  nextMetadata.openclaw = {
    ...nextOpenclaw,
    ...patch,
  };

  return nextMetadata;
}

function withCurrentSequence(task: Task, sequence: number): Task {
  const nextTask = cloneTask(task);
  nextTask.metadata = mergeMetadata(nextTask.metadata as JsonRecord | undefined, {
    currentSequence: sequence,
  });
  return nextTask;
}

function withTaskRunId(task: Task, runId: string | undefined): Task {
  if (!runId || runId.trim().length === 0) {
    return task;
  }

  const nextTask = cloneTask(task);
  nextTask.metadata = mergeMetadata(nextTask.metadata as JsonRecord | undefined, {
    runId,
  });
  return nextTask;
}

function decorateJournalEvent<T extends JournalEvent>(
  event: T,
  sequence: number,
): T {
  const nextEvent = cloneJournalEvent(event);
  nextEvent.metadata = mergeMetadata(nextEvent.metadata as JsonRecord | undefined, {
    sequence,
  });
  return nextEvent as T;
}

function markEventAsReplayed<T extends JournalEvent>(event: T): T {
  const nextEvent = cloneJournalEvent(event);
  nextEvent.metadata = mergeMetadata(nextEvent.metadata as JsonRecord | undefined, {
    replayed: true,
  });
  return nextEvent as T;
}

function mergeArtifact(
  task: Task,
  event: TaskArtifactUpdateEvent,
): Task {
  const nextTask = cloneTask(task);
  const nextArtifact = structuredClone(event.artifact);

  if (!nextTask.artifacts) {
    nextTask.artifacts = [];
  }

  const existingArtifactIndex = nextTask.artifacts.findIndex(
    (artifact) => artifact.artifactId === nextArtifact.artifactId,
  );

  if (existingArtifactIndex === -1) {
    nextTask.artifacts.push(nextArtifact);
    return nextTask;
  }

  if (!event.append) {
    nextTask.artifacts[existingArtifactIndex] = nextArtifact;
    return nextTask;
  }

  const existingArtifact = nextTask.artifacts[existingArtifactIndex];
  existingArtifact.parts.push(...nextArtifact.parts);

  if (nextArtifact.name) {
    existingArtifact.name = nextArtifact.name;
  }

  if (nextArtifact.description) {
    existingArtifact.description = nextArtifact.description;
  }

  if (nextArtifact.metadata) {
    existingArtifact.metadata = {
      ...existingArtifact.metadata,
      ...nextArtifact.metadata,
    };
  }

  return nextTask;
}

function mergeStatus(task: Task, event: TaskStatusUpdateEvent): Task {
  const nextTask = cloneTask(task);
  nextTask.status = structuredClone(event.status);

  if (!event.status.message) {
    return nextTask;
  }

  const statusMessageId = event.status.message.messageId;
  const history = nextTask.history ? [...nextTask.history] : [];

  if (!history.some((entry) => entry.messageId === statusMessageId)) {
    history.push(structuredClone(event.status.message));
    nextTask.history = history;
  }

  return nextTask;
}

function foldTaskJournalOntoSnapshot(
  snapshot: Task,
  records: readonly StoredTaskJournalRecord[],
): {
  task: Task;
  currentSequence: number;
} {
  let currentSequence = readTaskCurrentSequence(snapshot);
  let nextTask = withCurrentSequence(snapshot, currentSequence);

  for (const record of [...records].sort((left, right) => left.sequence - right.sequence)) {
    if (record.sequence <= currentSequence) {
      continue;
    }

    nextTask =
      record.event.kind === "status-update"
        ? mergeStatus(nextTask, record.event)
        : mergeArtifact(nextTask, record.event);
    nextTask = withTaskRunId(nextTask, record.provenance.runId);
    currentSequence = record.sequence;
  }

  return {
    task: withCurrentSequence(nextTask, currentSequence),
    currentSequence,
  };
}

function readLeaseExpiry(lease: TaskExecutionLease | undefined): number | undefined {
  if (!lease?.leaseExpiresAt) {
    return undefined;
  }

  const expiresAt = Date.parse(lease.leaseExpiresAt);
  return Number.isFinite(expiresAt) ? expiresAt : undefined;
}

function hasExpiredOrMissingLease(
  runtime: StoredTaskRuntime | undefined,
  nowMs: number,
): boolean {
  const lease = runtime?.lease;

  if (!lease || lease.state !== "active") {
    return true;
  }

  const expiresAt = readLeaseExpiry(lease);
  return typeof expiresAt !== "number" || expiresAt <= nowMs;
}

function createLease(
  currentSequence: number,
  params: {
    ownerId: string;
    nowIso: string;
    runId?: string;
  },
): StoredTaskRuntime {
  return {
    currentSequence,
    lease: {
      ownerId: params.ownerId,
      state: "active",
      heartbeatAt: params.nowIso,
      leaseExpiresAt: new Date(
        Date.parse(params.nowIso) + TASK_LEASE_TTL_MS,
      ).toISOString(),
      ...(params.runId ? { runId: params.runId } : {}),
    },
  };
}

function releaseLease(
  runtime: StoredTaskRuntime,
  params: {
    nowIso: string;
    ownerId?: string;
    runId?: string;
  },
): StoredTaskRuntime {
  const previousLease = runtime.lease;

  return {
    currentSequence: runtime.currentSequence,
    lease: {
      state: "released",
      heartbeatAt: params.nowIso,
      leaseExpiresAt: params.nowIso,
      releasedAt: params.nowIso,
      ...(params.ownerId ?? previousLease?.ownerId
        ? { ownerId: params.ownerId ?? previousLease?.ownerId }
        : {}),
      ...(params.runId ?? previousLease?.runId
        ? { runId: params.runId ?? previousLease?.runId }
        : {}),
    },
  };
}

function ensureHistoryContainsMessage(task: Task, message: Message): Task {
  const nextTask = cloneTask(task);
  const history = nextTask.history ? [...nextTask.history] : [];

  if (!history.some((entry) => entry.messageId === message.messageId)) {
    history.push(cloneMessage(message));
    nextTask.history = history;
  }

  return nextTask;
}

function isJournalEvent(
  event: Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): event is JournalEvent {
  return event.kind === "status-update" || event.kind === "artifact-update";
}

function maybeReadJsonFileSync<T>(filePath: string): T | undefined {
  try {
    const raw = readFileSync(filePath, "utf8");

    if (raw.trim().length === 0) {
      return undefined;
    }

    return JSON.parse(raw) as T;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function maybeReadJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");

    if (raw.trim().length === 0) {
      return undefined;
    }

    return JSON.parse(raw) as T;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function readNdjsonFileSync<T>(filePath: string): T[] {
  try {
    const raw = readFileSync(filePath, "utf8");

    if (raw.trim().length === 0) {
      return [];
    }

    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

    if (code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readNdjsonFile<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, "utf8");

    if (raw.trim().length === 0) {
      return [];
    }

    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

    if (code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function writeJsonFileAtomicallySync(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2));
  renameSync(tempPath, filePath);
}

async function writeJsonFileAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2));
  await rename(tempPath, filePath);
}

class MemoryTaskRuntimeStorage implements TaskRuntimeStorage {
  readonly kind = "memory" as const;

  private readonly snapshots = new Map<string, Task>();
  private readonly runtimes = new Map<string, StoredTaskRuntime>();
  private readonly journals = new Map<string, StoredTaskJournalRecord[]>();

  close(): void {}

  async listTaskIds(): Promise<string[]> {
    return [...this.snapshots.keys()];
  }

  async readSnapshot(taskId: string): Promise<Task | undefined> {
    const snapshot = this.snapshots.get(taskId);
    return snapshot ? cloneTask(snapshot) : undefined;
  }

  async writeSnapshot(taskId: string, task: Task): Promise<void> {
    this.snapshots.set(taskId, cloneTask(task));
  }

  async readRuntime(taskId: string): Promise<StoredTaskRuntime | undefined> {
    const runtime = this.runtimes.get(taskId);
    return runtime ? structuredClone(runtime) : undefined;
  }

  async writeRuntime(taskId: string, runtime: StoredTaskRuntime): Promise<void> {
    this.runtimes.set(taskId, structuredClone(runtime));
  }

  async readEventsAfter(
    taskId: string,
    afterSequence: number,
  ): Promise<StoredTaskJournalRecord[]> {
    const records = this.journals.get(taskId) ?? [];
    return records
      .filter((record) => record.sequence > afterSequence)
      .map((record) => cloneJournalRecord(record));
  }

  async appendEvent(
    taskId: string,
    record: StoredTaskJournalRecord,
  ): Promise<void> {
    const existing = this.journals.get(taskId) ?? [];
    existing.push(cloneJournalRecord(record));
    this.journals.set(taskId, existing);
  }
}

class JsonFileTaskRuntimeStorage implements TaskRuntimeStorage {
  readonly kind = "json-file" as const;

  private readonly rootPath: string;
  private readonly taskRootPath: string;
  private readonly lockFilePath: string;

  constructor(
    rootPath: string,
    private readonly instanceId: string,
  ) {
    this.rootPath = rootPath;
    this.taskRootPath = join(rootPath, "tasks");
    this.lockFilePath = join(rootPath, "writer.lock.json");

    this.ensureRootDirectory();
    this.acquireWriterLock();
    this.runStartupSweep();
  }

  close(): void {
    try {
      const existing = maybeReadJsonFileSync<{ instanceId?: string }>(
        this.lockFilePath,
      );

      if (existing?.instanceId === this.instanceId || !existing) {
        unlinkSync(this.lockFilePath);
      }
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  async listTaskIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.taskRootPath, { withFileTypes: true });
      return entries.flatMap((entry) => {
        if (!entry.isDirectory()) {
          return [];
        }

        const taskId = decodeTaskId(entry.name);
        return taskId ? [taskId] : [];
      });
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async readSnapshot(taskId: string): Promise<Task | undefined> {
    const snapshot = await maybeReadJsonFile<Task>(this.snapshotPath(taskId));
    return snapshot ? cloneTask(snapshot) : undefined;
  }

  async writeSnapshot(taskId: string, task: Task): Promise<void> {
    await writeJsonFileAtomically(this.snapshotPath(taskId), task);
  }

  async readRuntime(taskId: string): Promise<StoredTaskRuntime | undefined> {
    const runtime = await maybeReadJsonFile<StoredTaskRuntime>(
      this.runtimePath(taskId),
    );
    return runtime ? normalizeRuntimeRecord(runtime) : undefined;
  }

  async writeRuntime(taskId: string, runtime: StoredTaskRuntime): Promise<void> {
    await writeJsonFileAtomically(this.runtimePath(taskId), runtime);
  }

  async readEventsAfter(
    taskId: string,
    afterSequence: number,
  ): Promise<StoredTaskJournalRecord[]> {
    const records = await readNdjsonFile<StoredTaskJournalRecord>(
      this.eventsPath(taskId),
    );
    return records
      .map((record) => this.normalizeJournalRecord(record))
      .filter((record) => record.sequence > afterSequence);
  }

  async appendEvent(
    taskId: string,
    record: StoredTaskJournalRecord,
  ): Promise<void> {
    await mkdir(this.taskDirectory(taskId), { recursive: true });
    await appendFile(this.eventsPath(taskId), `${JSON.stringify(record)}\n`);
  }

  private ensureRootDirectory(): void {
    if (existsSync(this.rootPath)) {
      const rootStat = statSync(this.rootPath);

      if (!rootStat.isDirectory()) {
        throw new Error(
          `taskStore.path "${this.rootPath}" must point to a directory root for openclaw-a2a-inbound.`,
        );
      }
    }

    mkdirSync(this.rootPath, { recursive: true });
    mkdirSync(this.taskRootPath, { recursive: true });
  }

  private acquireWriterLock(): void {
    const lockPayload = {
      instanceId: this.instanceId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };

    try {
      const fd = openSync(this.lockFilePath, "wx");
      writeFileSync(fd, JSON.stringify(lockPayload, null, 2));
      closeSync(fd);
      return;
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code !== "EEXIST") {
        throw error;
      }
    }

    const existing = maybeReadJsonFileSync<{
      instanceId?: string;
      pid?: number;
    }>(this.lockFilePath);
    const pid =
      typeof existing?.pid === "number" && Number.isInteger(existing.pid)
        ? existing.pid
        : undefined;

    if (pid && this.isProcessAlive(pid)) {
      throw new Error(
        `taskStore.path "${this.rootPath}" is already owned by live process ${pid}.`,
      );
    }

    unlinkSync(this.lockFilePath);
    const fd = openSync(this.lockFilePath, "wx");
    writeFileSync(fd, JSON.stringify(lockPayload, null, 2));
    closeSync(fd);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      return code !== "ESRCH";
    }
  }

  private runStartupSweep(): void {
    const nowIso = new Date().toISOString();
    const nowMs = Date.parse(nowIso);

    for (const entry of this.listTaskDirectoryNamesSync()) {
      try {
        const taskId = decodeTaskId(entry);

        if (!taskId) {
          continue;
        }

        const materialized = this.materializeTaskSync(taskId);

        if (
          !materialized ||
          !isActiveExecutionTaskState(materialized.task.status.state)
        ) {
          continue;
        }

        const runtime = normalizeRuntimeRecord(
          maybeReadJsonFileSync<StoredTaskRuntime>(this.runtimePath(taskId)),
        );

        if (!hasExpiredOrMissingLease(runtime, nowMs)) {
          continue;
        }

        const nextSequence = materialized.currentSequence + 1;
        const failureEvent = decorateJournalEvent(
          createTaskStatusUpdate({
            taskId: materialized.task.id,
            contextId: materialized.task.contextId,
            state: "failed",
            final: true,
            messageText: INTERRUPTED_TASK_FAILURE_TEXT,
            timestamp: nowIso,
          }),
          nextSequence,
        );
        const nextSnapshot = withCurrentSequence(
          mergeStatus(materialized.task, failureEvent),
          nextSequence,
        );
        const nextRuntime = releaseLease(
          {
            currentSequence: nextSequence,
            lease: runtime.lease,
          },
          {
            nowIso,
            ownerId: runtime.lease?.ownerId,
            runId: runtime.lease?.runId,
          },
        );
        const journalRecord: StoredTaskJournalRecord = {
          sequence: nextSequence,
          committedAt: nowIso,
          event: failureEvent,
          provenance: {},
        };

        this.writeJournalRecordSync(taskId, journalRecord);
        writeJsonFileAtomicallySync(this.snapshotPath(taskId), nextSnapshot);
        writeJsonFileAtomicallySync(this.runtimePath(taskId), nextRuntime);
      } catch (error) {
        console.warn("Failed to reconcile orphaned task during startup sweep.", error);
      }
    }
  }

  private listTaskDirectoryNamesSync(): string[] {
    try {
      return readdirSync(this.taskRootPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private normalizeJournalRecord(
    record: StoredTaskJournalRecord,
  ): StoredTaskJournalRecord {
    return {
      sequence: normalizeCurrentSequence(record.sequence),
      committedAt:
        typeof record.committedAt === "string"
          ? record.committedAt
          : new Date().toISOString(),
      event: cloneJournalEvent(record.event),
      provenance: {
        ...(typeof record.provenance?.runId === "string"
          ? { runId: record.provenance.runId }
          : {}),
        ...(typeof record.provenance?.agentEventSeq === "number" &&
        Number.isInteger(record.provenance.agentEventSeq)
          ? { agentEventSeq: record.provenance.agentEventSeq }
          : {}),
        ...(typeof record.provenance?.agentEventTs === "number" &&
        Number.isFinite(record.provenance.agentEventTs)
          ? { agentEventTs: record.provenance.agentEventTs }
          : {}),
      },
    };
  }

  private materializeTaskSync(taskId: string): {
    task: Task;
    currentSequence: number;
  } | undefined {
    const snapshot = maybeReadJsonFileSync<Task>(this.snapshotPath(taskId));

    if (!snapshot) {
      return undefined;
    }

    const tail = readNdjsonFileSync<StoredTaskJournalRecord>(this.eventsPath(taskId))
      .map((record) => this.normalizeJournalRecord(record))
      .filter((record) => record.sequence > readTaskCurrentSequence(snapshot));

    return foldTaskJournalOntoSnapshot(snapshot, tail);
  }

  private writeJournalRecordSync(
    taskId: string,
    record: StoredTaskJournalRecord,
  ): void {
    mkdirSync(this.taskDirectory(taskId), { recursive: true });
    writeFileSync(this.eventsPath(taskId), `${JSON.stringify(record)}\n`, {
      flag: "a",
    });
  }

  private taskDirectory(taskId: string): string {
    return join(this.taskRootPath, encodeTaskId(taskId));
  }

  private snapshotPath(taskId: string): string {
    return join(this.taskDirectory(taskId), "snapshot.json");
  }

  private eventsPath(taskId: string): string {
    return join(this.taskDirectory(taskId), "events.ndjson");
  }

  private runtimePath(taskId: string): string {
    return join(this.taskDirectory(taskId), "runtime.json");
  }
}

class TaskJournalSubscription implements TaskJournalSubscriptionHandle {
  private readonly records: StoredTaskJournalRecord[] = [];
  private readonly waiters = new Set<(record: StoredTaskJournalRecord | undefined) => void>();
  private closed = false;

  constructor(
    private readonly unsubscribe: () => void,
    private readonly afterSequence: number,
  ) {}

  push(record: StoredTaskJournalRecord): void {
    if (this.closed || record.sequence <= this.afterSequence) {
      return;
    }

    const waiter = this.waiters.values().next().value as
      | ((record: StoredTaskJournalRecord | undefined) => void)
      | undefined;

    if (waiter) {
      this.waiters.delete(waiter);
      waiter(cloneJournalRecord(record));
      return;
    }

    this.records.push(cloneJournalRecord(record));
  }

  async next(): Promise<StoredTaskJournalRecord | undefined> {
    if (this.records.length > 0) {
      return this.records.shift();
    }

    if (this.closed) {
      return undefined;
    }

    return new Promise((resolve) => {
      this.waiters.add(resolve);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.unsubscribe();

    for (const waiter of this.waiters) {
      waiter(undefined);
    }

    this.waiters.clear();
    this.records.length = 0;
  }
}

export class A2ATaskRuntimeStore implements TaskStore {
  readonly instanceId = randomUUID();
  readonly kind: A2AInboundTaskStoreConfig["kind"];

  private readonly storage: TaskRuntimeStorage;
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly subscribers = new Map<string, Set<TaskRuntimeSubscriber>>();
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(config: A2AInboundTaskStoreConfig) {
    if (config.kind === "json-file") {
      if (!config.path) {
        throw new Error(
          "taskStore.kind=json-file requires taskStore.path for openclaw-a2a-inbound",
        );
      }

      this.storage = new JsonFileTaskRuntimeStorage(config.path, this.instanceId);
      this.kind = "json-file";
      return;
    }

    this.storage = new MemoryTaskRuntimeStorage();
    this.kind = "memory";
  }

  close(): void {
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }

    this.heartbeatTimers.clear();
    this.subscribers.clear();
    this.storage.close();
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    return this.enqueueByTask(taskId, async () => {
      return (await this.readMaterializedTask(taskId))?.task;
    });
  }

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    await this.enqueueByTask(task.id, async () => {
      const materialized = await this.readMaterializedTask(task.id);
      const runtime =
        materialized?.runtime ??
        normalizeRuntimeRecord(await this.storage.readRuntime(task.id));
      const currentSequence = Math.max(
        materialized?.currentSequence ?? 0,
        readTaskCurrentSequence(task),
      );
      const nextTask = withCurrentSequence(task, currentSequence);
      await this.storage.writeSnapshot(task.id, nextTask);
      await this.storage.writeRuntime(task.id, {
        ...runtime,
        currentSequence,
      });
    });
  }

  async listTaskIds(): Promise<string[]> {
    return this.storage.listTaskIds();
  }

  async persistIncomingMessage(taskId: string, message: Message): Promise<Task | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const materialized = await this.readMaterializedTask(taskId);

      if (!materialized) {
        return undefined;
      }

      const nextSnapshot = withCurrentSequence(
        ensureHistoryContainsMessage(materialized.task, message),
        materialized.currentSequence,
      );

      await this.storage.writeSnapshot(taskId, nextSnapshot);
      await this.storage.writeRuntime(taskId, {
        ...materialized.runtime,
        currentSequence: materialized.currentSequence,
      });
      return nextSnapshot;
    });
  }

  async commitEvent(
    event: Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
    latestUserMessage?: Message,
  ): Promise<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    if (event.kind === "task") {
      return this.commitTaskSnapshot(event, latestUserMessage);
    }

    return this.commitJournalEvent(event);
  }

  async reconcileOrphanedTask(
    taskId: string,
    hasLiveInProcessOwner: boolean,
  ): Promise<Task | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const materialized = await this.readMaterializedTask(taskId);

      if (
        !materialized ||
        !isActiveExecutionTaskState(materialized.task.status.state) ||
        hasLiveInProcessOwner
      ) {
        return materialized?.task;
      }

      const nowIso = new Date().toISOString();

      if (!hasExpiredOrMissingLease(materialized.runtime, Date.parse(nowIso))) {
        return materialized.task;
      }

      const nextSequence = materialized.currentSequence + 1;
      const journalEvent = decorateJournalEvent(
        createTaskStatusUpdate({
          taskId: materialized.task.id,
          contextId: materialized.task.contextId,
          state: "failed",
          final: true,
          messageText: INTERRUPTED_TASK_FAILURE_TEXT,
          timestamp: nowIso,
        }),
        nextSequence,
      );
      const nextSnapshot = withCurrentSequence(
        mergeStatus(materialized.task, journalEvent),
        nextSequence,
      );
      const nextRuntime = releaseLease(
        {
          currentSequence: nextSequence,
          lease: materialized.runtime.lease,
        },
        {
          nowIso,
          ownerId: materialized.runtime.lease?.ownerId,
          runId: materialized.runtime.lease?.runId,
        },
      );
      const record: StoredTaskJournalRecord = {
        sequence: nextSequence,
        committedAt: nowIso,
        event: journalEvent,
        provenance: {},
      };

      await this.storage.appendEvent(taskId, record);
      await this.storage.writeSnapshot(taskId, nextSnapshot);
      await this.storage.writeRuntime(taskId, nextRuntime);
      this.stopHeartbeat(taskId);
      this.notifySubscribers(taskId, record);
      return nextSnapshot;
    });
  }

  async prepareLiveTail(taskId: string): Promise<PreparedLiveTail | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const materialized = await this.readMaterializedTask(taskId);

      if (!materialized) {
        return undefined;
      }

      const subscription = isActiveExecutionTaskState(materialized.task.status.state)
        ? this.createSubscription(taskId, materialized.currentSequence)
        : undefined;

      return {
        task: materialized.task,
        subscription,
      };
    });
  }

  async prepareReplayTail(
    taskId: string,
    afterSequence: number,
  ): Promise<PreparedReplayTail | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const materialized = await this.readMaterializedTask(taskId);

      if (!materialized) {
        return undefined;
      }

      const events = await this.storage.readEventsAfter(taskId, afterSequence);
      const lastSequence = Math.max(
        afterSequence,
        materialized.currentSequence,
        events.at(-1)?.sequence ?? 0,
      );
      const subscription = isActiveExecutionTaskState(materialized.task.status.state)
        ? this.createSubscription(taskId, lastSequence)
        : undefined;

      return {
        task: materialized.task,
        events,
        subscription,
      };
    });
  }

  async renewLease(taskId: string, runId?: string): Promise<void> {
    await this.enqueueByTask(taskId, async () => {
      const materialized = await this.readMaterializedTask(taskId);

      if (
        !materialized ||
        !isActiveExecutionTaskState(materialized.task.status.state)
      ) {
        this.stopHeartbeat(taskId);
        return;
      }

      const nowIso = new Date().toISOString();
      const nextRuntime = createLease(materialized.currentSequence, {
        ownerId: this.instanceId,
        nowIso,
        ...(runId ?? materialized.runtime.lease?.runId
          ? { runId: runId ?? materialized.runtime.lease?.runId }
          : {}),
      });

      await this.storage.writeRuntime(taskId, nextRuntime);
    });
  }

  replayRecord(record: StoredTaskJournalRecord): JournalEvent {
    return markEventAsReplayed(record.event);
  }

  private async commitTaskSnapshot(
    task: Task,
    latestUserMessage?: Message,
  ): Promise<Task> {
    return this.enqueueByTask(task.id, async () => {
      const materialized = await this.readMaterializedTask(task.id);
      const currentRuntime =
        materialized?.runtime ??
        normalizeRuntimeRecord(await this.storage.readRuntime(task.id));
      const currentSequence = Math.max(
        materialized?.currentSequence ?? 0,
        readTaskCurrentSequence(task),
      );
      const runId = readEventProvenance(task).runId ?? currentRuntime.lease?.runId;
      const nowIso = new Date().toISOString();
      let nextTask = cloneTask(task);

      if (latestUserMessage) {
        nextTask = ensureHistoryContainsMessage(nextTask, latestUserMessage);
      }

      nextTask = withCurrentSequence(nextTask, currentSequence);
      nextTask = withTaskRunId(nextTask, runId);

      await this.storage.writeSnapshot(task.id, nextTask);
      const nextRuntime =
        classifyTaskState(nextTask.status.state) === "active"
          ? createLease(currentSequence, {
              ownerId: this.instanceId,
              nowIso,
              ...(runId ? { runId } : {}),
            })
          : releaseLease(
              {
                currentSequence,
                lease: currentRuntime.lease,
              },
              {
                nowIso,
                ownerId: this.instanceId,
                ...(runId ? { runId } : {}),
              },
            );
      await this.storage.writeRuntime(
        task.id,
        nextRuntime,
      );
      this.syncHeartbeat(task.id, nextTask.status.state);
      return nextTask;
    });
  }

  private async commitJournalEvent(event: JournalEvent): Promise<JournalEvent> {
    return this.enqueueByTask(event.taskId, async () => {
      const materialized = await this.readMaterializedTask(event.taskId);

      if (!materialized) {
        throw new Error(`Cannot commit journal event for unknown task ${event.taskId}.`);
      }

      const currentRuntime = materialized.runtime;
      const nextSequence = materialized.currentSequence + 1;
      const committedAt = new Date().toISOString();
      const decoratedEvent = decorateJournalEvent(event, nextSequence);
      const nextSnapshot =
        decoratedEvent.kind === "status-update"
          ? withCurrentSequence(
              mergeStatus(materialized.task, decoratedEvent),
              nextSequence,
            )
          : withCurrentSequence(
              mergeArtifact(materialized.task, decoratedEvent),
              nextSequence,
            );
      const provenance = readEventProvenance(event);
      const snapshotRunId = provenance.runId ?? currentRuntime.lease?.runId;
      const nextRuntime =
        classifyTaskState(nextSnapshot.status.state) === "active"
          ? createLease(nextSequence, {
              ownerId: this.instanceId,
              nowIso: committedAt,
              ...(provenance.runId ?? currentRuntime.lease?.runId
                ? { runId: provenance.runId ?? currentRuntime.lease?.runId }
                : {}),
            })
          : releaseLease(
              {
                currentSequence: nextSequence,
                lease: currentRuntime.lease,
              },
              {
                nowIso: committedAt,
                ownerId: this.instanceId,
                runId: provenance.runId ?? currentRuntime.lease?.runId,
              },
            );
      const record: StoredTaskJournalRecord = {
        sequence: nextSequence,
        committedAt,
        event: decoratedEvent,
        provenance,
      };

      await this.storage.appendEvent(event.taskId, record);
      await this.storage.writeSnapshot(
        event.taskId,
        withTaskRunId(nextSnapshot, snapshotRunId),
      );
      await this.storage.writeRuntime(event.taskId, nextRuntime);

      this.syncHeartbeat(event.taskId, nextSnapshot.status.state);
      this.notifySubscribers(event.taskId, record);
      return decoratedEvent;
    });
  }

  private async readMaterializedTask(
    taskId: string,
  ): Promise<MaterializedTaskState | undefined> {
    const snapshot = await this.storage.readSnapshot(taskId);

    if (!snapshot) {
      return undefined;
    }

    const runtime = normalizeRuntimeRecord(await this.storage.readRuntime(taskId));
    const { task, currentSequence } = foldTaskJournalOntoSnapshot(
      snapshot,
      await this.storage.readEventsAfter(taskId, readTaskCurrentSequence(snapshot)),
    );

    return {
      task: withTaskRunId(task, runtime.lease?.runId),
      currentSequence,
      runtime,
    };
  }

  private syncHeartbeat(taskId: string, state: Task["status"]["state"]): void {
    if (isActiveExecutionTaskState(state)) {
      this.startHeartbeat(taskId);
      return;
    }

    this.stopHeartbeat(taskId);
  }

  private enqueueByTask<T>(
    taskId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const guard = next.then(
      () => undefined,
      () => undefined,
    );

    this.taskQueues.set(taskId, guard);

    return next.finally(() => {
      if (this.taskQueues.get(taskId) === guard) {
        this.taskQueues.delete(taskId);
      }
    });
  }

  private createSubscription(
    taskId: string,
    afterSequence: number,
  ): TaskJournalSubscription {
    const listenerSet = this.subscribers.get(taskId) ?? new Set<TaskRuntimeSubscriber>();
    this.subscribers.set(taskId, listenerSet);

    const subscription = new TaskJournalSubscription(() => {
      listenerSet.delete(listener);

      if (listenerSet.size === 0) {
        this.subscribers.delete(taskId);
      }
    }, afterSequence);
    const listener: TaskRuntimeSubscriber = (record) => {
      subscription.push(record);
    };

    listenerSet.add(listener);
    return subscription;
  }

  private notifySubscribers(taskId: string, record: StoredTaskJournalRecord): void {
    const listeners = this.subscribers.get(taskId);

    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      listener(record);
    }
  }

  private startHeartbeat(taskId: string): void {
    if (this.heartbeatTimers.has(taskId)) {
      return;
    }

    const timer = setInterval(() => {
      void this.renewLease(taskId).catch(() => {
        // Lease renewal errors surface on later task access; avoid unhandled rejections.
      });
    }, TASK_HEARTBEAT_INTERVAL_MS);

    timer.unref?.();
    this.heartbeatTimers.set(taskId, timer);
  }

  private stopHeartbeat(taskId: string): void {
    const timer = this.heartbeatTimers.get(taskId);

    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.heartbeatTimers.delete(taskId);
  }
}

function readTaskCurrentSequence(task: Task): number {
  const openclaw = extractOpenClawMetadata(task.metadata);
  return normalizeCurrentSequence(openclaw.currentSequence);
}

export function createTaskStore(
  config: A2AInboundTaskStoreConfig,
): A2ATaskRuntimeStore {
  return new A2ATaskRuntimeStore(config);
}
