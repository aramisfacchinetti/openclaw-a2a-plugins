import type { Message } from "@a2a-js/sdk";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type {
  A2AInitialResponseMode,
  A2ALiveExecutionRegistry,
} from "./live-execution-registry.js";
import {
  createAgentTextMessage,
  createReplyArtifactUpdate,
  createTaskSnapshot,
  createTaskStatusUpdate,
  createToolProgressArtifactUpdate,
  hasReplyPayloadExtras,
  normalizeReplyPayload,
  summarizeBufferedReplies,
  type JsonRecord,
  type NormalizedReplyPayload,
  type ToolProgressPhase,
} from "./response-mapping.js";

type ReplyDispatchKind = "tool" | "block" | "final";
type LifecyclePhase = "start" | "end" | "error";
const INPUT_REQUIRED_APPROVAL_MESSAGE =
  "OpenClaw is waiting for tool approval to continue.";

export interface OpenClawExecutionEvent {
  runId: string;
  stream: string;
  data: Record<string, unknown>;
  seq?: number;
  ts?: number;
}

type AssistantStage = {
  kind: "assistant";
  blockTexts: string[];
  streamedText?: string;
  finalText?: string;
  mediaUrls: string[];
  channelData?: JsonRecord;
  isError: boolean;
  finalCount: number;
  publishedText?: string;
  publishedExtrasKey?: string;
  eventMetadata?: JsonRecord;
};

type ToolStage = {
  kind: "tool";
  payload: NormalizedReplyPayload;
};

type StagedOutput = AssistantStage | ToolStage;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneMessageHistory(history: readonly Message[] | undefined): Message[] | undefined {
  return history ? (structuredClone(history) as Message[]) : undefined;
}

function mergeMediaUrls(
  current: readonly string[],
  next: readonly string[],
): string[] {
  return Array.from(new Set([...current, ...next]));
}

function stringifyPayloadExtras(payload: NormalizedReplyPayload): string {
  return JSON.stringify({
    mediaUrls: payload.mediaUrls,
    channelData: payload.channelData ?? null,
    isError: payload.isError,
  });
}

function pickAssistantText(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function readOptionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : [];
}

function readToolProgressPhase(value: unknown): ToolProgressPhase | undefined {
  return value === "start" || value === "update" || value === "result"
    ? value
    : undefined;
}

function readToolName(data: Record<string, unknown>): string | undefined {
  const rawName =
    typeof data.toolName === "string"
      ? data.toolName
      : typeof data.name === "string"
        ? data.name
        : undefined;

  return rawName && rawName.trim().length > 0 ? rawName.trim() : undefined;
}

function readToolCallId(data: Record<string, unknown>): string | undefined {
  return typeof data.toolCallId === "string" && data.toolCallId.trim().length > 0
    ? data.toolCallId.trim()
    : undefined;
}

function readApprovalPauseMessage(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const status = typeof result.status === "string" ? result.status : undefined;
  const requiresApproval = isRecord(result.requiresApproval)
    ? result.requiresApproval
    : undefined;
  const explicitApproval =
    status === "approval-pending" ||
    status === "needs_approval" ||
    requiresApproval?.type === "approval_request";

  if (!explicitApproval) {
    return undefined;
  }

  const prompt =
    typeof requiresApproval?.prompt === "string" &&
    requiresApproval.prompt.trim().length > 0
      ? requiresApproval.prompt.trim()
      : undefined;

  return prompt ?? INPUT_REQUIRED_APPROVAL_MESSAGE;
}

function normalizeAssistantPreviewText(
  currentPreview: string | undefined,
  incomingText: string,
): string {
  const previousPreview = currentPreview ?? "";

  if (
    previousPreview.length > 0 &&
    incomingText.startsWith(previousPreview)
  ) {
    return incomingText;
  }

  return `${previousPreview}${incomingText}`;
}

