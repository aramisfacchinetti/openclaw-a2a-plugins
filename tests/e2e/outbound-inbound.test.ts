import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type {
  A2AToolResult,
  FailureEnvelope,
  StreamUpdateEnvelope,
  SuccessEnvelope,
} from "../../packages/openclaw-a2a-outbound/src/result-shape.js";
import type { TargetCatalogEntry } from "../../packages/openclaw-a2a-outbound/src/target-catalog.js";
import {
  directReplyScenario,
  directStreamingScenario,
  durableWatchScenario,
  liveCancelScenario,
  persistedContinuationScenario,
  promotedStreamingScenario,
  quiescentCancelScenario,
  taskRequirementFailureScenario,
  type DurableWatchScenario,
  type DirectReplyScenario,
  type DirectStreamingScenario,
  type LiveCancelScenario,
  type PersistedContinuationScenario,
  type PromotedStreamingScenario,
  type QuiescentCancelScenario,
  type TaskRequirementFailureScenario,
} from "./outbound-inbound-harness.js";

function asSuccess(result: A2AToolResult): SuccessEnvelope {
  if (result.ok !== true) {
    throw new TypeError("expected success result");
  }

  return result;
}

function asFailure(result: A2AToolResult): FailureEnvelope {
  if (result.ok !== false) {
    throw new TypeError("expected failure result");
  }

  return result;
}

function asMessage(raw: SuccessEnvelope["raw"]): Message {
  if (typeof raw !== "object" || raw === null || (raw as { kind?: unknown }).kind !== "message") {
    throw new TypeError("expected raw message");
  }

  return raw as Message;
}

function readMessageText(message: Message): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
}

function taskContinuationFromSummary(
  summary: SuccessEnvelope["summary"],
): NonNullable<NonNullable<SuccessEnvelope["summary"]["continuation"]>["task"]> {
  const task = summary.continuation?.task;

  if (!task) {
    throw new TypeError("expected task continuation");
  }

  return task;
}

function conversationContinuationFromSummary(
  summary: SuccessEnvelope["summary"],
): NonNullable<
  NonNullable<SuccessEnvelope["summary"]["continuation"]>["conversation"]
> {
  const conversation = summary.continuation?.conversation;

  if (!conversation) {
    throw new TypeError("expected conversation continuation");
  }

  return conversation;
}

function asStreamRaw(
  raw: SuccessEnvelope["raw"],
): { events: Array<Message | Task | TaskArtifactUpdateEvent | TaskStatusUpdateEvent> } {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("events" in raw) ||
    !Array.isArray((raw as { events?: unknown }).events)
  ) {
    throw new TypeError("expected raw stream result");
  }

  return raw as {
    events: Array<Message | Task | TaskArtifactUpdateEvent | TaskStatusUpdateEvent>;
  };
}

function isTaskBearingEvent(
  event: Message | Task | TaskArtifactUpdateEvent | TaskStatusUpdateEvent | undefined,
): event is Task | TaskArtifactUpdateEvent | TaskStatusUpdateEvent {
  return (
    event?.kind === "task" ||
    event?.kind === "artifact-update" ||
    event?.kind === "status-update"
  );
}

function isTerminalTaskState(state: string): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "canceled" ||
    state === "rejected"
  );
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function waitForTaskStatus(
  scenario: { service: DirectReplyScenario["service"] },
  continuation: NonNullable<SuccessEnvelope["summary"]["continuation"]>,
  expectedStatus: string,
  timeoutMs = 2_000,
): Promise<SuccessEnvelope<"status">> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = asSuccess(
      await scenario.service.execute({
        action: "status",
        continuation,
        history_length: 10,
      }),
    );
    const task = taskContinuationFromSummary(result.summary);

    if (task.status === expectedStatus) {
      return result as SuccessEnvelope<"status">;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`task did not reach status ${expectedStatus} within ${timeoutMs}ms`);
}

