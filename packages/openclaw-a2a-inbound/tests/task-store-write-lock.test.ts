import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTaskStoreWriteLock,
  drainTaskStoreWriteLockStateForTest,
  resetTaskStoreWriteLockStateForTest,
} from "../dist/task-store-write-lock.js";

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "a2a-inbound-task-store-write-lock-"));

  try {
    resetTaskStoreWriteLockStateForTest();
    await run(root);
  } finally {
    await drainTaskStoreWriteLockStateForTest();
    await rm(root, { recursive: true, force: true });
  }
}

test("acquires a new task-store lock and removes it on release", async () => {
  await withTempDir(async (root) => {
    const lockPath = join(root, ".writer.lock");
    const lock = await acquireTaskStoreWriteLock({ lockPath });

    const raw = await readFile(lockPath, "utf8");
    const payload = JSON.parse(raw) as {
      pid?: number;
      createdAt?: string;
      starttime?: number;
    };

    assert.equal(payload.pid, process.pid);
    assert.equal(typeof payload.createdAt, "string");
    assert.ok(payload.createdAt);

    await lock.release();

    await assert.rejects(stat(lockPath), { code: "ENOENT" });
  });
});

test("reclaims a stale lock owned by a dead pid", async () => {
  await withTempDir(async (root) => {
    const lockPath = join(root, ".writer.lock");

    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999_999_999,
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const lock = await acquireTaskStoreWriteLock({ lockPath, timeoutMs: 200 });
    const payload = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };

    assert.equal(payload.pid, process.pid);
    await lock.release();
  });
});

test("reclaims a stale lock when the pid was recycled", async () => {
  if (process.platform !== "linux") {
    return;
  }

  await withTempDir(async (root) => {
    const lockPath = join(root, ".writer.lock");
    const currentStarttime = await (async () => {
      const lock = await acquireTaskStoreWriteLock({ lockPath });
      const payload = JSON.parse(await readFile(lockPath, "utf8")) as { starttime?: number };
      await lock.release();
      return payload.starttime;
    })();

    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        starttime:
          typeof currentStarttime === "number" ? currentStarttime + 1 : 1,
      }),
      "utf8",
    );

    const lock = await acquireTaskStoreWriteLock({ lockPath, timeoutMs: 200 });
    const payload = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };

    assert.equal(payload.pid, process.pid);
    await lock.release();
  });
});

test("reclaims orphan lock files without starttime when PID matches current process", async () => {
  await withTempDir(async (root) => {
    const lockPath = join(root, ".writer.lock");

    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const lock = await acquireTaskStoreWriteLock({ lockPath, timeoutMs: 200 });
    const payload = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };

    assert.equal(payload.pid, process.pid);
    await lock.release();
  });
});

test("reclaims a malformed lock only after the mtime-based stale fallback", async () => {
  await withTempDir(async (root) => {
    const lockPath = join(root, ".writer.lock");

    await writeFile(lockPath, "{not-json", "utf8");
    const staleAt = new Date(Date.now() - 5_000);
    await utimes(lockPath, staleAt, staleAt);

    const lock = await acquireTaskStoreWriteLock({
      lockPath,
      staleMs: 1_000,
      timeoutMs: 200,
    });
    const payload = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };

    assert.equal(payload.pid, process.pid);
    await lock.release();
  });
});

test("does not reclaim an active live lock", async () => {
  await withTempDir(async (root) => {
    const lockPath = join(root, ".writer.lock");

    const probe = await acquireTaskStoreWriteLock({ lockPath });
    const currentPayload = JSON.parse(await readFile(lockPath, "utf8")) as {
      createdAt?: string;
      starttime?: number;
    };
    await probe.release();

    if (typeof currentPayload.starttime !== "number") {
      return;
    }

    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: currentPayload.createdAt ?? new Date().toISOString(),
        starttime: currentPayload.starttime,
      }),
      "utf8",
    );

    await assert.rejects(
      acquireTaskStoreWriteLock({
        lockPath,
        timeoutMs: 100,
        staleMs: 60_000,
      }),
      /timed out/,
    );
  });
});