export class A2ATaskExecutionCoordinator {
  private runId?: string;
  private readonly abortController = new AbortController();
  private readonly responseMode: A2AInitialResponseMode;
  private readonly stagedOutputs: StagedOutput[] = [];
  private assistantStage?: AssistantStage;
  private assistantMessageStarts = 0;
  private artifactSequence = 0;
  private toolArtifactCount = 0;
  private taskPublished = false;
  private submittedPublished = false;
  private workingPublished = false;
  private finalPublished = false;
  private promoted = false;
  private cancelRequested = false;
  private lifecyclePhase?: LifecyclePhase;
  private lifecycleError?: string;
  private pausedForInputRequired = false;
  private inputRequiredPublished = false;
  private assistantFlushQueued = false;
  private assistantFlushScheduled = false;
  private currentAgentEventMetadata?: JsonRecord;

  constructor(
    private readonly requestContext: RequestContext,
    private readonly eventBus: ExecutionEventBus,
    private readonly liveExecutions: A2ALiveExecutionRegistry,
  ) {
    this.responseMode =
      this.liveExecutions.getRequestMode(this.requestContext.userMessage.messageId) ??
      "blocking";
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  prepareForExecution(): void {
    if (this.requestContext.task) {
      this.promoteToTask("continuing existing task");
      return;
    }

    if (
      this.responseMode === "streaming" ||
      this.responseMode === "non_blocking"
    ) {
      this.promoteToTask(
        `${this.responseMode} mode always starts as a task`,
      );
    }
  }

  handleAgentRunStart(runId: string): void {
    this.runId = runId;

    if (this.promoted) {
      this.liveExecutions.update(this.requestContext.taskId, { runId });
      this.publishWorkingStatus();
    }
  }

  handleAssistantMessageStart(): void {
    this.assistantMessageStarts += 1;

    if (this.assistantMessageStarts > 1 && !this.promoted) {
      this.promoteToTask("multiple assistant messages require task history");
    }
  }

  handleAgentEvent(event: OpenClawExecutionEvent): void {
    if (this.runId && event.runId !== this.runId) {
      return;
    }

    this.currentAgentEventMetadata = this.buildAgentEventMetadata(event);

    try {
      if (event.stream === "lifecycle") {
        this.handleLifecycleEvent(event.data);
        return;
      }

      if (event.stream === "assistant") {
        this.handleAssistantEvent(event.data);
        return;
      }

      if (event.stream === "tool") {
        this.handleToolEvent(event.data);
      }
    } finally {
      this.currentAgentEventMetadata = undefined;
    }
  }

  handleReplyPayload(payload: unknown, kind: ReplyDispatchKind): void {
    const normalized = normalizeReplyPayload(payload);

    if (kind === "tool") {
      this.flushQueuedAssistantArtifact();

      if (!this.promoted) {
        this.stagedOutputs.push({
          kind: "tool",
          payload: normalized,
        });
        this.promoteToTask("tool result summaries require task artifacts");
      } else {
        this.publishToolArtifact(normalized);
      }

      return;
    }

    this.flushQueuedAssistantArtifact();
    const assistantStage = this.ensureAssistantStage();

    if (kind === "final") {
      assistantStage.finalCount += 1;

      if (normalized.text) {
        assistantStage.finalText = normalized.text;
      }
    } else if (normalized.text) {
      assistantStage.blockTexts.push(normalized.text);
    }

    assistantStage.mediaUrls = mergeMediaUrls(
      assistantStage.mediaUrls,
      normalized.mediaUrls,
    );
    assistantStage.channelData = normalized.channelData ?? assistantStage.channelData;
    assistantStage.isError = assistantStage.isError || normalized.isError;
    assistantStage.eventMetadata = this.buildBaseEventMetadata();

    if (!this.promoted) {
      if (assistantStage.finalCount > 1) {
        this.promoteToTask("multiple terminal replies require task artifacts");
        return;
      }

      if (hasReplyPayloadExtras(normalized)) {
        this.promoteToTask("non-text reply payloads require task artifacts");
        return;
      }

      return;
    }

    this.publishAssistantArtifact({
      lastChunk: false,
      preferTerminalText: kind === "final",
    });
  }

  async finalizeSuccess(): Promise<void> {
    if (this.finalPublished) {
      return;
    }

    this.flushQueuedAssistantArtifact();

    if (this.cancelRequested) {
      this.promoteToTask("cancellation requires task state");
      this.publishFinalStatus("canceled", {
        final: true,
        messageText: "Task cancellation requested by the client.",
      });
      return;
    }

    if (this.lifecycleError) {
      this.promoteToTask("lifecycle error requires failed task");
      this.publishAssistantArtifact({
        lastChunk: true,
        preferTerminalText: true,
      });
      this.publishFinalStatus("failed", {
        final: true,
        messageText: this.lifecycleError,
      });
      return;
    }

    if (this.pausedForInputRequired) {
      this.liveExecutions.clearRequestMode(this.requestContext.userMessage.messageId);
      return;
    }

    if (this.canReturnDirectMessage()) {
      const directText = this.resolveAssistantPayload(true).text;

      if (directText) {
        this.eventBus.publish(
          createAgentTextMessage({
            contextId: this.requestContext.contextId,
            text: directText,
          }),
        );
        this.liveExecutions.clearRequestMode(this.requestContext.userMessage.messageId);
        return;
      }
    }

    this.promoteToTask("terminal response requires task state");
    const publishedAssistant = this.publishAssistantArtifact({
      lastChunk: true,
      preferTerminalText: true,
    });

    this.publishFinalStatus("completed", {
      final: true,
      messageText: publishedAssistant
        ? undefined
        : "OpenClaw completed without a user-visible terminal reply.",
    });
  }

  async finalizeError(error: unknown): Promise<void> {
    if (this.finalPublished) {
      return;
    }

    this.flushQueuedAssistantArtifact();

    if (this.cancelRequested || this.signal.aborted) {
      this.promoteToTask("cancellation requires task state");
      this.publishFinalStatus("canceled", {
        final: true,
        messageText: "Task cancellation requested by the client.",
      });
      return;
    }

    const errorText =
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error);

    this.lifecycleError = this.lifecycleError ?? errorText;
    this.promoteToTask("execution error requires failed task");
    this.publishAssistantArtifact({
      lastChunk: true,
      preferTerminalText: true,
    });
    this.publishFinalStatus("failed", {
      final: true,
      messageText: this.lifecycleError,
    });
  }

