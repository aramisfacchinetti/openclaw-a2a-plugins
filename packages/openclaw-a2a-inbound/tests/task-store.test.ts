import test from "node:test";
import assert from "node:assert/strict";
import type { TaskState } from "@a2a-js/sdk";
import {
  createArtifactUpdate,
  createTaskSnapshot,
  createTaskStatusUpdate,
} from "../dist/response-mapping.js";
import {
  createTaskStore,
  type StoredTaskBinding,
} from "../dist/task-store.js";
import { createUserMessage } from "./runtime-harness.js";
import { getPersistedArtifactText } from "./test-helpers.js";

function createBinding(taskId: string): StoredTaskBinding {
  return {
    schemaVersion: 1,
    agentId: "main",
    channel: "a2a",
    accountId: "default",
    matchedBy: "default",
    sessionKey: `session:${taskId}`,
    mainSessionKey: `session:${taskId}`,
    storePath: `/tmp/${taskId}.json`,
    peer: {
      kind: "direct",
      id: `peer:${taskId}`,
      source: "task-id",
    },
    createdAt: "2026-03-11T00:00:00.000Z",
    updatedAt: "2026-03-11T00:00:00.000Z",
  };
}

function createSnapshot(params: {
  taskId: string;
  contextId?: string;
  state?: TaskState;
}) {
  return createTaskSnapshot({
    taskId: params.taskId,
    contextId: params.contextId ?? `context:${params.taskId}`,
    state: params.state ?? "submitted",
    history: [
      createUserMessage({
        messageId: `message:${params.taskId}:1`,
        contextId: params.contextId ?? `context:${params.taskId}`,
        taskId: params.taskId,
        parts: [{ kind: "text", text: `Request for ${params.taskId}` }],
      }),
    ],
  });
}

test("save, load, and listTaskIds expose the latest stored snapshots", async () => {
  const store = createTaskStore();

  await store.save(createSnapshot({ taskId: "task-1", state: "submitted" }));
  await store.save(
    createTaskSnapshot({
      taskId: "task-1",
      contextId: "context:task-1",
      state: "completed",
      history: [
        createUserMessage({
          messageId: "message:task-1:1",
          contextId: "context:task-1",
          taskId: "task-1",
        }),
        createUserMessage({
          messageId: "message:task-1:2",
          contextId: "context:task-1",
          taskId: "task-1",
          parts: [{ kind: "text", text: "Follow-up" }],
        }),
      ],
      messageText: "Done",
    }),
  );
  await store.save(createSnapshot({ taskId: "task-2", state: "working" }));

  const loadedTask = await store.load("task-1");

  assert.deepEqual(await store.listTaskIds(), ["task-1", "task-2"]);
  assert.equal(loadedTask?.status.state, "completed");
  assert.equal(loadedTask?.history?.at(-1)?.messageId, "message:task-1:2");
});

test("primed bindings flush on the first snapshot save and on later journal commits", async () => {
  const store = createTaskStore();
  const initialBinding = createBinding("task-1");
  const updatedBinding = {
    ...createBinding("task-2"),
    sessionKey: "session:task-2:updated",
    updatedAt: "2026-03-11T00:05:00.000Z",
  };

  store.primeBinding("task-1", initialBinding);
  await store.save(createSnapshot({ taskId: "task-1" }));

  await store.save(createSnapshot({ taskId: "task-2" }));
  store.primeBinding("task-2", updatedBinding);
  await store.commitEvent(
    createTaskStatusUpdate({
      taskId: "task-2",
      contextId: "context:task-2",
      state: "working",
    }),
  );

  assert.deepEqual(await store.loadBinding("task-1"), initialBinding);
  assert.deepEqual(await store.loadBinding("task-2"), updatedBinding);
});