describe("direct + card discovery", () => {
  let scenario: DirectReplyScenario;

  before(async () => {
    scenario = await directReplyScenario();
  });

  after(async () => {
    await scenario.cleanup();
  });

  it("list_targets hydrates the real inbound agent card", async () => {
    const result = await scenario.service.execute({
      action: "list_targets",
    });
    const success = asSuccess(result);
    const targets = success.summary.targets ?? [];
    const rawTargets = success.raw as TargetCatalogEntry[];

    assert.equal(success.action, "list_targets");
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.target_alias, scenario.alias);
    assert.equal(targets[0]?.target_name, scenario.account.label);
    assert.equal(targets[0]?.description, scenario.account.description);
    assert.equal(targets[0]?.streaming_supported, true);
    assert.ok((targets[0]?.peer_card.skills.length ?? 0) > 0);
    assert.equal(targets[0]?.peer_card.skills[0]?.id, scenario.account.skills[0]?.id);
    assert.equal(rawTargets[0]?.target.alias, scenario.alias);
    assert.equal(rawTargets[0]?.target.streamingSupported, true);
    assert.equal(rawTargets[0]?.card.displayName, scenario.account.label);
    assert.equal(rawTargets[0]?.card.description, scenario.account.description);
    assert.equal(scenario.requestCounts.agentCard, 1);
  });

  it("send returns a direct message from a real inbound server", async () => {
    const result = await scenario.service.execute({
      action: "send",
      target_alias: scenario.alias,
      parts: [{ kind: "text", text: "Say hello directly." }],
    });
    const success = asSuccess(result);
    const rawMessage = asMessage(success.raw);

    assert.equal(success.action, "send");
    assert.equal(success.summary.target_alias, scenario.alias);
    assert.equal(success.summary.response_kind, "message");
    assert.equal(success.summary.message_text, scenario.expectedReplyText);
    assert.equal(rawMessage.kind, "message");
    assert.equal(readMessageText(rawMessage), scenario.expectedReplyText);
  });
});

describe("promoted streaming", () => {
  let scenario: PromotedStreamingScenario;

  before(async () => {
    scenario = await promotedStreamingScenario();
  });

  after(async () => {
    await scenario.cleanup();
  });

  it("send with follow_updates=true consumes a real inbound SSE stream and returns a task_handle", async () => {
    const updates: StreamUpdateEnvelope<"send">[] = [];
    const result = await scenario.service.execute(
      {
        action: "send",
        target_alias: scenario.alias,
        parts: [{ kind: "text", text: "Start the promoted workflow." }],
        follow_updates: true,
      },
      {
        onUpdate(update) {
          updates.push(update as StreamUpdateEnvelope<"send">);
        },
      },
    );
    const success = asSuccess(result);
    const raw = asStreamRaw(success.raw);
    const task = taskContinuationFromSummary(success.summary);
    const firstRaw = raw.events[0];
    const lastRaw = raw.events.at(-1);

    assert.equal(success.action, "send");
    assert.equal(success.summary.response_kind, "task");
    assert.equal(task.status, "completed");
    assert.equal(typeof task.task_handle, "string");
    const taskHandle = task.task_handle;
    if (typeof taskHandle !== "string") {
      assert.fail("expected task_handle");
    }
    assert.ok(taskHandle.length > 0);
    assert.ok(updates.length >= 2);
    assert.equal(updates.at(-1)?.summary.continuation?.task?.status, "completed");
    assert.ok(raw.events.length >= 3);
    assert.equal(firstRaw?.kind, "task");
    assert.ok(raw.events.some((event) => event.kind === "artifact-update"));
    assert.equal(lastRaw?.kind, "status-update");
    assert.equal((lastRaw as TaskStatusUpdateEvent | undefined)?.status.state, "completed");
    const streamedArtifacts = raw.events.filter(
      (event): event is TaskArtifactUpdateEvent => event.kind === "artifact-update",
    );
    assert.ok(
      streamedArtifacts.some((event) =>
        event.artifact.parts.some(
          (part) => part.kind === "text" && part.text.includes(scenario.expectedToolText),
        ),
      ),
    );
    assert.match(success.summary.message_text ?? "", /Promoted final answer/);
  });
});