  async cancel(): Promise<void> {
    if (this.finalPublished) {
      return;
    }

    this.cancelRequested = true;
    this.abortController.abort(
      new DOMException("A2A task canceled.", "AbortError"),
    );
    this.promoteToTask("task cancellation requested");
    this.flushQueuedAssistantArtifact();
    this.publishFinalStatus("canceled", {
      final: true,
      messageText: "Task cancellation requested by the client.",
    });
  }

  private canReturnDirectMessage(): boolean {
    if (this.responseMode === "streaming" || this.requestContext.task) {
      return false;
    }

    if (this.promoted || this.cancelRequested || this.finalPublished) {
      return false;
    }

    if (this.lifecycleError || this.assistantMessageStarts > 1) {
      return false;
    }

    if (this.stagedOutputs.some((output) => output.kind === "tool")) {
      return false;
    }

    const payload = this.resolveAssistantPayload(true);

    if (!payload.text || hasReplyPayloadExtras(payload)) {
      return false;
    }

    return true;
  }

  private handleLifecycleEvent(data: Record<string, unknown>): void {
    const phase =
      typeof data.phase === "string" ? (data.phase as LifecyclePhase) : undefined;

    if (!phase) {
      return;
    }

    this.lifecyclePhase = phase;

    if (phase === "start") {
      this.publishWorkingStatus();
      return;
    }

    if (phase === "error") {
      this.lifecycleError =
        typeof data.error === "string" && data.error.trim().length > 0
          ? data.error.trim()
          : "OpenClaw ended the run with a lifecycle error.";
      this.promoteToTask("lifecycle error requires task state");
      this.flushQueuedAssistantArtifact();
    }
  }

  private handleAssistantEvent(data: Record<string, unknown>): void {
    const text = readOptionalText(data.text) ?? readOptionalText(data.delta);
    const mediaUrls = readStringArray(data.mediaUrls);

    if (!text && mediaUrls.length === 0) {
      return;
    }

    const assistantStage = this.ensureAssistantStage();

    if (typeof text === "string") {
      assistantStage.streamedText = normalizeAssistantPreviewText(
        assistantStage.streamedText,
        text,
      );
    }

    assistantStage.mediaUrls = mergeMediaUrls(assistantStage.mediaUrls, mediaUrls);
    assistantStage.eventMetadata =
      this.currentAgentEventMetadata ?? assistantStage.eventMetadata;

    if (!this.promoted && mediaUrls.length > 0) {
      this.promoteToTask("assistant media output requires task artifacts");
      return;
    }

    if (this.promoted) {
      this.queueAssistantArtifactFlush();
    }
  }