test("persistIncomingMessage appends new history entries without duplicating messageIds", async () => {
  const store = createTaskStore();
  const original = createUserMessage({
    messageId: "message:task-1:1",
    contextId: "context:task-1",
    taskId: "task-1",
    parts: [{ kind: "text", text: "First request" }],
  });
  const followUp = createUserMessage({
    messageId: "message:task-1:2",
    contextId: "context:task-1",
    taskId: "task-1",
    parts: [{ kind: "text", text: "Second request" }],
  });

  await store.save(
    createTaskSnapshot({
      taskId: "task-1",
      contextId: "context:task-1",
      state: "working",
      history: [original],
    }),
  );

  const once = await store.persistIncomingMessage("task-1", followUp);
  const twice = await store.persistIncomingMessage("task-1", followUp);
  const persisted = await store.load("task-1");

  assert.equal(once?.history?.length, 2);
  assert.equal(twice?.history?.length, 2);
  assert.deepEqual(
    persisted?.history?.map((message) => message.messageId),
    ["message:task-1:1", "message:task-1:2"],
  );
});

test("status and artifact journal commits mutate the stored task snapshot", async () => {
  const store = createTaskStore();

  await store.save(createSnapshot({ taskId: "task-1", state: "submitted" }));
  await store.commitEvent(
    createTaskStatusUpdate({
      taskId: "task-1",
      contextId: "context:task-1",
      state: "working",
      messageText: "Working",
    }),
  );
  await store.commitEvent(
    createArtifactUpdate({
      taskId: "task-1",
      contextId: "context:task-1",
      artifactId: "assistant-output-0001",
      text: "Alpha",
    }),
  );
  await store.commitEvent(
    createArtifactUpdate({
      taskId: "task-1",
      contextId: "context:task-1",
      artifactId: "assistant-output-0001",
      text: " Beta",
      append: true,
      lastChunk: true,
    }),
  );

  const persisted = await store.load("task-1");

  assert.equal(persisted?.status.state, "working");
  assert.equal(persisted?.history?.at(-1)?.role, "agent");
  assert.equal(getPersistedArtifactText(persisted!, "assistant-output"), "Alpha Beta");
});

test("prepareLiveTail subscribes only for active tasks and only yields committed tail events", async () => {
  const store = createTaskStore();

  await store.save(createSnapshot({ taskId: "task-active", state: "submitted" }));
  await store.commitEvent(
    createTaskStatusUpdate({
      taskId: "task-active",
      contextId: "context:task-active",
      state: "working",
      messageText: "Already committed",
    }),
  );
  await store.save(createSnapshot({ taskId: "task-quiescent", state: "input-required" }));
  await store.save(createSnapshot({ taskId: "task-terminal", state: "completed" }));

  const active = await store.prepareLiveTail("task-active");
  const quiescent = await store.prepareLiveTail("task-quiescent");
  const terminal = await store.prepareLiveTail("task-terminal");

  assert.equal(active?.task.status.state, "working");
  assert.ok(active?.subscription);
  assert.equal(quiescent?.subscription, undefined);
  assert.equal(terminal?.subscription, undefined);

  const nextEventPromise = active!.subscription!.next();
  const beforeCommit = await Promise.race([
    nextEventPromise.then(() => "event"),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
  ]);

  assert.equal(beforeCommit, "timeout");

  const committed = await store.commitEvent(
    createArtifactUpdate({
      taskId: "task-active",
      contextId: "context:task-active",
      artifactId: "assistant-output-0001",
      text: "Tail event",
    }),
  );

  assert.deepEqual(await nextEventPromise, committed);
  active!.subscription!.close();
});

test("close clears tasks, bindings, pending bindings, and open subscriptions", async () => {
  const store = createTaskStore();

  await store.save(createSnapshot({ taskId: "task-1", state: "working" }));
  await store.writeBinding("task-1", createBinding("task-1"));
  store.primeBinding("task-pending", createBinding("task-pending"));

  const prepared = await store.prepareLiveTail("task-1");
  const pendingNext = prepared!.subscription!.next();

  store.close();

  assert.deepEqual(await store.listTaskIds(), []);
  assert.equal(await store.load("task-1"), undefined);
  assert.equal(await store.loadBinding("task-1"), undefined);
  assert.equal(await store.loadBinding("task-pending"), undefined);
  assert.equal(await pendingNext, undefined);
});