describe("strict task requirement", () => {
  let successScenario: DirectReplyScenario;
  let failureScenario: TaskRequirementFailureScenario;

  before(async () => {
    successScenario = await directReplyScenario();
    failureScenario = await taskRequirementFailureScenario();
  });

  after(async () => {
    await Promise.all([successScenario.cleanup(), failureScenario.cleanup()]);
  });

  it("send with task_requirement=required forces a real inbound direct reply onto the durable task path", async () => {
    const result = await successScenario.service.execute({
      action: "send",
      target_alias: successScenario.alias,
      task_requirement: "required",
      blocking: true,
      parts: [{ kind: "text", text: "Require a durable task for this direct reply." }],
    });
    const success = asSuccess(result);
    const rawTask = success.raw as Task;
    const task = taskContinuationFromSummary(success.summary);
    const conversation = conversationContinuationFromSummary(success.summary);
    const continuation = structuredClone(success.summary.continuation);

    if (!continuation) {
      assert.fail("expected continuation");
    }

    const completedStatus = await waitForTaskStatus(
      successScenario,
      continuation,
      "completed",
    );
    const completedRawTask = completedStatus.raw as Task;

    assert.equal(success.action, "send");
    assert.equal(success.summary.response_kind, "task");
    assert.equal(rawTask.kind, "task");
    assert.equal(task.task_id, rawTask.id);
    assert.equal(task.status, rawTask.status.state);
    assert.equal(task.can_resume_send, true);
    assert.match(String(task.task_handle), /^rah_/);
    assert.equal(conversation.context_id, rawTask.contextId);
    assert.equal(completedStatus.action, "status");
    assert.equal(completedRawTask.kind, "task");
    assert.equal(completedRawTask.id, task.task_id);
    assert.equal(completedRawTask.status.state, "completed");
    assert.match(
      completedStatus.summary.message_text ?? "",
      new RegExp(successScenario.expectedReplyText),
    );
  });

  it("send with task_requirement=required fails when a real inbound direct reply is forced back to a Message", async () => {
    const result = await failureScenario.service.execute({
      action: "send",
      target_alias: failureScenario.alias,
      task_requirement: "required",
      parts: [{ kind: "text", text: "Require a durable task for this proxy-routed reply." }],
    });
    const failure = asFailure(result);
    const details =
      typeof failure.error.details === "object" && failure.error.details !== null
        ? (failure.error.details as Record<string, unknown>)
        : undefined;

    assert.equal(failure.action, "send");
    assert.equal(failure.error.code, "TASK_REQUIRED_BUT_MESSAGE_RETURNED");
    assert.equal(details?.response_kind, "message");
    assert.ok(failureScenario.requestCounts.agentCard >= 1);
    assert.ok(failureScenario.requestCounts.jsonRpc >= 1);
  });
});