  private handleToolEvent(data: Record<string, unknown>): void {
    const phase = readToolProgressPhase(data.phase);
    const toolName = readToolName(data);
    const toolCallId = readToolCallId(data);

    if (!phase || !toolName || !toolCallId) {
      return;
    }

    if (!this.promoted) {
      this.promoteToTask("tool progress requires task artifacts");
    }

    if (!this.promoted) {
      return;
    }

    this.flushQueuedAssistantArtifact();
    this.eventBus.publish(
      createToolProgressArtifactUpdate({
        taskId: this.requestContext.taskId,
        contextId: this.requestContext.contextId,
        toolName,
        toolCallId,
        phase,
        payload: data,
        sequence: this.nextArtifactSequence(),
        eventMetadata: this.currentAgentEventMetadata ?? this.buildBaseEventMetadata(),
        isError: phase === "result" && data.isError === true,
      }),
    );

    if (phase === "result" && data.isError !== true) {
      const approvalPauseMessage = readApprovalPauseMessage(data.result);

      if (approvalPauseMessage) {
        this.publishInputRequiredStatus(approvalPauseMessage);
      }
    }
  }

  private ensureAssistantStage(): AssistantStage {
    if (this.assistantStage) {
      return this.assistantStage;
    }

    this.assistantStage = {
      kind: "assistant",
      blockTexts: [],
      mediaUrls: [],
      isError: false,
      finalCount: 0,
      eventMetadata: this.buildBaseEventMetadata(),
    };

    if (!this.promoted) {
      this.stagedOutputs.push(this.assistantStage);
    }

    return this.assistantStage;
  }

  private resolveAssistantPayload(preferTerminalText: boolean): NormalizedReplyPayload {
    const assistantStage = this.assistantStage;
    const text = preferTerminalText
      ? pickAssistantText(
          assistantStage?.finalText,
          assistantStage?.streamedText,
          summarizeBufferedReplies(assistantStage?.blockTexts ?? []),
        )
      : pickAssistantText(
          assistantStage?.streamedText,
          assistantStage?.finalText,
          summarizeBufferedReplies(assistantStage?.blockTexts ?? []),
        );

    return {
      text,
      mediaUrls: assistantStage?.mediaUrls ?? [],
      channelData: assistantStage?.channelData,
      isError: assistantStage?.isError ?? false,
    };
  }

  private promoteToTask(_reason: string): void {
    if (this.promoted) {
      return;
    }

    this.promoted = true;
    this.taskPublished = true;
    this.liveExecutions.activate({
      taskId: this.requestContext.taskId,
      contextId: this.requestContext.contextId,
      abortController: this.abortController,
      runId: this.runId,
      cancel: async () => this.cancel(),
    });

    this.eventBus.publish(
      createTaskSnapshot({
        taskId: this.requestContext.taskId,
        contextId: this.requestContext.contextId,
        state: "submitted",
        history: this.buildInitialHistory(),
        artifacts: this.requestContext.task?.artifacts
          ? structuredClone(this.requestContext.task.artifacts)
          : undefined,
        metadata: this.buildTaskMetadata(),
      }),
    );
    this.publishSubmittedStatus();
    this.publishWorkingStatus();
    this.flushStagedOutputs();
  }

  private buildInitialHistory(): Message[] {
    const existingHistory = cloneMessageHistory(this.requestContext.task?.history);

    if (existingHistory) {
      return existingHistory;
    }

    return [structuredClone(this.requestContext.userMessage)];
  }

  private buildTaskMetadata(): JsonRecord | undefined {
    const metadata = this.requestContext.task?.metadata
      ? structuredClone(this.requestContext.task.metadata)
      : {};

    if (!this.runId) {
      return Object.keys(metadata).length > 0 ? metadata : undefined;
    }

    metadata.openclaw = {
      ...(typeof metadata.openclaw === "object" &&
      metadata.openclaw !== null &&
      !Array.isArray(metadata.openclaw)
        ? (metadata.openclaw as JsonRecord)
        : {}),
      runId: this.runId,
    };

    return metadata;
  }

