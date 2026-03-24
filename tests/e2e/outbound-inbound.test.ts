import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type {
  A2AToolResult,
  StreamUpdateEnvelope,
  SuccessEnvelope,
} from "../../packages/openclaw-a2a-outbound/src/result-shape.js";
import type { TargetCatalogEntry } from "../../packages/openclaw-a2a-outbound/src/target-catalog.js";
import {
  directReplyScenario,
  persistedContinuationScenario,
  promotedStreamingScenario,
  type DirectReplyScenario,
  type PersistedContinuationScenario,
  type PromotedStreamingScenario,
} from "./outbound-inbound-harness.js";

function asSuccess(result: A2AToolResult): SuccessEnvelope {
  if (result.ok !== true) {
    throw new TypeError("expected success result");
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

describe("persisted continuation", () => {
  let scenario: PersistedContinuationScenario;

  before(async () => {
    scenario = await persistedContinuationScenario();
  });

  after(async () => {
    await scenario.cleanup();
  });

  it("round-trips persisted summary.continuation through send and status against the real inbound server", async () => {
    const firstSend = asSuccess(
      await scenario.service.execute({
        action: "send",
        target_alias: scenario.alias,
        parts: [{ kind: "text", text: "Please request approval first." }],
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

    const resumedSend = asSuccess(
      await scenario.service.execute({
        action: "send",
        continuation: persistedContinuation,
        parts: [{ kind: "text", text: "Approved. Continue and finish." }],
      }),
    );
    const resumedTask = taskContinuationFromSummary(resumedSend.summary);
    const resumedConversation = conversationContinuationFromSummary(resumedSend.summary);

    assert.equal(resumedSend.action, "send");
    assert.equal(resumedSend.summary.response_kind, "task");
    assert.equal(resumedTask.task_id, firstTask.task_id);
    assert.equal(resumedTask.task_handle, firstTask.task_handle);
    assert.equal(resumedTask.status, "completed");
    assert.equal(resumedConversation.context_id, firstConversation.context_id);
    assert.match(
      resumedSend.summary.message_text ?? "",
      new RegExp(scenario.expectedResumedFinalText),
    );

    const status = asSuccess(
      await scenario.service.execute({
        action: "status",
        continuation: persistedContinuation,
      }),
    );
    const statusTask = taskContinuationFromSummary(status.summary);
    const statusConversation = conversationContinuationFromSummary(status.summary);
    const rawTask = status.raw as Task;

    assert.equal(status.action, "status");
    assert.equal(status.summary.response_kind, "task");
    assert.equal(statusTask.task_id, firstTask.task_id);
    assert.equal(statusTask.task_handle, firstTask.task_handle);
    assert.equal(statusTask.status, "completed");
    assert.equal(statusConversation.context_id, firstConversation.context_id);
    assert.equal(rawTask.kind, "task");
    assert.equal(rawTask.status.state, "completed");
    assert.equal(rawTask.id, firstTask.task_id);
    assert.equal(rawTask.contextId, firstConversation.context_id);
    assert.match(
      readMessageText(rawTask.status.message),
      new RegExp(scenario.expectedResumedFinalText),
    );
    assert.deepEqual(status.summary.continuation?.task, resumedSend.summary.continuation?.task);
    assert.deepEqual(
      status.summary.continuation?.conversation,
      resumedSend.summary.continuation?.conversation,
    );
  });
});