describe("direct streaming", () => {
  let scenario: DirectStreamingScenario;

  before(async () => {
    scenario = await directStreamingScenario();
  });

  after(async () => {
    await scenario.cleanup();
  });

  it("send with follow_updates=true preserves a real inbound message-only SSE stream as a direct message", async () => {
    const updates: StreamUpdateEnvelope<"send">[] = [];
    const startingJsonRpcCount = scenario.requestCounts.jsonRpc;
    const result = await scenario.service.execute(
      {
        action: "send",
        target_alias: scenario.alias,
        parts: [{ kind: "text", text: "Stream a direct reply only." }],
        follow_updates: true,
      },
      {
        onUpdate(update) {
          updates.push(update as StreamUpdateEnvelope<"send">);
        },
      },
    );
    const success = asSuccess(result);
    const raw = asStreamRaw(success.raw);
    const conversation = conversationContinuationFromSummary(success.summary);
    const onlyRaw = raw.events[0];

    assert.equal(success.action, "send");
    assert.equal(success.summary.response_kind, "message");
    assert.equal(success.summary.message_text, scenario.expectedReplyText);
    assert.equal(success.summary.continuation?.task, undefined);
    assert.equal(typeof conversation.context_id, "string");
    assert.ok(conversation.context_id.length > 0);
    assert.equal(raw.events.length, 1);
    assert.equal(onlyRaw?.kind, "message");
    assert.equal(isTaskBearingEvent(onlyRaw), false);
    if (!onlyRaw || onlyRaw.kind !== "message") {
      assert.fail("expected a single raw message event");
    }
    assert.equal(readMessageText(onlyRaw), scenario.expectedReplyText);
    assert.ok(updates.length >= 1);
    for (const update of updates) {
      assert.equal(update.action, "send");
      assert.equal(update.phase, "update");
      assert.equal(update.summary.response_kind, "message");
      assert.equal(update.summary.continuation?.task, undefined);
      assert.equal(
        update.summary.continuation?.conversation?.context_id,
        conversation.context_id,
      );
      assert.equal(update.raw.kind, "message");
      assert.equal(isTaskBearingEvent(update.raw), false);
    }
    assert.ok(scenario.requestCounts.jsonRpc > startingJsonRpcCount);
  });

  it("conversation-only continuation allows send and rejects watch, status, and cancel", async () => {
    const firstSend = asSuccess(
      await scenario.service.execute({
        action: "send",
        target_alias: scenario.alias,
        parts: [{ kind: "text", text: "Start a direct conversation-only continuation." }],
      }),
    );
    const continuation = structuredClone(firstSend.summary.continuation);
    const firstConversation = conversationContinuationFromSummary(firstSend.summary);

    if (!continuation) {
      assert.fail("expected continuation");
    }

    assert.equal(firstSend.summary.continuation?.task, undefined);

    const startingJsonRpcCount = scenario.requestCounts.jsonRpc;
    const resumedSend = asSuccess(
      await scenario.service.execute({
        action: "send",
        continuation,
        parts: [{ kind: "text", text: "Continue within the existing conversation only." }],
      }),
    );
    const resumedConversation = conversationContinuationFromSummary(resumedSend.summary);

    assert.equal(resumedSend.action, "send");
    assert.equal(resumedSend.summary.response_kind, "message");
    assert.equal(resumedSend.summary.message_text, scenario.expectedReplyText);
    assert.equal(resumedSend.summary.continuation?.task, undefined);
    assert.equal(resumedConversation.context_id, firstConversation.context_id);
    assert.ok(scenario.requestCounts.jsonRpc > startingJsonRpcCount);

    const rejectedStartingJsonRpcCount = scenario.requestCounts.jsonRpc;

    for (const action of ["watch", "status", "cancel"] as const) {
      const failure = asFailure(
        await scenario.service.execute({
          action,
          continuation,
        }),
      );
      const details =
        typeof failure.error.details === "object" && failure.error.details !== null
          ? (failure.error.details as {
              source?: unknown;
              tool?: unknown;
              errors?: Array<{ instancePath?: unknown; message?: unknown }>;
            })
          : undefined;

      assert.equal(failure.action, action);
      assert.equal(failure.error.code, "VALIDATION_ERROR");
      assert.equal(failure.error.message, "remote_agent input validation failed");
      assert.equal(details?.source, "ajv");
      assert.equal(details?.tool, "remote_agent");
      assert.ok(
        details?.errors?.some(
          (error) =>
            error.instancePath === "/continuation" &&
            error.message ===
              `${action} requires continuation.task.task_id when continuation is present`,
        ),
      );
    }

    assert.equal(scenario.requestCounts.jsonRpc, rejectedStartingJsonRpcCount);
  });
});

describe("persisted continuation", () => {
  let scenario: PersistedContinuationScenario;

  before(async () => {
    scenario = await persistedContinuationScenario();
  });

  after(async () => {
    await scenario.cleanup();
  });

  it("recovers persisted summary.continuation through send and status after outbound restart", async () => {
    const firstSend = asSuccess(
      await scenario.service.execute({
        action: "send",
        target_alias: scenario.alias,
        parts: [{ kind: "text", text: scenario.initialPromptText }],
      }),
    );
    const firstTask = taskContinuationFromSummary(firstSend.summary);
    const firstConversation = conversationContinuationFromSummary(firstSend.summary);

    assert.equal(firstSend.action, "send");
    assert.equal(firstSend.summary.response_kind, "task");
    assert.equal(firstTask.status, "input-required");
    assert.match(firstSend.summary.message_text ?? "", new RegExp(scenario.expectedPausePromptText));
    assert.equal(typeof firstTask.task_id, "string");
    assert.equal(typeof firstTask.task_handle, "string");
    assert.equal(typeof firstConversation.context_id, "string");

    const persistedContinuation = structuredClone(firstSend.summary.continuation);
    if (!persistedContinuation) {
      assert.fail("expected continuation");
    }

    const restartedService = await scenario.createFreshService();

    const resumedSend = asSuccess(
      await restartedService.execute({
        action: "send",
        continuation: persistedContinuation,
        parts: [{ kind: "text", text: scenario.resumedPromptText }],
      }),
    );
    const resumedTask = taskContinuationFromSummary(resumedSend.summary);
    const resumedConversation = conversationContinuationFromSummary(resumedSend.summary);

    assert.equal(resumedSend.action, "send");
    assert.equal(resumedSend.summary.response_kind, "task");
    assert.equal(resumedTask.task_id, firstTask.task_id);
    assert.equal(typeof resumedTask.task_handle, "string");
    assert.equal(resumedTask.status, "completed");
    assert.equal(resumedConversation.context_id, firstConversation.context_id);
    assert.match(
      resumedSend.summary.message_text ?? "",
      new RegExp(scenario.expectedResumedFinalText),
    );

    const status = asSuccess(
      await restartedService.execute({
        action: "status",
        continuation: persistedContinuation,
        history_length: 10,
      }),
    );
    const statusTask = taskContinuationFromSummary(status.summary);
    const statusConversation = conversationContinuationFromSummary(status.summary);
    const rawTask = status.raw as Task;

    assert.equal(status.action, "status");
    assert.equal(status.summary.response_kind, "task");
    assert.equal(statusTask.task_id, firstTask.task_id);
    assert.equal(typeof statusTask.task_handle, "string");
    assert.equal(statusTask.status, "completed");
    assert.equal(statusConversation.context_id, firstConversation.context_id);
    assert.equal(rawTask.kind, "task");
    assert.equal(rawTask.status.state, "completed");
    assert.equal(rawTask.id, firstTask.task_id);
    assert.equal(rawTask.contextId, firstConversation.context_id);
    const statusMessage = rawTask.status?.message;
    assert.ok(statusMessage);
    assert.match(
      readMessageText(statusMessage),
      new RegExp(scenario.expectedResumedFinalText),
    );
    assert.notEqual(resumedTask.task_handle, firstTask.task_handle);
    assert.notEqual(statusTask.task_handle, firstTask.task_handle);
    assert.deepEqual(
      (rawTask.history ?? [])
        .filter((message) => message.role === "user")
        .map(readMessageText),
      [scenario.initialPromptText, scenario.resumedPromptText],
    );
  });
});