  private publishSubmittedStatus(): void {
    if (this.submittedPublished || !this.taskPublished || this.finalPublished) {
      return;
    }

    this.submittedPublished = true;
    this.eventBus.publish(
      createTaskStatusUpdate({
        taskId: this.requestContext.taskId,
        contextId: this.requestContext.contextId,
        state: "submitted",
        metadata: this.buildBaseEventMetadata(),
      }),
    );
  }

  private publishWorkingStatus(): void {
    if (!this.promoted || this.workingPublished || this.finalPublished) {
      return;
    }

    if (this.lifecyclePhase !== "start" && !this.runId) {
      return;
    }

    this.workingPublished = true;
    this.eventBus.publish(
      createTaskStatusUpdate({
        taskId: this.requestContext.taskId,
        contextId: this.requestContext.contextId,
        state: "working",
        metadata: this.currentAgentEventMetadata ?? this.buildBaseEventMetadata(),
      }),
    );
  }

  private publishInputRequiredStatus(messageText: string): void {
    if (this.finalPublished || this.inputRequiredPublished) {
      return;
    }

    if (!this.taskPublished) {
      this.promoteToTask("approval pause requires task state");
    }

    this.pausedForInputRequired = true;
    this.inputRequiredPublished = true;
    this.eventBus.publish(
      createTaskStatusUpdate({
        taskId: this.requestContext.taskId,
        contextId: this.requestContext.contextId,
        state: "input-required",
        final: false,
        messageText,
        metadata: this.currentAgentEventMetadata ?? this.buildBaseEventMetadata(),
      }),
    );
    this.liveExecutions.cleanup(this.requestContext.taskId);
    this.liveExecutions.clearRequestMode(this.requestContext.userMessage.messageId);
  }

  private publishFinalStatus(
    state: "completed" | "failed" | "canceled",
    params: {
      final: boolean;
      messageText?: string;
    },
  ): void {
    if (this.finalPublished) {
      return;
    }

    if (!this.taskPublished) {
      this.promoteToTask("terminal task state requires a task snapshot");
    }

    this.finalPublished = true;
    this.liveExecutions.markTerminal(this.requestContext.taskId, state);
    this.liveExecutions.cleanup(this.requestContext.taskId);
    this.liveExecutions.clearRequestMode(this.requestContext.userMessage.messageId);
    this.eventBus.publish(
      createTaskStatusUpdate({
        taskId: this.requestContext.taskId,
        contextId: this.requestContext.contextId,
        state,
        final: params.final,
        messageText: params.messageText,
        metadata: this.buildBaseEventMetadata(),
      }),
    );
  }

  private flushStagedOutputs(): void {
    if (!this.promoted) {
      return;
    }

    for (const output of this.stagedOutputs) {
      if (output.kind === "tool") {
        this.publishToolArtifact(output.payload);
      }
    }

    this.publishAssistantArtifact({
      lastChunk: false,
      preferTerminalText: true,
    });
    this.stagedOutputs.length = 0;
  }

