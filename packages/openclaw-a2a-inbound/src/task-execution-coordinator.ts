import type { Message, Part } from "@a2a-js/sdk";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { DEFAULT_OUTPUT_MODES } from "./config.js";
import type {
  A2AInitialResponseMode,
  A2ALiveExecutionRegistry,
} from "./live-execution-registry.js";
import {
  readAcceptedOutputModes,
  readOriginalUserMessage,
} from "./request-context.js";
import {
  buildReplyContent,
  createAgentMessage,
  createContentTypeNotSupportedError,
  createReplyArtifactUpdate,
  createTaskSnapshot,
  createTaskStatusUpdate,
  createToolProgressArtifactUpdate,
  hasReplyPayloadExtras,
  mergeReplyVendorMetadata,
  normalizeReplyPayload,
  summarizeBufferedReplies,
  type BuiltReplyContent,
  type JsonRecord,
  type NormalizedReplyPayload,
  type ReplyVendorMetadata,
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
  sessionKey?: string;
}

type AssistantStage = {
  kind: "assistant";
  index: number;
  blockTexts: string[];
  streamedText?: string;
  finalText?: string;
  mediaUrls: string[];
  vendorMetadata?: ReplyVendorMetadata;
  finalSeen: boolean;
  completed: boolean;
  publishedArtifact: boolean;
  publishedText: string;
  publishedNonTextKey?: string;
  closedPublished: boolean;
  eventMetadata?: JsonRecord;
};

