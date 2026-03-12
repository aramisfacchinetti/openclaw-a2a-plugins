import test from "node:test";
import assert from "node:assert/strict";
import {
  sendSuccess,
  statusSuccess,
  streamUpdate,
} from "../dist/result-shape.js";
import type { ResolvedTarget } from "../dist/sdk-client-pool.js";

function target(): ResolvedTarget {
  return {
    alias: "support",
    baseUrl: "https://support.example/",
    cardPath: "/.well-known/agent-card.json",
    preferredTransports: ["JSONRPC", "HTTP+JSON"],
  };
}

test("sendSuccess exposes context_id for raw messages and fallback task context", () => {
  const result = sendSuccess(
    target(),
    {
      kind: "message",
      messageId: "message-1",
      role: "agent",
      contextId: "context-1",
      parts: [{ kind: "text", text: "continued" }],
    },
    {
      taskId: "task-1",
      taskHandle: "rah_123",
    },
  );

  assert.equal(result.summary.task_id, "task-1");
  assert.equal(result.summary.task_handle, "rah_123");
  assert.equal(result.summary.context_id, "context-1");
});

test("statusSuccess exposes context_id for raw tasks", () => {
  const result = statusSuccess(
    target(),
    {
      kind: "task",
      id: "task-1",
      contextId: "context-1",
      status: {
        state: "completed",
      },
    },
    {
      taskHandle: "rah_123",
    },
  );

  assert.equal(result.summary.task_id, "task-1");
  assert.equal(result.summary.task_handle, "rah_123");
  assert.equal(result.summary.context_id, "context-1");
});

test("streamUpdate exposes context_id for status and artifact events", () => {
  const status = streamUpdate("watch", target(), {
    kind: "status-update",
    taskId: "task-1",
    contextId: "context-1",
    status: {
      state: "working",
    },
    final: false,
  });
  const artifact = streamUpdate("watch", target(), {
    kind: "artifact-update",
    taskId: "task-1",
    contextId: "context-1",
    artifact: {
      artifactId: "artifact-1",
      parts: [{ kind: "text", text: "partial" }],
    },
    append: false,
    lastChunk: false,
  });

  assert.equal(status.summary.context_id, "context-1");
  assert.equal(artifact.summary.context_id, "context-1");
  assert.deepEqual(artifact.summary.artifacts?.[0]?.parts, [
    { kind: "text", text: "partial" },
  ]);
});