describe("cancel semantics", () => {
  let quiescentScenario: QuiescentCancelScenario;
  let liveScenario: LiveCancelScenario;

  before(async () => {
    quiescentScenario = await quiescentCancelScenario();
    liveScenario = await liveCancelScenario();
  });

  after(async () => {
    await Promise.all([quiescentScenario.cleanup(), liveScenario.cleanup()]);
  });

  it("cancel immediately terminates a quiescent input-required task", async () => {
    const firstSend = asSuccess(
      await quiescentScenario.service.execute({
        action: "send",
        target_alias: quiescentScenario.alias,
        parts: [{ kind: "text", text: quiescentScenario.initialPromptText }],
      }),
    );
    const initialTask = taskContinuationFromSummary(firstSend.summary);
    const initialConversation = conversationContinuationFromSummary(firstSend.summary);
    const persistedContinuation = structuredClone(firstSend.summary.continuation);

    if (!persistedContinuation) {
      assert.fail("expected continuation");
    }

    assert.equal(firstSend.action, "send");
    assert.equal(firstSend.summary.response_kind, "task");
    assert.equal(initialTask.status, "input-required");
    assert.match(
      firstSend.summary.message_text ?? "",
      new RegExp(quiescentScenario.expectedPausePromptText),
    );

    const canceled = asSuccess(
      await quiescentScenario.service.execute({
        action: "cancel",
        continuation: persistedContinuation,
      }),
    );
    const canceledTask = taskContinuationFromSummary(canceled.summary);
    const canceledConversation = conversationContinuationFromSummary(canceled.summary);
    const canceledRawTask = canceled.raw as Task;

    assert.equal(canceled.action, "cancel");
    assert.equal(canceled.summary.response_kind, "task");
    assert.equal(canceledTask.task_id, initialTask.task_id);
    assert.equal(canceledTask.status, "canceled");
    assert.equal(canceledTask.can_resume_send, false);
    assert.equal(canceledTask.can_send, false);
    assert.equal(canceledTask.can_cancel, false);
    assert.equal(canceledConversation.context_id, initialConversation.context_id);
    assert.equal(canceledRawTask.kind, "task");
    assert.equal(canceledRawTask.id, initialTask.task_id);
    assert.equal(canceledRawTask.status.state, "canceled");

    const status = asSuccess(
      await quiescentScenario.service.execute({
        action: "status",
        continuation: persistedContinuation,
        history_length: 10,
      }),
    );
    const statusTask = taskContinuationFromSummary(status.summary);
    const statusRawTask = status.raw as Task;

    assert.equal(status.action, "status");
    assert.equal(statusTask.task_id, initialTask.task_id);
    assert.equal(statusTask.status, "canceled");
    assert.equal(statusRawTask.status.state, "canceled");
  });

  it("cancel on a live working task waits for committed cancellation", async () => {
    const firstSend = asSuccess(
      await liveScenario.service.execute({
        action: "send",
        target_alias: liveScenario.alias,
        parts: [{ kind: "text", text: liveScenario.initialPromptText }],
        blocking: false,
      }),
    );
    const initialTask = taskContinuationFromSummary(firstSend.summary);
    const initialConversation = conversationContinuationFromSummary(firstSend.summary);
    const persistedContinuation = structuredClone(firstSend.summary.continuation);

    if (!persistedContinuation) {
      assert.fail("expected continuation");
    }

    const workingStatus = await waitForTaskStatus(
      liveScenario,
      persistedContinuation,
      "working",
    );
    const workingTask = taskContinuationFromSummary(workingStatus.summary);

    assert.equal(firstSend.action, "send");
    assert.equal(firstSend.summary.response_kind, "task");
    assert.equal(workingTask.task_id, initialTask.task_id);
    assert.equal(workingTask.status, "working");

    let cancelResolved = false;
    const cancelPromise = liveScenario.service
      .execute({
        action: "cancel",
        continuation: persistedContinuation,
      })
      .then((result) => {
        cancelResolved = true;
        return result;
      });

    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(cancelResolved, false);

    const pendingStatus = asSuccess(
      await liveScenario.service.execute({
        action: "status",
        continuation: persistedContinuation,
        history_length: 10,
      }),
    );
    const pendingTask = taskContinuationFromSummary(pendingStatus.summary);

    assert.equal(pendingTask.task_id, initialTask.task_id);
    assert.equal(pendingTask.status, "working");

    liveScenario.releaseAfterAbort();

    const canceled = asSuccess(await cancelPromise);
    const canceledTask = taskContinuationFromSummary(canceled.summary);
    const canceledConversation = conversationContinuationFromSummary(canceled.summary);
    const canceledRawTask = canceled.raw as Task;

    assert.equal(canceled.action, "cancel");
    assert.equal(canceled.summary.response_kind, "task");
    assert.equal(canceledTask.task_id, initialTask.task_id);
    assert.equal(canceledTask.status, "canceled");
    assert.equal(canceledTask.can_resume_send, false);
    assert.equal(canceledTask.can_send, false);
    assert.equal(canceledTask.can_cancel, false);
    assert.equal(canceledConversation.context_id, initialConversation.context_id);
    assert.equal(canceledRawTask.kind, "task");
    assert.equal(canceledRawTask.id, initialTask.task_id);
    assert.equal(canceledRawTask.status.state, "canceled");
  });
});