type ToolStage = {
  kind: "tool";
  payload: NormalizedReplyPayload;
  eventMetadata?: JsonRecord;
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

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
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

function extractText(parts: readonly Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

function serializeNonTextParts(parts: readonly Part[]): string {
  return JSON.stringify(parts.filter((part) => part.kind !== "text"));
}

function buildDeltaReplyContent(
  content: BuiltReplyContent,
  deltaText: string,
): BuiltReplyContent {
  const textPart = content.parts.find(
    (part): part is Extract<Part, { kind: "text" }> => part.kind === "text",
  );

  return {
    ...content,
    parts: textPart ? [{ ...textPart, text: deltaText }] : [],
  };
}

function hasAssistantStageActivity(stage: AssistantStage): boolean {
  return (
    stage.blockTexts.length > 0 ||
    typeof stage.streamedText === "string" ||
    typeof stage.finalText === "string" ||
    stage.mediaUrls.length > 0 ||
    typeof stage.vendorMetadata !== "undefined" ||
    stage.finalSeen
  );
}

export class A2ATaskExecutionCoordinator {
  private runId?: string;
  private readonly abortController = new AbortController();
  private readonly responseMode: A2AInitialResponseMode;
  private readonly acceptedOutputModes: string[];
  private readonly stagedOutputs: StagedOutput[] = [];
  private readonly assistantStages: AssistantStage[] = [];
  private currentAssistantStage?: AssistantStage;
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
  private expectedSessionKey?: string;

  constructor(
    private readonly requestContext: RequestContext,
    private readonly eventBus: ExecutionEventBus,
    private readonly liveExecutions: A2ALiveExecutionRegistry,
    expectedSessionKey?: string,
    private readonly onRunIdCaptured?: (runId: string) => void,
  ) {
    this.expectedSessionKey = expectedSessionKey;
    this.responseMode =
      this.liveExecutions.getRequestMode(this.requestContext.userMessage.messageId) ??
      "blocking";
    this.acceptedOutputModes =
      readAcceptedOutputModes(this.requestContext) ?? [...DEFAULT_OUTPUT_MODES];
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  setExpectedSessionKey(sessionKey: string | undefined): void {
    this.expectedSessionKey = readTrimmedString(sessionKey);

    if (this.promoted) {
      this.liveExecutions.update(this.requestContext.taskId, {
        sessionKey: this.expectedSessionKey,
      });
    }
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
    this.captureRunId(runId);
    this.publishWorkingStatus();
  }

  handleAssistantMessageStart(): void {
    this.flushQueuedAssistantArtifact();

    const previous = this.currentAssistantStage;

    if (previous && hasAssistantStageActivity(previous) && !previous.completed) {
      previous.completed = true;
    }

    const nextStage = this.startAssistantStage();

    if (
      previous &&
      previous !== nextStage &&
      this.promoted &&
      !previous.closedPublished
    ) {
      this.publishAssistantStage(previous, {
        lastChunk: true,
        preferTerminalText: true,
        requireVisibleContent: true,
      });
    }
  }

  handleAgentEvent(event: OpenClawExecutionEvent): void {
    if (!this.matchesExpectedSessionKey(event)) {
      return;
    }

    const eventRunId = readTrimmedString(event.runId);

    if (this.runId && eventRunId && eventRunId !== this.runId) {
      return;
    }

    this.captureRunId(eventRunId);
    this.currentAgentEventMetadata = this.buildAgentEventMetadata(event);
    this.publishWorkingStatus();

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
          eventMetadata: this.buildBaseEventMetadata(),
        });
        this.promoteToTask("tool result summaries require task artifacts");
      } else {
        this.publishToolArtifact(
          normalized,
          this.currentAgentEventMetadata ?? this.buildBaseEventMetadata(),
        );
      }

      return;
    }

    this.flushQueuedAssistantArtifact();
    const assistantStage = this.ensureAssistantStageForReply(kind);

    if (kind === "final") {
      assistantStage.finalSeen = true;

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
    assistantStage.vendorMetadata = mergeReplyVendorMetadata(
      assistantStage.vendorMetadata,
      normalized.vendorMetadata,
    );
    assistantStage.eventMetadata = this.buildBaseEventMetadata();

    if (this.promoted) {
      this.publishAssistantStage(assistantStage, {
        lastChunk: false,
        preferTerminalText: kind === "final",
        requireVisibleContent: false,
      });
    }
  }

  async finalizeSuccess(): Promise<void> {
    if (this.finalPublished) {
      return;
    }

    this.flushQueuedAssistantArtifact();

    if (this.cancelRequested || this.signal.aborted) {
      this.promoteToTask("cancellation requires task state");
      this.closeCurrentAssistantStage(false);
      this.publishFinalStatus("canceled", {
        final: true,
        message: this.buildCanonicalAssistantStatusMessage(),
        messageText: "Task cancellation requested by the client.",
      });
      return;
    }

    if (this.lifecycleError) {
      this.promoteToTask("lifecycle error requires failed task");
      this.closeCurrentAssistantStage(false);
      this.publishFinalStatus("failed", {
        final: true,
        message: this.buildCanonicalAssistantStatusMessage(),
        messageText: this.lifecycleError,
      });
      return;
    }

    if (this.pausedForInputRequired) {
      this.liveExecutions.clearRequestMode(this.requestContext.userMessage.messageId);
      return;
    }

    if (this.canReturnDirectMessage()) {
      const directStage = this.currentAssistantStage;
      const directContent = directStage
        ? this.buildAssistantStageContent(directStage, true)
        : undefined;

      if (directContent?.parts.length) {
        this.eventBus.publish(
          createAgentMessage({
            contextId: this.requestContext.contextId,
            parts: directContent.parts,
            metadata: directContent.metadata,
          }),
        );
        this.liveExecutions.clearRequestMode(this.requestContext.userMessage.messageId);
        return;
      }

      if (directContent?.hasCandidates) {
        throw createContentTypeNotSupportedError({
          acceptedOutputModes: this.acceptedOutputModes,
          availableOutputModes: directContent.availableOutputModes,
        });
      }
    }

    this.promoteToTask("terminal response requires task state");
    const publishedAssistant = this.closeCurrentAssistantStage(true);

    this.publishFinalStatus("completed", {
      final: true,
      message: this.buildCanonicalAssistantStatusMessage(),
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
      this.closeCurrentAssistantStage(false);
      this.publishFinalStatus("canceled", {
        final: true,
        message: this.buildCanonicalAssistantStatusMessage(),
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
    this.closeCurrentAssistantStage(false);
    this.publishFinalStatus("failed", {
      final: true,
      message: this.buildCanonicalAssistantStatusMessage(),
      messageText: this.lifecycleError,
    });
  }

  async cancel(): Promise<void> {
    if (this.finalPublished) {
      return;
    }

    this.cancelRequested = true;

    if (this.promoted) {
      this.liveExecutions.update(this.requestContext.taskId, {
        cancelRequested: true,
      });
    }

    if (!this.signal.aborted) {
      this.abortController.abort(
        new DOMException("A2A task canceled.", "AbortError"),
      );
    }

    this.flushQueuedAssistantArtifact();
  }

  private canReturnDirectMessage(): boolean {
    if (
      this.responseMode !== "blocking" ||
      this.requestContext.task ||
      this.promoted ||
      this.cancelRequested ||
      this.finalPublished ||
      this.lifecycleError ||
      this.pausedForInputRequired
    ) {
      return false;
    }

    if (this.stagedOutputs.some((output) => output.kind === "tool")) {
      return false;
    }

    const activeStages = this.assistantStages.filter(hasAssistantStageActivity);
    return activeStages.length === 1;
  }

  private matchesExpectedSessionKey(event: OpenClawExecutionEvent): boolean {
    if (!this.expectedSessionKey) {
      return true;
    }

    const eventSessionKey = readTrimmedString(event.sessionKey);

    if (!eventSessionKey) {
      return true;
    }

    return eventSessionKey === this.expectedSessionKey;
  }

  private captureRunId(runId: string | undefined): void {
    const normalizedRunId = readTrimmedString(runId);

    if (!normalizedRunId || this.runId === normalizedRunId) {
      return;
    }

    if (this.runId) {
      return;
    }

    this.runId = normalizedRunId;
    this.onRunIdCaptured?.(normalizedRunId);

    if (this.promoted) {
      this.liveExecutions.update(this.requestContext.taskId, {
        runId: normalizedRunId,
      });
    }
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
    const mediaUrls = mergeMediaUrls(
      [],
      readStringArray(data.mediaUrls),
    );
    const mediaUrl = readTrimmedString(data.mediaUrl);
    const nextMediaUrls = mediaUrl ? mergeMediaUrls(mediaUrls, [mediaUrl]) : mediaUrls;

    if (!text && nextMediaUrls.length === 0) {
      return;
    }

    const assistantStage = this.ensureAssistantStage();

    if (typeof text === "string") {
      assistantStage.streamedText = normalizeAssistantPreviewText(
        assistantStage.streamedText,
        text,
      );
    }

    assistantStage.mediaUrls = mergeMediaUrls(
      assistantStage.mediaUrls,
      nextMediaUrls,
    );
    assistantStage.eventMetadata =
      this.currentAgentEventMetadata ?? assistantStage.eventMetadata;

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

  private startAssistantStage(): AssistantStage {
    if (this.currentAssistantStage && !this.currentAssistantStage.completed) {
      return this.currentAssistantStage;
    }

    const assistantStage: AssistantStage = {
      kind: "assistant",
      index: this.assistantStages.length + 1,
      blockTexts: [],
      mediaUrls: [],
      finalSeen: false,
      completed: false,
      publishedArtifact: false,
      publishedText: "",
      eventMetadata: this.buildBaseEventMetadata(),
      closedPublished: false,
    };

    this.assistantStages.push(assistantStage);
    this.currentAssistantStage = assistantStage;

    if (!this.promoted) {
      this.stagedOutputs.push(assistantStage);

      if (this.assistantStages.length > 1) {
        this.promoteToTask("multiple assistant messages require task history");
      }
    }

    return assistantStage;
  }

  private ensureAssistantStage(): AssistantStage {
    if (this.currentAssistantStage && !this.currentAssistantStage.completed) {
      return this.currentAssistantStage;
    }

    return this.startAssistantStage();
  }

  private ensureAssistantStageForReply(kind: ReplyDispatchKind): AssistantStage {
    const current = this.currentAssistantStage;

    if (
      current &&
      !current.completed &&
      kind === "final" &&
      current.finalSeen
    ) {
      current.completed = true;

      if (this.promoted && !current.closedPublished) {
        this.publishAssistantStage(current, {
          lastChunk: true,
          preferTerminalText: true,
          requireVisibleContent: true,
        });
      }
    }

    return this.ensureAssistantStage();
  }

  private resolveAssistantPayload(
    stage: AssistantStage,
    preferTerminalText: boolean,
  ): NormalizedReplyPayload {
    const text = preferTerminalText
      ? pickAssistantText(
          stage.finalText,
          stage.streamedText,
          summarizeBufferedReplies(stage.blockTexts),
        )
      : pickAssistantText(
          stage.streamedText,
          stage.finalText,
          summarizeBufferedReplies(stage.blockTexts),
        );

    return {
      ...(text ? { text } : {}),
      mediaUrls: stage.mediaUrls,
      ...(stage.vendorMetadata ? { vendorMetadata: stage.vendorMetadata } : {}),
    };
  }

  private buildAssistantStageContent(
    stage: AssistantStage,
    preferTerminalText: boolean,
  ): BuiltReplyContent {
    return buildReplyContent({
      payload: this.resolveAssistantPayload(stage, preferTerminalText),
      acceptedOutputModes: this.acceptedOutputModes,
    });
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
      sessionKey: this.expectedSessionKey,
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

    return [readOriginalUserMessage(this.requestContext)];
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
      message?: Message;
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
        message: params.message,
        messageText:
          params.message ? undefined : params.messageText,
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
        this.publishToolArtifact(
          output.payload,
          output.eventMetadata ?? this.buildBaseEventMetadata(),
        );
        continue;
      }

      this.publishAssistantStage(output, {
        lastChunk: output.completed,
        preferTerminalText: output.completed,
        requireVisibleContent: output.completed,
      });
    }

    this.stagedOutputs.length = 0;
  }

  private publishAssistantStage(
    stage: AssistantStage,
    params: {
      lastChunk: boolean;
      preferTerminalText: boolean;
      requireVisibleContent: boolean;
    },
  ): boolean {
    if (!this.promoted) {
      return false;
    }

    const content = this.buildAssistantStageContent(
      stage,
      params.preferTerminalText,
    );

    if (content.parts.length === 0) {
      if (params.requireVisibleContent && !stage.publishedArtifact && content.hasCandidates) {
        throw createContentTypeNotSupportedError({
          acceptedOutputModes: this.acceptedOutputModes,
          availableOutputModes: content.availableOutputModes,
        });
      }

      if (params.lastChunk && stage.publishedArtifact && !stage.closedPublished) {
        this.eventBus.publish(
          createReplyArtifactUpdate({
            taskId: this.requestContext.taskId,
            contextId: this.requestContext.contextId,
            artifactId: this.assistantArtifactId(stage.index),
            name: `assistant-output-${stage.index}`,
            sequence: this.nextArtifactSequence(),
            eventMetadata: stage.eventMetadata ?? this.buildBaseEventMetadata(),
            content: {
              ...content,
              parts: [],
            },
            append: true,
            lastChunk: true,
          }),
        );
        stage.closedPublished = true;
      }

      return stage.publishedArtifact;
    }

    const nextText = extractText(content.parts);
    const nextNonTextKey = serializeNonTextParts(content.parts);

    if (
      stage.publishedArtifact &&
      nextText.startsWith(stage.publishedText) &&
      nextNonTextKey === stage.publishedNonTextKey
    ) {
      const deltaText = nextText.slice(stage.publishedText.length);

      if (deltaText.length > 0) {
        this.eventBus.publish(
          createReplyArtifactUpdate({
            taskId: this.requestContext.taskId,
            contextId: this.requestContext.contextId,
            artifactId: this.assistantArtifactId(stage.index),
            name: `assistant-output-${stage.index}`,
            sequence: this.nextArtifactSequence(),
            eventMetadata: stage.eventMetadata ?? this.buildBaseEventMetadata(),
            content: buildDeltaReplyContent(content, deltaText),
            append: true,
            lastChunk: params.lastChunk,
          }),
        );
        stage.closedPublished = params.lastChunk;
      } else if (params.lastChunk && !stage.closedPublished) {
        this.eventBus.publish(
          createReplyArtifactUpdate({
            taskId: this.requestContext.taskId,
            contextId: this.requestContext.contextId,
            artifactId: this.assistantArtifactId(stage.index),
            name: `assistant-output-${stage.index}`,
            sequence: this.nextArtifactSequence(),
            eventMetadata: stage.eventMetadata ?? this.buildBaseEventMetadata(),
            content: {
              ...content,
              parts: [],
            },
            append: true,
            lastChunk: true,
          }),
        );
        stage.closedPublished = true;
      }
    } else {
      this.eventBus.publish(
        createReplyArtifactUpdate({
          taskId: this.requestContext.taskId,
          contextId: this.requestContext.contextId,
          artifactId: this.assistantArtifactId(stage.index),
          name: `assistant-output-${stage.index}`,
          sequence: this.nextArtifactSequence(),
          eventMetadata: stage.eventMetadata ?? this.buildBaseEventMetadata(),
          content,
          lastChunk: params.lastChunk,
        }),
      );
      stage.closedPublished = params.lastChunk;
    }

    stage.publishedArtifact = true;
    stage.publishedText = nextText;
    stage.publishedNonTextKey = nextNonTextKey;
    return true;
  }

  private publishToolArtifact(
    payload: NormalizedReplyPayload,
    eventMetadata?: JsonRecord,
  ): void {
    const content = buildReplyContent({
      payload,
      acceptedOutputModes: this.acceptedOutputModes,
    });

    if (content.parts.length === 0) {
      if (content.hasCandidates) {
        throw createContentTypeNotSupportedError({
          acceptedOutputModes: this.acceptedOutputModes,
          availableOutputModes: content.availableOutputModes,
        });
      }

      return;
    }

    this.toolArtifactCount += 1;

    this.eventBus.publish(
      createReplyArtifactUpdate({
        taskId: this.requestContext.taskId,
        contextId: this.requestContext.contextId,
        artifactId: `tool-result-${String(this.toolArtifactCount).padStart(4, "0")}`,
        name: `tool-result-${this.toolArtifactCount}`,
        sequence: this.nextArtifactSequence(),
        eventMetadata: eventMetadata ?? this.buildBaseEventMetadata(),
        content,
      }),
    );
  }

  private buildCanonicalAssistantStatusMessage(): Message | undefined {
    const stages = [...this.assistantStages].reverse();

    for (const stage of stages) {
      const content = this.buildAssistantStageContent(stage, true);

      if (content.parts.length === 0) {
        continue;
      }

      return createAgentMessage({
        contextId: this.requestContext.contextId,
        taskId: this.requestContext.taskId,
        parts: content.parts,
        metadata: content.metadata,
      });
    }

    return undefined;
  }

  private closeCurrentAssistantStage(requireVisibleContent: boolean): boolean {
    const stage = this.currentAssistantStage;

    if (!stage) {
      return false;
    }

    stage.completed = true;
    return this.publishAssistantStage(stage, {
      lastChunk: true,
      preferTerminalText: true,
      requireVisibleContent,
    });
  }

  private assistantArtifactId(index: number): string {
    return `assistant-output-${String(index).padStart(4, "0")}`;
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
      const currentStage = this.currentAssistantStage;

      if (!currentStage) {
        return;
      }

      this.publishAssistantStage(currentStage, {
        lastChunk: false,
        preferTerminalText: false,
        requireVisibleContent: false,
      });
    });
  }

  private flushQueuedAssistantArtifact(): void {
    if (!this.assistantFlushQueued || this.finalPublished) {
      return;
    }

    this.assistantFlushQueued = false;
    const currentStage = this.currentAssistantStage;

    if (!currentStage) {
      return;
    }

    this.publishAssistantStage(currentStage, {
      lastChunk: false,
      preferTerminalText: false,
      requireVisibleContent: false,
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
