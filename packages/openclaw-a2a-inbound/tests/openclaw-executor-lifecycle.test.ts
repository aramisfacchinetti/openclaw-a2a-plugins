import test from "node:test";
import assert from "node:assert/strict";
import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { createOpenClawA2AExecutor } from "../dist/openclaw-executor.js";
import { A2ALiveExecutionRegistry } from "../dist/live-execution-registry.js";
import {
  createEventBusRecorder,
  createPluginRuntimeHarness,
  createRequestContext,
  createTestAccount,
  waitFor,
} from "./runtime-harness.js";

function isMessage(event: unknown): event is Message {
  return typeof event === "object" && event !== null && (event as Message).kind === "message";
}

function isTask(event: unknown): event is Task {
  return typeof event === "object" && event !== null && (event as Task).kind === "task";
}

function isStatusUpdate(event: unknown): event is TaskStatusUpdateEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as TaskStatusUpdateEvent).kind === "status-update"
  );
}

function isArtifactUpdate(event: unknown): event is TaskArtifactUpdateEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as TaskArtifactUpdateEvent).kind === "artifact-update"
  );
}

function createExecutorHarness(script: Parameters<typeof createPluginRuntimeHarness>[0]) {
  const { pluginRuntime } = createPluginRuntimeHarness(script);
  const liveExecutions = new A2ALiveExecutionRegistry();

  return {
    liveExecutions,
    executor: createOpenClawA2AExecutor({
      accountId: "default",
      account: createTestAccount(),
      cfg: {},
      channelRuntime: pluginRuntime.channel,
      pluginRuntime,
      liveExecutions,
    }),
  };
}

test("direct terminal run publishes one A2A message", async () => {
  const { executor } = createExecutorHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-direct");
    emit({
      runId: "run-direct",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Direct reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-direct",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const requestContext = createRequestContext();
  const recorder = createEventBusRecorder();

  await executor.execute(requestContext, recorder.bus);
  await recorder.finished;

  assert.equal(recorder.events.length, 1);
  assert.equal(isMessage(recorder.events[0]), true);
  const directMessage = recorder.events[0] as Message;
  const directPart = directMessage.parts[0];
  assert.equal(directPart?.kind, "text");
  assert.equal(directPart && "text" in directPart ? directPart.text : undefined, "Direct reply");
});

test("block emission alone does not force task mode for a terminal reply", async () => {
  const { executor } = createExecutorHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-block-only");
    emit({
      runId: "run-block-only",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Draft reply" },
      { kind: "block" },
    );
    await params.dispatcherOptions.deliver(
      { text: "Draft reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-block-only",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const requestContext = createRequestContext();
  const recorder = createEventBusRecorder();

  await executor.execute(requestContext, recorder.bus);
  await recorder.finished;

  assert.equal(recorder.events.length, 1);
  assert.equal(isMessage(recorder.events[0]), true);
});

test("promoted run publishes task, working state, artifacts, and final completion", async () => {
  const { executor } = createExecutorHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-promoted");
    emit({
      runId: "run-promoted",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-promoted",
      stream: "assistant",
      data: { text: "Planning the work" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Ran a tool" },
      { kind: "tool" },
    );
    emit({
      runId: "run-promoted",
      stream: "assistant",
      data: { text: "Planning the work\nFinished the answer" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Finished the answer" },
      { kind: "final" },
    );
    emit({
      runId: "run-promoted",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const requestContext = createRequestContext();
  const recorder = createEventBusRecorder();

  await executor.execute(requestContext, recorder.bus);
  await recorder.finished;

  const taskEvent = recorder.events.find(isTask);
  const statusEvents = recorder.events.filter(isStatusUpdate);
  const artifactEvents = recorder.events.filter(isArtifactUpdate);

  assert.ok(taskEvent);
  assert.equal(taskEvent.status.state, "submitted");
  assert.deepEqual(
    statusEvents.map((event) => [event.status.state, event.final]),
    [
      ["submitted", false],
      ["working", false],
      ["completed", true],
    ],
  );
  assert.ok(
    artifactEvents.some(
      (event) =>
        event.artifact.artifactId === "assistant-output" &&
        event.artifact.parts.some(
          (part) => part.kind === "text" && part.text.includes("Planning the work"),
        ),
    ),
  );
  assert.ok(
    artifactEvents.some((event) => event.artifact.artifactId.startsWith("tool-result-")),
  );
});

test("lifecycle error produces a failed task state", async () => {
  const { executor } = createExecutorHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-error");
    emit({
      runId: "run-error",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-error",
      stream: "assistant",
      data: { text: "Partial answer" },
    });
    emit({
      runId: "run-error",
      stream: "lifecycle",
      data: { phase: "error", error: "Run exploded" },
    });
  });
  const requestContext = createRequestContext();
  const recorder = createEventBusRecorder();

  await executor.execute(requestContext, recorder.bus);
  await recorder.finished;

  const taskEvent = recorder.events.find(isTask);
  const finalStatus = recorder.events.filter(isStatusUpdate).at(-1);

  assert.ok(taskEvent);
  assert.ok(finalStatus);
  assert.equal(finalStatus.status.state, "failed");
  assert.equal(finalStatus.final, true);
  assert.equal(finalStatus.status.message?.parts[0]?.kind, "text");
  assert.equal(
    finalStatus.status.message?.parts[0] &&
      "text" in finalStatus.status.message.parts[0]
      ? finalStatus.status.message.parts[0].text
      : undefined,
    "Run exploded",
  );
});

test("cancelTask publishes one final canceled state and clears live execution", async () => {
  const { executor, liveExecutions } = createExecutorHarness(
    async ({ params, emit, waitForAbort }) => {
      params.replyOptions?.onAgentRunStart?.("run-cancel");
      emit({
        runId: "run-cancel",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        { text: "Tool output" },
        { kind: "tool" },
      );
      await waitForAbort();
    },
  );
  const requestContext = createRequestContext();
  const recorder = createEventBusRecorder();

  const executePromise = executor.execute(requestContext, recorder.bus);

  await waitFor(() =>
    recorder.events.some(
      (event) => isTask(event) && event.id === requestContext.taskId,
    ),
  );

  await executor.cancelTask(requestContext.taskId, recorder.bus);
  await executePromise;
  await recorder.finished;

  const canceledStatuses = recorder.events.filter(
    (event) =>
      isStatusUpdate(event) &&
      event.status.state === "canceled" &&
      event.final === true,
  );

  assert.equal(canceledStatuses.length, 1);
  assert.equal(liveExecutions.has(requestContext.taskId), false);
});
