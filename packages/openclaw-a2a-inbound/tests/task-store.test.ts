import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import {
  createArtifactUpdate,
  createTaskSnapshot,
  createTaskStatusUpdate,
} from "../dist/response-mapping.js";
import { encodeTaskStorageId } from "../dist/storage-id.js";
import {
  createTaskStore,
  type StoredTaskBinding,
} from "../dist/task-store.js";
import { createUserMessage } from "./runtime-harness.js";
import {
  assertNoOpenClawMetadata,
  getPersistedArtifactText,
} from "./test-helpers.js";

interface PersistedTaskRecordData {
  schemaVersion: number;
  task: Task;
  binding?: StoredTaskBinding;
  currentSequence?: number;
  journal?: Array<{
    sequence: number;
    event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
  }>;
}

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

function readMemoryStoredRecord(
  store: ReturnType<typeof createTaskStore>,
  taskId: string,
): PersistedTaskRecordData | undefined {
  const backend = (
    store as unknown as {
      backend?: {
        records?: Map<string, PersistedTaskRecordData>;
      };
    }
  ).backend;
  const record = backend?.records?.get(taskId);
  return record ? structuredClone(record) : undefined;
}

function readOpenSubscriptionCount(store: ReturnType<typeof createTaskStore>): number {
  const subscriptions = (
    store as unknown as {
      subscriptions?: Set<unknown>;
    }
  ).subscriptions;

  return subscriptions?.size ?? 0;
}