  private publishAssistantArtifact(params: {
    lastChunk: boolean;
    preferTerminalText: boolean;
  }): boolean {
    if (!this.promoted) {
      return false;
    }

    const assistantStage = this.ensureAssistantStage();
    const payload = this.resolveAssistantPayload(params.preferTerminalText);
    const nextText = payload.text ?? "";
    const publishedText = assistantStage.publishedText;
    const hasPublishedArtifact = typeof publishedText === "string";
    const hasPayloadContent =
      nextText.length > 0 || hasReplyPayloadExtras(payload);

    if (!hasPayloadContent && !(params.lastChunk && hasPublishedArtifact)) {
      return false;
    }

    const nextExtrasKey = stringifyPayloadExtras(payload);
    const publishedExtrasKey = assistantStage.publishedExtrasKey;
    const extrasChanged = nextExtrasKey !== publishedExtrasKey;

    if (hasPublishedArtifact && nextText.startsWith(publishedText)) {
      const delta = nextText.slice(publishedText.length);

      if (delta.length > 0 || extrasChanged || params.lastChunk) {
        this.eventBus.publish(
          createReplyArtifactUpdate({
            taskId: this.requestContext.taskId,
            contextId: this.requestContext.contextId,
            artifactId: "assistant-output",
            name: "assistant",
            sequence: this.nextArtifactSequence(),
            eventMetadata:
              assistantStage.eventMetadata ?? this.buildBaseEventMetadata(),
            payload: {
              text: delta.length > 0 ? delta : undefined,
              mediaUrls: extrasChanged ? payload.mediaUrls : [],
              channelData: extrasChanged ? payload.channelData : undefined,
              isError: extrasChanged ? payload.isError : false,
            },
            append: true,
            lastChunk: params.lastChunk,
          }),
        );
      }
    } else if (
      !hasPublishedArtifact ||
      nextText !== publishedText ||
      extrasChanged
    ) {
      this.eventBus.publish(
        createReplyArtifactUpdate({
          taskId: this.requestContext.taskId,
          contextId: this.requestContext.contextId,
          artifactId: "assistant-output",
          name: "assistant",
          sequence: this.nextArtifactSequence(),
          eventMetadata:
            assistantStage.eventMetadata ?? this.buildBaseEventMetadata(),
          payload,
          lastChunk: params.lastChunk,
        }),
      );
    } else if (params.lastChunk) {
      this.eventBus.publish(
        createReplyArtifactUpdate({
          taskId: this.requestContext.taskId,
          contextId: this.requestContext.contextId,
          artifactId: "assistant-output",
          name: "assistant",
          sequence: this.nextArtifactSequence(),
          eventMetadata:
            assistantStage.eventMetadata ?? this.buildBaseEventMetadata(),
          payload: {
            mediaUrls: [],
            isError: false,
          },
          append: true,
          lastChunk: true,
        }),
      );
    }

    assistantStage.publishedText = nextText;
    assistantStage.publishedExtrasKey = nextExtrasKey;
    return true;
  }

  private publishToolArtifact(payload: NormalizedReplyPayload): void {
    this.toolArtifactCount += 1;

    this.eventBus.publish(
      createReplyArtifactUpdate({
        taskId: this.requestContext.taskId,
        contextId: this.requestContext.contextId,
        artifactId: `tool-result-${String(this.toolArtifactCount).padStart(4, "0")}`,
        name: `tool-result-${this.toolArtifactCount}`,
        sequence: this.nextArtifactSequence(),
        eventMetadata: this.buildBaseEventMetadata(),
        payload,
      }),
    );
  }

  private nextArtifactSequence(): number {
    this.artifactSequence += 1;
    return this.artifactSequence;
  }

  private queueAssistantArtifactFlush(): void {
    if (!this.promoted) {
      return;
    }

    this.assistantFlushQueued = true;

    if (this.assistantFlushScheduled) {
      return;
    }

    this.assistantFlushScheduled = true;
    queueMicrotask(() => {
      this.assistantFlushScheduled = false;

      if (!this.assistantFlushQueued || this.finalPublished) {
        return;
      }

      this.assistantFlushQueued = false;
      this.publishAssistantArtifact({
        lastChunk: false,
        preferTerminalText: false,
      });
    });
  }

  private flushQueuedAssistantArtifact(): void {
    if (!this.assistantFlushQueued || this.finalPublished) {
      return;
    }

    this.assistantFlushQueued = false;
    this.publishAssistantArtifact({
      lastChunk: false,
      preferTerminalText: false,
    });
  }

  private buildAgentEventMetadata(event: OpenClawExecutionEvent): JsonRecord | undefined {
    const openclaw: JsonRecord = {};

    if (this.runId ?? event.runId) {
      openclaw.runId = this.runId ?? event.runId;
    }

    if (typeof event.seq === "number" && Number.isInteger(event.seq)) {
      openclaw.agentEventSeq = event.seq;
    }

    if (typeof event.ts === "number" && Number.isFinite(event.ts)) {
      openclaw.agentEventTs = event.ts;
    }

    return Object.keys(openclaw).length > 0 ? { openclaw } : undefined;
  }

  private buildBaseEventMetadata(): JsonRecord | undefined {
    if (!this.runId) {
      return undefined;
    }

    return {
      openclaw: {
        runId: this.runId,
      },
    };
  }
}
