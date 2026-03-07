import test from "node:test";
import assert from "node:assert/strict";
import {
  createTaskHandleRegistry,
} from "../dist/task-handle-registry.js";
import type { ResolvedTarget } from "../dist/sdk-client-pool.js";

function target(baseUrl = "https://peer.example/"): ResolvedTarget {
  return {
    baseUrl,
    cardPath: "/.well-known/agent-card.json",
    preferredTransports: ["JSONRPC", "HTTP+JSON"],
    alias: "peer",
  };
}

test("task handle registry creates and resolves handles", () => {
  let now = 1_000;
  const registry = createTaskHandleRegistry({
    ttlMs: 100,
    maxEntries: 4,
    now: () => now,
  });

  const created = registry.create({
    target: target(),
    taskId: "task-1",
  });

  now = 1_020;
  const resolved = registry.resolve(created.taskHandle);

  assert.match(created.taskHandle, /^rah_/);
  assert.equal(created.createdAt, 1_000);
  assert.equal(created.lastAccessedAt, 1_000);
  assert.equal(created.expiresAt, 1_100);
  assert.equal(resolved.taskHandle, created.taskHandle);
  assert.equal(resolved.taskId, "task-1");
  assert.equal(resolved.lastAccessedAt, 1_020);
  assert.equal(resolved.expiresAt, 1_100);
});

test("task handle registry refresh extends the expiry window", () => {
  let now = 2_000;
  const registry = createTaskHandleRegistry({
    ttlMs: 100,
    maxEntries: 4,
    now: () => now,
  });

  const created = registry.create({
    target: target(),
    taskId: "task-2",
  });

  now = 2_050;
  const refreshed = registry.refresh(created.taskHandle, {
    taskId: "task-2",
  });

  assert.equal(refreshed.taskHandle, created.taskHandle);
  assert.equal(refreshed.createdAt, 2_000);
  assert.equal(refreshed.lastAccessedAt, 2_050);
  assert.equal(refreshed.expiresAt, 2_150);
});

test("task handle registry rejects expired handles", () => {
  let now = 3_000;
  const registry = createTaskHandleRegistry({
    ttlMs: 100,
    maxEntries: 4,
    now: () => now,
  });

  const created = registry.create({
    target: target(),
    taskId: "task-3",
  });

  now = 3_100;

  assert.throws(
    () => registry.resolve(created.taskHandle),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EXPIRED_TASK_HANDLE" &&
      "details" in error &&
      typeof error.details === "object" &&
      error.details !== null &&
      "taskHandle" in error.details &&
      error.details.taskHandle === created.taskHandle,
  );
});

test("task handle registry rejects unknown handles", () => {
  const registry = createTaskHandleRegistry({
    ttlMs: 100,
    maxEntries: 4,
  });

  assert.throws(
    () => registry.resolve("rah_missing"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "UNKNOWN_TASK_HANDLE" &&
      "details" in error &&
      typeof error.details === "object" &&
      error.details !== null &&
      "retryHint" in error.details,
  );
});

test("task handle registry evicts the least recently used live handle", () => {
  let now = 4_000;
  const registry = createTaskHandleRegistry({
    ttlMs: 500,
    maxEntries: 2,
    now: () => now,
  });

  const first = registry.create({
    target: target("https://one.example/"),
    taskId: "task-1",
  });
  now = 4_010;
  const second = registry.create({
    target: target("https://two.example/"),
    taskId: "task-2",
  });

  now = 4_020;
  registry.resolve(first.taskHandle);

  now = 4_030;
  const third = registry.create({
    target: target("https://three.example/"),
    taskId: "task-3",
  });

  assert.equal(registry.resolve(first.taskHandle).taskId, "task-1");
  assert.equal(registry.resolve(third.taskHandle).taskId, "task-3");
  assert.throws(
    () => registry.resolve(second.taskHandle),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "UNKNOWN_TASK_HANDLE",
  );
});
