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

function getOpenClawMetadata(
  value: { metadata?: Record<string, unknown> | undefined },
): Record<string, unknown> | undefined {
  const metadata = value.metadata;

  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    typeof metadata.openclaw !== "object" ||
    metadata.openclaw === null ||
    Array.isArray(metadata.openclaw)
  ) {
    return undefined;
  }

  return metadata.openclaw as Record<string, unknown>;
}

function getArtifactText(event: TaskArtifactUpdateEvent): string | undefined {
  const textPart = event.artifact.parts.find((part) => part.kind === "text");
  return textPart?.kind === "text" ? textPart.text : undefined;
}

function getArtifactData(
  event: TaskArtifactUpdateEvent,
): Record<string, unknown> | undefined {
  const dataPart = event.artifact.parts.find((part) => part.kind === "data");
  return dataPart?.kind === "data"
    ? (dataPart.data as Record<string, unknown>)
    : undefined;
}

function getStatusMessageText(event: TaskStatusUpdateEvent): string | undefined {
  const part = event.status.message?.parts[0];
  return part?.kind === "text" ? part.text : undefined;
}

function getArtifactUpdates(
  events: readonly (Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent)[],
  artifactId: string,
): TaskArtifactUpdateEvent[] {
  return events.filter(
    (event): event is TaskArtifactUpdateEvent =>
      isArtifactUpdate(event) && event.artifact.artifactId === artifactId,
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

test("non_blocking mode publishes a Task before a simple terminal reply", async () => {
  const { executor, liveExecutions } = createExecutorHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-nonblocking");
    emit({
      runId: "run-nonblocking",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Nonblocking reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-nonblocking",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const requestContext = createRequestContext();
  liveExecutions.setRequestMode(requestContext.userMessage.messageId, "non_blocking");
  const recorder = createEventBusRecorder();

  await executor.execute(requestContext, recorder.bus);
  await recorder.finished;

  const assistantUpdates = getArtifactUpdates(recorder.events, "assistant-output");

  assert.equal(recorder.events[0]?.kind, "task");
  assert.equal(recorder.events.some(isMessage), false);
  assert.deepEqual(
    recorder.events
      .filter(isStatusUpdate)
      .map((event) => [event.status.state, event.final]),
    [
      ["submitted", false],
      ["working", false],
      ["completed", true],
    ],
  );
  assert.equal(getArtifactText(assistantUpdates[0]), "Nonblocking reply");
});

test("non_blocking mode learns runId from agent events instead of session or context ids", async () => {
  const { executor, liveExecutions } = createExecutorHarness(async ({ params, emit }) => {
    emit({
      runId: "run-event-owned",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Event-owned reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-event-owned",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const requestContext = createRequestContext({
    contextId: "context-event-owned",
  });
  liveExecutions.setRequestMode(requestContext.userMessage.messageId, "non_blocking");
  const recorder = createEventBusRecorder();

  await executor.execute(requestContext, recorder.bus);
  await recorder.finished;

  const statusEvents = recorder.events.filter(isStatusUpdate);
  const assistantUpdates = getArtifactUpdates(recorder.events, "assistant-output");
  const workingStatus = statusEvents.find((event) => event.status.state === "working");
  const finalStatus = statusEvents.at(-1);
  const workingRunId = workingStatus
    ? getOpenClawMetadata(workingStatus)?.runId
    : undefined;
  const finalRunId = finalStatus
    ? getOpenClawMetadata(finalStatus)?.runId
    : undefined;
  const artifactRunId = assistantUpdates[0]
    ? getOpenClawMetadata(assistantUpdates[0])?.runId
    : undefined;

  assert.equal(workingRunId, "run-event-owned");
  assert.equal(finalRunId, "run-event-owned");
  assert.equal(artifactRunId, "run-event-owned");
  assert.notEqual(workingRunId, requestContext.contextId);
  assert.notEqual(workingRunId, "session:test");
});

test("promoted live executions record both sessionKey and runId", async () => {
  let releaseRun: (() => void) | undefined;

  const { executor, liveExecutions } = createExecutorHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-live-bridge");
    emit({
      runId: "run-live-bridge",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Tool summary" },
      { kind: "tool" },
    );
    await new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    await params.dispatcherOptions.deliver(
      { text: "Finished reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-live-bridge",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const requestContext = createRequestContext();
  const recorder = createEventBusRecorder();

  const executePromise = executor.execute(requestContext, recorder.bus);

  await waitFor(() => {
    const record = liveExecutions.get(requestContext.taskId);
    return (
      record?.sessionKey === "session:test" &&
      record.runId === "run-live-bridge"
    );
  });

  const liveRecord = liveExecutions.get(requestContext.taskId);
  assert.equal(liveRecord?.sessionKey, "session:test");
  assert.equal(liveRecord?.runId, "run-live-bridge");

  releaseRun?.();
  await executePromise;
  await recorder.finished;
});

test("streaming mode publishes task-first assistant progress and closes the artifact", async () => {
  const { executor, liveExecutions } = createExecutorHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-streaming");
    emit({
      runId: "run-streaming",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-streaming",
      stream: "assistant",
      data: { delta: "Streaming reply" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Streaming reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-streaming",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const requestContext = createRequestContext();
  liveExecutions.setRequestMode(requestContext.userMessage.messageId, "streaming");
  const recorder = createEventBusRecorder();

  await executor.execute(requestContext, recorder.bus);
  await recorder.finished;

  const assistantUpdates = getArtifactUpdates(recorder.events, "assistant-output");
  const closingUpdate = assistantUpdates.at(-1);

  assert.equal(recorder.events[0]?.kind, "task");
  assert.equal(recorder.events.some(isMessage), false);
  assert.equal(assistantUpdates.length, 2);
  assert.equal(getArtifactText(assistantUpdates[0]), "Streaming reply");
  assert.ok(closingUpdate);
  assert.equal(closingUpdate.lastChunk, true);
  assert.equal(getArtifactText(closingUpdate), undefined);
  assert.equal(closingUpdate.append, true);
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
  const failedStatuses = recorder.events.filter(
    (event) =>
      isStatusUpdate(event) &&
      event.status.state === "failed" &&
      event.final === true,
  );

  assert.ok(taskEvent);
  assert.ok(finalStatus);
  assert.equal(failedStatuses.length, 1);
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

test("approval-pending tool results publish input-required without completing", async () => {
  const { executor, liveExecutions } = createExecutorHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-approval-pending");
    emit({
      runId: "run-approval-pending",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-approval-pending",
      stream: "tool",
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "exec/1",
        isError: false,
        result: {
          status: "approval-pending",
          requiresApproval: {
            type: "approval_request",
          },
          command: "npm publish",
        },
      },
    });
    emit({
      runId: "run-approval-pending",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const requestContext = createRequestContext();
  const recorder = createEventBusRecorder();

  await executor.execute(requestContext, recorder.bus);
  await recorder.finished;

  const statusEvents = recorder.events.filter(isStatusUpdate);
  const inputRequired = statusEvents.at(-1);
  const toolProgress = getArtifactUpdates(recorder.events, "tool-progress-exec_1").at(0);

  assert.deepEqual(
    statusEvents.map((event) => [event.status.state, event.final]),
    [
      ["submitted", false],
      ["working", false],
      ["input-required", false],
    ],
  );
  assert.equal(
    statusEvents.some((event) => event.status.state === "completed"),
    false,
  );
  assert.ok(inputRequired);
  assert.equal(
    inputRequired ? getStatusMessageText(inputRequired) : undefined,
    "OpenClaw is waiting for tool approval to continue.",
  );
  assert.ok(toolProgress);
  assert.deepEqual(toolProgress ? getArtifactData(toolProgress) : undefined, {
    phase: "result",
    name: "exec",
    toolCallId: "exec/1",
    isError: false,
    result: {
      status: "approval-pending",
      requiresApproval: {
        type: "approval_request",
      },
      command: "npm publish",
    },
  });
  assert.equal(liveExecutions.has(requestContext.taskId), false);
});

test("needs_approval tool results use requiresApproval.prompt for input-required", async () => {
  const { executor } = createExecutorHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-needs-approval");
    emit({
      runId: "run-needs-approval",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-needs-approval",
      stream: "tool",
      data: {
        phase: "result",
        name: "shell",
        toolCallId: "shell/1",
        isError: false,
        result: {
          status: "needs_approval",
          requiresApproval: {
            type: "approval_request",
            prompt: "Approve shell command?",
          },
          command: "rm -rf ./build",
        },
      },
    });
    emit({
      runId: "run-needs-approval",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const requestContext = createRequestContext();
  const recorder = createEventBusRecorder();

  await executor.execute(requestContext, recorder.bus);
  await recorder.finished;

  const statusEvents = recorder.events.filter(isStatusUpdate);
  const inputRequired = statusEvents.at(-1);

  assert.deepEqual(
    statusEvents.map((event) => [event.status.state, event.final]),
    [
      ["submitted", false],
      ["working", false],
      ["input-required", false],
    ],
  );
  assert.equal(
    statusEvents.some((event) => event.status.state === "auth-required"),
    false,
  );
  assert.equal(
    inputRequired ? getStatusMessageText(inputRequired) : undefined,
    "Approve shell command?",
  );
});

test("cancelTask aborts immediately but only publishes canceled after reply settlement", async () => {
  let releaseAfterAbort: (() => void) | undefined;
  let signalAborted = false;
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
      signalAborted = true;
      await new Promise<void>((resolve) => {
        releaseAfterAbort = resolve;
      });
      emit({
        runId: "run-cancel",
        stream: "lifecycle",
        data: { phase: "end" },
      });
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

  const pendingRecord = liveExecutions.get(requestContext.taskId);
  assert.ok(pendingRecord);
  assert.equal(pendingRecord?.cancelRequested, false);

  await executor.cancelTask(requestContext.taskId, recorder.bus);

  assert.equal(signalAborted, true);
  assert.equal(
    recorder.events.some(
      (event) =>
        isStatusUpdate(event) &&
        event.status.state === "canceled" &&
        event.final === true,
    ),
    false,
  );
  assert.equal(liveExecutions.has(requestContext.taskId), true);
  assert.equal(
    liveExecutions.get(requestContext.taskId)?.cancelRequested,
    true,
  );

  releaseAfterAbort?.();
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
