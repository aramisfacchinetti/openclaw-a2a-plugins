import test from "node:test";
import assert from "node:assert/strict";
import { A2ALiveExecutionRegistry } from "../dist/live-execution-registry.js";
import { A2AResubscribePlanner } from "../dist/resubscribe-planner.js";
import {
  createArtifactUpdate,
  createTaskSnapshot,
  createTaskStatusUpdate,
} from "../dist/response-mapping.js";
import { createTaskStore } from "../dist/task-store.js";
import { createUserMessage } from "./runtime-harness.js";

function createSnapshot(params: {
  taskId: string;
  contextId?: string;
  state: "working" | "input-required" | "completed";
}) {
  return createTaskSnapshot({
    taskId: params.taskId,
    contextId: params.contextId ?? `context:${params.taskId}`,
    state: params.state,
    history: [
      createUserMessage({
        messageId: `message:${params.taskId}:1`,
        contextId: params.contextId ?? `context:${params.taskId}`,
        taskId: params.taskId,
      }),
    ],
  });
}

test("planner returns undefined when the task does not exist", async () => {
  const planner = new A2AResubscribePlanner(
    await createTaskStore(),
    new A2ALiveExecutionRegistry(),
  );

  assert.equal(await planner.prepare("missing-task"), undefined);
});

test("planner returns snapshot-only with terminal reason for terminal tasks", async () => {
  const store = await createTaskStore();
  await store.save(createSnapshot({ taskId: "task-terminal", state: "completed" }));

  const planner = new A2AResubscribePlanner(
    store,
    new A2ALiveExecutionRegistry(),
  );
  const prepared = await planner.prepare("task-terminal");

  assert.deepEqual(prepared?.kind, "snapshot-only");
  assert.equal(prepared?.snapshot.status.state, "completed");
  assert.equal(prepared?.reason, "terminal");
});

test("planner returns snapshot-only with quiescent reason for quiescent tasks", async () => {
  const store = await createTaskStore();
  await store.save(
    createSnapshot({ taskId: "task-quiescent", state: "input-required" }),
  );

  const planner = new A2AResubscribePlanner(
    store,
    new A2ALiveExecutionRegistry(),
  );
  const prepared = await planner.prepare("task-quiescent");

  assert.deepEqual(prepared?.kind, "snapshot-only");
  assert.equal(prepared?.snapshot.status.state, "input-required");
  assert.equal(prepared?.reason, "quiescent");
});

test("planner returns snapshot-only with orphaned reason for active tasks without live ownership", async () => {
  const store = await createTaskStore();
  await store.save(createSnapshot({ taskId: "task-orphaned", state: "working" }));

  const planner = new A2AResubscribePlanner(
    store,
    new A2ALiveExecutionRegistry(),
  );
  const prepared = await planner.prepare("task-orphaned");

  assert.deepEqual(prepared?.kind, "snapshot-only");
  assert.equal(prepared?.snapshot.status.state, "working");
  assert.equal(prepared?.reason, "orphaned");
});

test("planner returns live-tail for active tasks with live ownership and the subscription yields only future committed events", async () => {
  const store = await createTaskStore();
  const liveExecutions = new A2ALiveExecutionRegistry();

  await store.save(createSnapshot({ taskId: "task-live", state: "submitted" }));
  await store.commitEvent(
    createTaskStatusUpdate({
      taskId: "task-live",
      contextId: "context:task-live",
      state: "working",
      messageText: "Already committed",
    }),
  );
  liveExecutions.activate({
    taskId: "task-live",
    contextId: "context:task-live",
    abortController: new AbortController(),
  });

  const planner = new A2AResubscribePlanner(store, liveExecutions);
  const prepared = await planner.prepare("task-live");

  assert.equal(prepared?.kind, "live-tail");
  assert.equal(prepared?.snapshot.status.state, "working");

  if (!prepared || prepared.kind !== "live-tail") {
    assert.fail("expected live-tail resubscribe plan");
  }

  const nextEventPromise = prepared.subscription.next();
  const beforeCommit = await Promise.race([
    nextEventPromise.then(() => "event"),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
  ]);

  assert.equal(beforeCommit, "timeout");

  const committed = await store.commitEvent(
    createArtifactUpdate({
      taskId: "task-live",
      contextId: "context:task-live",
      artifactId: "assistant-output-0001",
      text: "Tail event",
    }),
  );

  assert.deepEqual(await nextEventPromise, committed);
  prepared.subscription.close();
});