describe("durable watch", () => {
  let scenario: DurableWatchScenario;

  before(async () => {
    scenario = await durableWatchScenario();
  });

  after(async () => {
    await scenario.cleanup();
  });

  it("watch live-tails an owned durable task, then returns one snapshot after inbound restart orphans it", async () => {
    const firstSend = asSuccess(
      await scenario.service.execute({
        action: "send",
        target_alias: scenario.alias,
        parts: [{ kind: "text", text: scenario.initialPromptText }],
        blocking: false,
      }),
    );
    const initialRawTask = firstSend.raw as Task;
    const initialTask = taskContinuationFromSummary(firstSend.summary);
    const initialConversation = conversationContinuationFromSummary(firstSend.summary);
    const persistedContinuation = structuredClone(firstSend.summary.continuation);

    if (!persistedContinuation) {
      assert.fail("expected continuation");
    }

    assert.equal(firstSend.action, "send");
    assert.equal(firstSend.summary.response_kind, "task");
    assert.equal(isTerminalTaskState(initialRawTask.status.state), false);
    assert.equal(initialTask.status, initialRawTask.status.state);
    assert.equal(typeof initialTask.task_handle, "string");
    assert.equal(typeof initialConversation.context_id, "string");

    const liveUpdates: StreamUpdateEnvelope<"watch">[] = [];
    const liveWatchAbortController = new AbortController();
    const liveWatchPromise = scenario.service.execute(
      {
        action: "watch",
        continuation: persistedContinuation,
      },
      {
        signal: liveWatchAbortController.signal,
        onUpdate(update) {
          liveUpdates.push(update as StreamUpdateEnvelope<"watch">);
        },
      },
    );
    void liveWatchPromise.then(
      () => undefined,
      () => undefined,
    );

    await waitForCondition(() => liveUpdates.length >= 1);
    assert.equal(liveUpdates[0]?.action, "watch");
    assert.equal(liveUpdates[0]?.raw.kind, "task");
    assert.equal(
      liveUpdates[0]?.summary.continuation?.task?.task_id,
      initialTask.task_id,
    );
    assert.equal(
      liveUpdates[0]?.summary.continuation?.conversation?.context_id,
      initialConversation.context_id,
    );

    scenario.releaseLiveUpdate();
    await waitForCondition(() =>
      liveUpdates.some(
        (update) =>
          update.raw.kind === "artifact-update" &&
          update.raw.artifact.parts.some(
            (part) => part.kind === "text" && part.text.includes(scenario.expectedToolText),
          ),
      ),
    );

    const liveArtifactUpdate = liveUpdates.find(
      (update) =>
        update.raw.kind === "artifact-update" &&
        update.raw.artifact.parts.some(
          (part) => part.kind === "text" && part.text.includes(scenario.expectedToolText),
        ),
    );

    assert.equal(liveArtifactUpdate?.summary.continuation?.task?.task_id, initialTask.task_id);
    assert.equal(
      liveArtifactUpdate?.summary.continuation?.conversation?.context_id,
      initialConversation.context_id,
    );
    assert.ok(
      liveUpdates.some(
        (update) =>
          update.raw.kind === "artifact-update" &&
          update.raw.artifact.parts.some(
            (part) => part.kind === "text" && part.text.includes(scenario.expectedToolText),
          ),
      ),
    );
    const latestObservedTaskStatus =
      liveUpdates.at(-1)?.summary.continuation?.task?.status ?? initialRawTask.status.state;

    liveWatchAbortController.abort();
    await scenario.restartInbound();

    const restartedService = await scenario.createFreshService();
    const orphanedWatch = asSuccess(
      await restartedService.execute({
        action: "watch",
        continuation: persistedContinuation,
      }),
    );
    const orphanedRaw = asStreamRaw(orphanedWatch.raw);
    const orphanedTask = taskContinuationFromSummary(orphanedWatch.summary);
    const orphanedConversation = conversationContinuationFromSummary(
      orphanedWatch.summary,
    );

    assert.equal(orphanedWatch.action, "watch");
    assert.equal(orphanedWatch.summary.response_kind, "task");
    assert.equal(orphanedRaw.events.length, 1);
    assert.equal(orphanedRaw.events[0]?.kind, "task");
    if (!orphanedRaw.events[0] || orphanedRaw.events[0].kind !== "task") {
      assert.fail("expected single orphaned snapshot");
    }

    assert.equal(orphanedRaw.events[0].id, initialTask.task_id);
    assert.equal(orphanedRaw.events[0].status.state, latestObservedTaskStatus);
    assert.equal(orphanedTask.task_id, initialTask.task_id);
    assert.equal(orphanedConversation.context_id, initialConversation.context_id);
  });

  it("restart waits for orphaned runtime teardown before replacing the inbound runtime", async () => {
    let releaseTeardown!: () => void;
    const teardownGate = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    const delayedScenario = await durableWatchScenario({
      awaitRuntimeTeardown: async () => teardownGate,
    });

    try {
      const firstSend = asSuccess(
        await delayedScenario.service.execute({
          action: "send",
          target_alias: delayedScenario.alias,
          parts: [{ kind: "text", text: delayedScenario.initialPromptText }],
          blocking: false,
        }),
      );
      const persistedContinuation = structuredClone(firstSend.summary.continuation);

      if (!persistedContinuation) {
        assert.fail("expected continuation");
      }

      const restartPromise = delayedScenario.restartInbound();
      const restartState = await Promise.race([
        restartPromise.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => {
          setTimeout(() => resolve("pending"), 25);
        }),
      ]);

      assert.equal(restartState, "pending");
      releaseTeardown();
      await restartPromise;

      const restartedService = await delayedScenario.createFreshService();
      const orphanedWatch = asSuccess(
        await restartedService.execute({
          action: "watch",
          continuation: persistedContinuation,
        }),
      );
      const orphanedRaw = asStreamRaw(orphanedWatch.raw);

      assert.equal(orphanedRaw.events.length, 1);
      assert.equal(orphanedRaw.events[0]?.kind, "task");
    } finally {
      releaseTeardown();
      await delayedScenario.cleanup();
    }
  });
});