async function readJsonStoredRecord(
  root: string,
  taskId: string,
): Promise<PersistedTaskRecordData> {
  const path = join(root, `${encodeTaskStorageId(taskId)}.json`);
  return JSON.parse(await readFile(path, "utf8")) as PersistedTaskRecordData;
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

test("committed journal events advance currentSequence, update the snapshot, and persist journal entries in order", async () => {
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
  const record = readMemoryStoredRecord(store, "task-1");

  assert.equal(persisted?.status.state, "working");
  assert.equal(persisted?.history?.at(-1)?.role, "agent");
  assert.equal(getPersistedArtifactText(persisted!, "assistant-output"), "Alpha Beta");
  assert.equal(record?.schemaVersion, 2);
  assert.equal(record?.currentSequence, 3);
  assert.deepEqual(
    record?.journal?.map((entry) => [entry.sequence, entry.event.kind]),
    [
      [1, "status-update"],
      [2, "artifact-update"],
      [3, "artifact-update"],
    ],
  );
});

test("save, writeBinding, and persistIncomingMessage preserve the existing journal and currentSequence", async () => {
  const store = createTaskStore();
  const binding = createBinding("task-1");
  const followUp = createUserMessage({
    messageId: "message:task-1:2",
    contextId: "context:task-1",
    taskId: "task-1",
    parts: [{ kind: "text", text: "Second request" }],
  });

  await store.save(createSnapshot({ taskId: "task-1", state: "submitted" }));
  await store.commitEvent(
    createTaskStatusUpdate({
      taskId: "task-1",
      contextId: "context:task-1",
      state: "working",
      messageText: "Working",
    }),
  );
  await store.writeBinding("task-1", binding);
  await store.persistIncomingMessage("task-1", followUp);

  const currentTask = await store.load("task-1");
  assert.ok(currentTask);
  await store.save(currentTask!);

  const record = readMemoryStoredRecord(store, "task-1");

  assert.equal(record?.currentSequence, 1);
  assert.deepEqual(record?.journal?.map((entry) => entry.sequence), [1]);
  assert.deepEqual(record?.binding, binding);
  assert.equal(
    currentTask?.history?.some((message) => message.messageId === followUp.messageId),
    true,
  );
});

test("prepareResubscribe with allowLiveTail=true returns the latest snapshot and only future tail events for active tasks", async () => {
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

  const prepared = await store.prepareResubscribe("task-active", {
    allowLiveTail: true,
  });

  assert.equal(prepared?.kind, "live-tail");
  assert.equal(prepared?.snapshot.status.state, "working");
  assert.ok(prepared && prepared.kind === "live-tail" && prepared.subscription);

  if (!prepared || prepared.kind !== "live-tail") {
    assert.fail("expected live-tail resubscribe preparation");
  }

  const nextEventPromise = prepared.subscription.next();
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
  prepared.subscription.close();
});

test("prepareResubscribe with allowLiveTail=false returns snapshot-only for active tasks without creating a subscription", async () => {
  const store = createTaskStore();

  await store.save(createSnapshot({ taskId: "task-active", state: "working" }));

  const subscriptionsBefore = readOpenSubscriptionCount(store);
  const prepared = await store.prepareResubscribe("task-active", {
    allowLiveTail: false,
  });
  const subscriptionsAfter = readOpenSubscriptionCount(store);

  assert.equal(prepared?.kind, "snapshot-only");
  assert.equal(prepared?.snapshot.status.state, "working");
  assert.equal(subscriptionsAfter, subscriptionsBefore);
});

test("subscribeToCommittedTail subscribes only for active tasks and only yields committed tail events", async () => {
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

  const active = await store.subscribeToCommittedTail("task-active");
  const quiescent = await store.subscribeToCommittedTail("task-quiescent");
  const terminal = await store.subscribeToCommittedTail("task-terminal");

  assert.ok(active);
  assert.equal(quiescent, undefined);
  assert.equal(terminal, undefined);

  const nextEventPromise = active!.next();
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
  active!.close();
});

test("memory backend loses state across new runtime instances", async () => {
  const initial = createTaskStore({ kind: "memory" });

  await initial.save(createSnapshot({ taskId: "task-memory", state: "working" }));
  await initial.commitEvent(
    createArtifactUpdate({
      taskId: "task-memory",
      contextId: "context:task-memory",
      artifactId: "assistant-output-0001",
      text: "Persisted in memory",
    }),
  );

  const record = readMemoryStoredRecord(initial, "task-memory");

  assert.equal(record?.currentSequence, 1);
  assert.equal(record?.journal?.length, 1);
  initial.close();

  const restarted = createTaskStore({ kind: "memory" });

  try {
    assert.equal(await restarted.load("task-memory"), undefined);
    assert.deepEqual(await restarted.listTaskIds(), []);
  } finally {
    restarted.close();
  }
});

test("json-file backend preserves snapshot, binding, journal, history, artifacts, and final state across runtime instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-a2a-inbound-store-"));
  const original = createTaskStore({
    kind: "json-file",
    path: root,
  });
  const followUp = createUserMessage({
    messageId: "message:task-json:2",
    contextId: "context:task-json",
    taskId: "task-json",
    parts: [{ kind: "text", text: "Second request" }],
  });

  try {
    original.primeBinding("task-json", createBinding("task-json"));
    await original.save(
      createTaskSnapshot({
        taskId: "task-json",
        contextId: "context:task-json",
        state: "submitted",
        history: [
          createUserMessage({
            messageId: "message:task-json:1",
            contextId: "context:task-json",
            taskId: "task-json",
            parts: [{ kind: "text", text: "First request" }],
          }),
        ],
      }),
    );
    await original.persistIncomingMessage("task-json", followUp);
    await original.commitEvent(
      createTaskStatusUpdate({
        taskId: "task-json",
        contextId: "context:task-json",
        state: "working",
        messageText: "Working",
      }),
    );
    await original.commitEvent(
      createArtifactUpdate({
        taskId: "task-json",
        contextId: "context:task-json",
        artifactId: "assistant-output-0001",
        text: "Alpha",
      }),
    );
    await original.commitEvent(
      createTaskStatusUpdate({
        taskId: "task-json",
        contextId: "context:task-json",
        state: "completed",
        final: true,
        messageText: "Done",
      }),
    );
  } finally {
    original.close();
  }

  const rawRecord = await readJsonStoredRecord(root, "task-json");

  const restarted = createTaskStore({
    kind: "json-file",
    path: root,
  });

  try {
    const persisted = await restarted.load("task-json");
    const binding = await restarted.loadBinding("task-json");

    assert.deepEqual(await restarted.listTaskIds(), ["task-json"]);
    assert.equal(rawRecord.schemaVersion, 2);
    assert.equal(rawRecord.currentSequence, 3);
    assert.deepEqual(
      rawRecord.journal?.map((entry) => [entry.sequence, entry.event.kind]),
      [
        [1, "status-update"],
        [2, "artifact-update"],
        [3, "status-update"],
      ],
    );
    assertNoOpenClawMetadata(rawRecord);
    assert.deepEqual(persisted, rawRecord.task);
    assert.equal(persisted?.status.state, "completed");
    assert.deepEqual(
      persisted?.history?.slice(0, 2).map((message) => message.messageId),
      ["message:task-json:1", "message:task-json:2"],
    );
    assert.equal(persisted?.history?.at(-1)?.role, "agent");
    assert.equal(getPersistedArtifactText(persisted!, "assistant-output"), "Alpha");
    assert.deepEqual(binding, createBinding("task-json"));
  } finally {
    restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("json-file backend lazily upgrades schema v1 records to schema v2 on the next write", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-a2a-inbound-store-v1-"));
  const taskId = "task-v1";
  const filePath = join(root, `${encodeTaskStorageId(taskId)}.json`);
  const followUp = createUserMessage({
    messageId: "message:task-v1:2",
    contextId: "context:task-v1",
    taskId,
    parts: [{ kind: "text", text: "Follow-up" }],
  });

  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        task: createSnapshot({ taskId, state: "working" }),
        binding: createBinding(taskId),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const store = createTaskStore({
    kind: "json-file",
    path: root,
  });

  try {
    const loaded = await store.load(taskId);
    const binding = await store.loadBinding(taskId);
    const beforeWrite = await readJsonStoredRecord(root, taskId);

    assert.equal(loaded?.status.state, "working");
    assert.deepEqual(binding, createBinding(taskId));
    assert.equal(beforeWrite.schemaVersion, 1);
    assert.equal("currentSequence" in beforeWrite, false);
    assert.equal("journal" in beforeWrite, false);

    await store.persistIncomingMessage(taskId, followUp);

    const afterWrite = await readJsonStoredRecord(root, taskId);

    assert.equal(afterWrite.schemaVersion, 2);
    assert.equal(afterWrite.currentSequence, 0);
    assert.deepEqual(afterWrite.journal, []);
    assert.deepEqual(afterWrite.binding, createBinding(taskId));
    assert.deepEqual(
      afterWrite.task.history?.map((message) => message.messageId),
      ["message:task-v1:1", "message:task-v1:2"],
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("close clears tasks, bindings, pending bindings, and open subscriptions", async () => {
  const store = createTaskStore();

  await store.save(createSnapshot({ taskId: "task-1", state: "working" }));
  await store.writeBinding("task-1", createBinding("task-1"));
  store.primeBinding("task-pending", createBinding("task-pending"));

  const subscription = await store.subscribeToCommittedTail("task-1");
  const pendingNext = subscription!.next();

  store.close();

  assert.deepEqual(await store.listTaskIds(), []);
  assert.equal(await store.load("task-1"), undefined);
  assert.equal(await store.loadBinding("task-1"), undefined);
  assert.equal(await store.loadBinding("task-pending"), undefined);
  assert.equal(await pendingNext, undefined);
});
