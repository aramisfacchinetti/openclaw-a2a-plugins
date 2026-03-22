import type {
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskQueryParams,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { isDeepStrictEqual } from "node:util";
import { UnsupportedOperationError } from "@a2a-js/sdk/client";
import {
  evaluateSendCompatibility,
  type CapabilityDiagnostics,
} from "./capability-diagnostics.js";
import {
  parseA2AOutboundPluginConfig,
  type A2AOutboundPluginConfig,
} from "./config.js";
import {
  type A2AOutboundErrorCode,
  A2AOutboundError,
  ERROR_CODES,
  type ToolError,
  toToolError,
} from "./errors.js";
import { log, startSpan, type LoggerLike, type TracerLike } from "./logging.js";
import {
  cancelSuccess,
  listTargetsSuccess,
  remoteAgentFailure,
  sendStreamSuccess,
  sendSuccess,
  statusSuccess,
  streamUpdate,
  summarizeStreamEvents,
  watchSuccess,
  type A2AStreamEventData,
  type A2AToolResult,
  type RemoteAgentSummary,
  type SummaryTaskContext,
  type StreamUpdateEnvelope,
  type StreamingAction,
} from "./result-shape.js";
import {
  buildRequestOptions,
  normalizeSendRequest,
  normalizeStrictTaskCreationSendRequest,
  type NormalizedSendRequest,
} from "./request-normalization.js";
import {
  createClientPool,
  type ResolvedTarget,
  type SDKClientPool,
  type SDKClientPoolEntry,
} from "./sdk-client-pool.js";
import {
  buildRemoteAgentToolDefinition,
  createRemoteAgentInputValidator,
  type CancelActionInput,
  type RemoteAgentContinuationInput,
  type RemoteAgentContinuationTargetInput,
  type RemoteAgentAction,
  type RemoteAgentToolInput,
  type SendActionInput,
  type StatusActionInput,
  type ToolDefinition,
  type WatchActionInput,
} from "./schemas.js";
import {
  createTargetCatalog,
  type TargetCatalog,
} from "./target-catalog.js";
import {
  createTaskHandleRegistry,
  type TaskHandleRegistry,
} from "./task-handle-registry.js";

type ExecutionOptions = {
  signal?: AbortSignal;
};

type StreamExecutionOptions<T extends StreamingAction> = ExecutionOptions & {
  onUpdate?: (update: StreamUpdateEnvelope<T>) => void;
};

type StreamState = {
  events: A2AStreamEventData[];
  latestSummary?: RemoteAgentSummary;
  taskContext: SummaryTaskContext;
};

type PreparedSend = {
  resolved: ResolvedTaskContext;
  normalized: NormalizedSendRequest;
  capabilityDiagnostics: CapabilityDiagnostics;
};

type TargetContextInput = {
  target_alias?: string;
  target_url?: string;
  continuation?: RemoteAgentContinuationInput;
};

type FollowUpActionInput = WatchActionInput | StatusActionInput | CancelActionInput;

type TaskAwareActionInput =
  | FollowUpActionInput
  | Pick<
      SendActionInput,
      | "action"
      | "target_alias"
      | "target_url"
      | "task_handle"
      | "task_id"
      | "context_id"
      | "continuation"
    >;

type ResolvedClientContext = {
  target: ResolvedTarget;
  clientEntry: SDKClientPoolEntry;
};

type ResolvedTaskContext = ResolvedClientContext & SummaryTaskContext;

function fallbackErrorCode(error: unknown): A2AOutboundErrorCode {
  if (error instanceof A2AOutboundError) {
    return error.code;
  }

  if (error instanceof Error) {
    return ERROR_CODES.A2A_SDK_ERROR;
  }

  return ERROR_CODES.INTERNAL_ERROR;
}

function targetIdentity(target: ResolvedTarget): string {
  return JSON.stringify([
    target.baseUrl,
    target.cardPath,
    ...target.preferredTransports,
  ]);
}

function targetSummary(target: ResolvedTarget): Record<string, unknown> {
  return {
    baseUrl: target.baseUrl,
    cardPath: target.cardPath,
    preferredTransports: [...target.preferredTransports],
    ...(target.alias !== undefined ? { alias: target.alias } : {}),
  };
}

function taskContextFromMessage(message: Message): SummaryTaskContext {
  return {
    ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
    ...(message.contextId !== undefined ? { contextId: message.contextId } : {}),
  };
}

function taskContextFromTask(task: Task): SummaryTaskContext {
  return {
    taskId: task.id,
    ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
  };
}

function taskContextFromStatusUpdate(
  event: TaskStatusUpdateEvent,
): SummaryTaskContext {
  return {
    ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
    ...(event.contextId !== undefined ? { contextId: event.contextId } : {}),
  };
}

function taskContextFromArtifactUpdate(
  event: TaskArtifactUpdateEvent,
): SummaryTaskContext {
  return {
    ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
    ...(event.contextId !== undefined ? { contextId: event.contextId } : {}),
  };
}

function taskContextFromEvent(event: A2AStreamEventData): SummaryTaskContext {
  switch (event.kind) {
    case "message":
      return taskContextFromMessage(event);
    case "task":
      return taskContextFromTask(event);
    case "status-update":
      return taskContextFromStatusUpdate(event);
    case "artifact-update":
      return taskContextFromArtifactUpdate(event);
  }
}

function mergeTaskContext(
  ...contexts: Array<SummaryTaskContext | undefined>
): SummaryTaskContext {
  const merged: SummaryTaskContext = {};

  for (const context of contexts) {
    if (!context) {
      continue;
    }

    if (context.taskId !== undefined) {
      merged.taskId = context.taskId;
    }

    if (context.contextId !== undefined) {
      merged.contextId = context.contextId;
    }

    if (context.taskHandle !== undefined) {
      merged.taskHandle = context.taskHandle;
    }
  }

  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withErrorDetails(
  error: ReturnType<typeof toToolError>,
  details: Record<string, unknown>,
): ReturnType<typeof toToolError> {
  if (error.details === undefined) {
    return {
      ...error,
      details,
    };
  }

  if (isRecord(error.details)) {
    return {
      ...error,
      details: {
        ...error.details,
        ...details,
      },
    };
  }

  return {
    ...error,
    details: {
      originalDetails: error.details,
      ...details,
    },
  };
}

function taskHandleTargetMismatchError(
  taskHandle: string,
  handleTarget: ResolvedTarget,
  explicitTarget: ResolvedTarget,
): A2AOutboundError {
  return new A2AOutboundError(
    ERROR_CODES.VALIDATION_ERROR,
    `task_handle "${taskHandle}" does not match the explicit target`,
    {
      task_handle: taskHandle,
      handle_target: targetSummary(handleTarget),
      explicit_target: targetSummary(explicitTarget),
    },
  );
}

function taskHandleTaskIdMismatchError(
  taskHandle: string,
  handleTaskId: string,
  explicitTaskId: string,
): A2AOutboundError {
  return new A2AOutboundError(
    ERROR_CODES.VALIDATION_ERROR,
    `task_handle "${taskHandle}" does not match task_id "${explicitTaskId}"`,
    {
      task_handle: taskHandle,
      handle_task_id: handleTaskId,
      explicit_task_id: explicitTaskId,
    },
  );
}

function taskHandleContextIdMismatchError(
  taskHandle: string,
  handleContextId: string,
  explicitContextId: string,
): A2AOutboundError {
  return new A2AOutboundError(
    ERROR_CODES.VALIDATION_ERROR,
    `task_handle "${taskHandle}" does not match context_id "${explicitContextId}"`,
    {
      task_handle: taskHandle,
      handle_context_id: handleContextId,
      explicit_context_id: explicitContextId,
    },
  );
}

function missingTargetContextError(action: "send" | "watch" | "status" | "cancel") {
  const message =
    action === "send"
      ? "send requires task_handle, target_alias, target_url, or a configured default target"
      : `${action} requires task_handle, or task_id plus target_alias/target_url, or a configured default target`;

  return new A2AOutboundError(ERROR_CODES.VALIDATION_ERROR, message);
}

function conversationOnlyLifecycleContinuationError(
  action: "watch" | "status" | "cancel",
) {
  return new A2AOutboundError(
    ERROR_CODES.VALIDATION_ERROR,
    `${action} requires task continuity; summary.continuation.conversation.context_id is send-only`,
  );
}

function streamingNotSupportedError(
  target: ResolvedTarget,
  taskId: string,
): A2AOutboundError {
  return new A2AOutboundError(
    ERROR_CODES.A2A_SDK_ERROR,
    `streaming updates are not available for task ${taskId}; retry with action=status`,
    {
      task_id: taskId,
      target_url: target.baseUrl,
      ...(target.alias !== undefined ? { target_alias: target.alias } : {}),
      ...(target.streamingSupported !== undefined
        ? { streaming_supported: target.streamingSupported }
        : {}),
      suggested_action: "status",
    },
  );
}

function isTerminalTaskStatus(status: string | undefined): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "canceled" ||
    status === "rejected"
  );
}

function isStrictTaskRequirement(input: SendActionInput): boolean {
  return input.task_requirement === "required";
}

function taskRequiredButMessageReturnedError(
  message: Message,
): A2AOutboundError {
  return new A2AOutboundError(
    ERROR_CODES.TASK_REQUIRED_BUT_MESSAGE_RETURNED,
    'task_requirement="required" expected a Task response, but the peer returned only a Message',
    {
      ...(message.contextId !== undefined ? { context_id: message.contextId } : {}),
      ...(message.messageId !== undefined ? { message_id: message.messageId } : {}),
      response_kind: "message",
    },
  );
}

function taskSnapshotIdentity(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
    status: structuredClone(task.status),
    ...(task.history !== undefined ? { history: structuredClone(task.history) } : {}),
    ...(task.artifacts !== undefined
      ? { artifacts: structuredClone(task.artifacts) }
      : {}),
  };
}

function equivalentTaskSnapshots(
  initialTask: Task,
  event: A2AStreamEventData,
): boolean {
  return (
    event.kind === "task" &&
    isDeepStrictEqual(
      taskSnapshotIdentity(initialTask),
      taskSnapshotIdentity(event),
    )
  );
}

function withRecoverableStatusSuggestion(
  error: ReturnType<typeof toToolError>,
  taskContext: SummaryTaskContext,
): ReturnType<typeof toToolError> {
  return withErrorDetails(error, {
    task_id: taskContext.taskId,
    ...(taskContext.taskHandle !== undefined
      ? { task_handle: taskContext.taskHandle }
      : {}),
    ...(taskContext.contextId !== undefined
      ? { context_id: taskContext.contextId }
      : {}),
    suggested_action: "status",
  });
}

function appendStreamEvent<T extends StreamingAction>(
  action: T,
  target: ResolvedTarget,
  state: StreamState,
  event: A2AStreamEventData,
  onUpdate?: (update: StreamUpdateEnvelope<T>) => void,
): void {
  state.events.push(event);
  state.taskContext = mergeTaskContext(state.taskContext, taskContextFromEvent(event));
  state.latestSummary = summarizeStreamEvents(target, state.events, state.taskContext);
  onUpdate?.(streamUpdate(action, target, state.events, state.taskContext));
}

async function consumeStream<T extends StreamingAction>(
  stream: AsyncIterable<A2AStreamEventData>,
  action: T,
  target: ResolvedTarget,
  state: StreamState,
  onEvent?: (event: A2AStreamEventData) => void,
  onUpdate?: (update: StreamUpdateEnvelope<T>) => void,
  shouldSkipEvent?: (event: A2AStreamEventData, index: number) => boolean,
): Promise<void> {
  let index = 0;

  for await (const event of stream) {
    if (shouldSkipEvent?.(event, index)) {
      index += 1;
      continue;
    }

    index += 1;
    onEvent?.(event);
    appendStreamEvent(action, target, state, event, onUpdate);
  }
}

function requestedAction(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    "action" in input &&
    typeof (input as { action?: unknown }).action === "string"
  ) {
    return (input as { action: string }).action;
  }

  return "unknown";
}

export interface A2AOutboundServiceOptions {
  config?: unknown;
  parsedConfig?: A2AOutboundPluginConfig;
  logger?: LoggerLike;
  tracer?: TracerLike;
  clientPool?: SDKClientPool;
  targetCatalog?: TargetCatalog;
  taskHandleRegistry?: TaskHandleRegistry;
}

export class A2AOutboundService {
  private readonly logger: LoggerLike | undefined;

  private readonly tracer: TracerLike | undefined;

  private readonly config: A2AOutboundPluginConfig;

  private readonly clientPool: SDKClientPool;

  private readonly targetCatalog: TargetCatalog;

  private readonly taskHandleRegistry: TaskHandleRegistry;

  private readonly validateInput: (input: unknown) => RemoteAgentToolInput;

  private readonly toolDefinition: ToolDefinition;

  constructor(options: A2AOutboundServiceOptions = {}) {
    this.logger = options.logger;
    this.tracer = options.tracer;
    this.config =
      options.parsedConfig ?? parseA2AOutboundPluginConfig(options.config);

    this.clientPool =
      options.clientPool ??
      createClientPool({
        defaultCardPath: this.config.defaults.cardPath,
        preferredTransports: this.config.defaults.preferredTransports,
        normalizeBaseUrl: this.config.policy.normalizeBaseUrl,
        enforceSupportedTransports:
          this.config.policy.enforceSupportedTransports,
      });

    this.targetCatalog =
      options.targetCatalog ??
      createTargetCatalog({
        config: this.config,
        clientPool: this.clientPool,
      });

    this.taskHandleRegistry =
      options.taskHandleRegistry ??
      createTaskHandleRegistry({
        ttlMs: this.config.taskHandles.ttlMs,
        maxEntries: this.config.taskHandles.maxEntries,
      });

    this.validateInput = createRemoteAgentInputValidator(this.config);
    this.toolDefinition = buildRemoteAgentToolDefinition(this.config);
  }

  getToolDefinition(): ToolDefinition {
    return {
      ...this.toolDefinition,
      parameters: {
        ...this.toolDefinition.parameters,
      },
    };
  }

  async execute(
    input: unknown,
    options: StreamExecutionOptions<StreamingAction> = {},
  ): Promise<A2AToolResult> {
    let validated: RemoteAgentToolInput;

    try {
      validated = this.validateInput(input);
    } catch (error) {
      const action = requestedAction(input);
      const toolError = toToolError(error, fallbackErrorCode(error));

      log(this.logger, "error", "a2a.remote_agent.validation_error", {
        action,
        error: toolError,
      });

      return remoteAgentFailure(action, toolError);
    }

    switch (validated.action) {
      case "list_targets":
        return this.listTargets();
      case "send":
        return validated.follow_updates === true
          ? this.sendStream(validated, { signal: options.signal, onUpdate: options.onUpdate })
          : this.send(validated, { signal: options.signal });
      case "watch":
        return this.watch(validated, {
          signal: options.signal,
          onUpdate: options.onUpdate,
        });
      case "status":
        return this.status(validated, { signal: options.signal });
      case "cancel":
        return this.cancel(validated, { signal: options.signal });
    }
  }

  private async resolveClient(target: ResolvedTarget): Promise<ResolvedClientContext> {
    const clientEntry = await this.clientPool.get(target);
    let resolvedTarget = target;

    try {
      const card = await clientEntry.client.getAgentCard();
      resolvedTarget = this.targetCatalog.recordAgentCard(target, card);
    } catch (error) {
      log(this.logger, "warn", "a2a.remote_agent.target_card.refresh_error", {
        target,
        error: toToolError(error, fallbackErrorCode(error)),
      });
    }

    return {
      target: resolvedTarget,
      clientEntry,
    };
  }

  private resolveExplicitTarget(
    input: TargetContextInput,
  ): ResolvedTarget | undefined {
    if (input.target_alias !== undefined) {
      return this.targetCatalog.resolveAlias(input.target_alias);
    }

    if (input.target_url !== undefined) {
      return this.targetCatalog.resolveRawTarget({
        baseUrl: input.target_url,
      });
    }

    return undefined;
  }

  private resolveTrustedContinuationTarget(
    target: RemoteAgentContinuationTargetInput,
  ): ResolvedTarget {
    return this.clientPool.normalizeTarget({
      baseUrl: target.target_url,
      cardPath: target.card_path,
      preferredTransports: target.preferred_transports,
      ...(target.target_alias !== undefined
        ? { alias: target.target_alias }
        : {}),
    });
  }

  private async resolveTaskContext(
    input: TaskAwareActionInput,
  ): Promise<ResolvedTaskContext> {
    if (input.continuation !== undefined) {
      const continuationTarget = this.resolveTrustedContinuationTarget(
        input.continuation.target,
      );
      const continuationTask = input.continuation.task;
      const continuationContextId = input.continuation.conversation?.context_id;

      if (
        input.action !== "send" &&
        continuationTask === undefined &&
        continuationContextId !== undefined
      ) {
        throw conversationOnlyLifecycleContinuationError(input.action);
      }

      if (continuationTask?.task_handle !== undefined) {
        try {
          const handleRecord = this.taskHandleRegistry.resolve(
            continuationTask.task_handle,
          );

          if (continuationTask.task_id !== handleRecord.taskId) {
            throw taskHandleTaskIdMismatchError(
              continuationTask.task_handle,
              handleRecord.taskId,
              continuationTask.task_id,
            );
          }

          if (
            targetIdentity(continuationTarget) !==
            targetIdentity(handleRecord.target)
          ) {
            throw taskHandleTargetMismatchError(
              continuationTask.task_handle,
              handleRecord.target,
              continuationTarget,
            );
          }

          if (
            continuationContextId !== undefined &&
            handleRecord.contextId !== undefined &&
            continuationContextId !== handleRecord.contextId
          ) {
            throw taskHandleContextIdMismatchError(
              continuationTask.task_handle,
              handleRecord.contextId,
              continuationContextId,
            );
          }

          const clientResolution = await this.resolveClient(handleRecord.target);

          return {
            target: clientResolution.target,
            clientEntry: clientResolution.clientEntry,
            taskId: handleRecord.taskId,
            ...(continuationContextId !== undefined
              ? { contextId: continuationContextId }
              : handleRecord.contextId !== undefined
                ? { contextId: handleRecord.contextId }
                : {}),
            taskHandle: continuationTask.task_handle,
          };
        } catch (error) {
          if (
            error instanceof A2AOutboundError &&
            (error.code === ERROR_CODES.UNKNOWN_TASK_HANDLE ||
              error.code === ERROR_CODES.EXPIRED_TASK_HANDLE)
          ) {
            const clientResolution = await this.resolveClient(continuationTarget);

            return {
              target: clientResolution.target,
              clientEntry: clientResolution.clientEntry,
              taskId: continuationTask.task_id,
              ...(continuationContextId !== undefined
                ? { contextId: continuationContextId }
                : {}),
            };
          }

          throw error;
        }
      }

      const clientResolution = await this.resolveClient(continuationTarget);

      return {
        target: clientResolution.target,
        clientEntry: clientResolution.clientEntry,
        ...(continuationTask !== undefined
          ? { taskId: continuationTask.task_id }
          : {}),
        ...(continuationContextId !== undefined
          ? { contextId: continuationContextId }
          : {}),
      };
    }

    if (input.task_handle !== undefined) {
      const handleRecord = this.taskHandleRegistry.resolve(input.task_handle);

      if (input.task_id !== undefined && input.task_id !== handleRecord.taskId) {
        throw taskHandleTaskIdMismatchError(
          input.task_handle,
          handleRecord.taskId,
          input.task_id,
        );
      }

      const explicitTarget = this.resolveExplicitTarget(input);
      if (
        explicitTarget !== undefined &&
        targetIdentity(explicitTarget) !== targetIdentity(handleRecord.target)
      ) {
        throw taskHandleTargetMismatchError(
          input.task_handle,
          handleRecord.target,
          explicitTarget,
        );
      }

      if (
        "context_id" in input &&
        typeof input.context_id === "string" &&
        handleRecord.contextId !== undefined &&
        input.context_id !== handleRecord.contextId
      ) {
        throw taskHandleContextIdMismatchError(
          input.task_handle,
          handleRecord.contextId,
          input.context_id,
        );
      }

      const clientResolution = await this.resolveClient(handleRecord.target);

      return {
        target: clientResolution.target,
        clientEntry: clientResolution.clientEntry,
        taskId: handleRecord.taskId,
        ...("context_id" in input && input.context_id !== undefined
          ? { contextId: input.context_id }
          : handleRecord.contextId !== undefined
            ? { contextId: handleRecord.contextId }
            : {}),
        taskHandle: input.task_handle,
      };
    }

    const target =
      this.resolveExplicitTarget(input) ?? this.targetCatalog.resolveDefaultTarget();

    if (!target) {
      throw missingTargetContextError(input.action);
    }

    const clientResolution = await this.resolveClient(target);

    if (input.task_id !== undefined) {
      return {
        target: clientResolution.target,
        clientEntry: clientResolution.clientEntry,
        taskId: input.task_id,
        ...("context_id" in input && input.context_id !== undefined
          ? { contextId: input.context_id }
          : {}),
      };
    }

    if (input.action === "send") {
      return {
        target: clientResolution.target,
        clientEntry: clientResolution.clientEntry,
        ...("context_id" in input && input.context_id !== undefined
          ? { contextId: input.context_id }
          : {}),
      };
    }

    throw missingTargetContextError(input.action);
  }

  private bindTaskHandle(
    target: ResolvedTarget,
    taskId: string,
    taskHandle?: string,
    contextId?: string,
  ): string {
    if (taskHandle !== undefined) {
      return this.taskHandleRegistry.refresh(taskHandle, {
        target,
        taskId,
        ...(contextId !== undefined ? { contextId } : {}),
      })
        .taskHandle;
    }

    return this.taskHandleRegistry.create({
      target,
      taskId,
      ...(contextId !== undefined ? { contextId } : {}),
    }).taskHandle;
  }

  private bindTaskContext(
    target: ResolvedTarget,
    taskContext: SummaryTaskContext,
  ): SummaryTaskContext {
    if (taskContext.taskId === undefined) {
      return taskContext;
    }

    return {
      ...taskContext,
      taskHandle: this.bindTaskHandle(
        target,
        taskContext.taskId,
        taskContext.taskHandle,
        taskContext.contextId,
      ),
    };
  }

  private prepareSend(
    input: SendActionInput,
    options: ExecutionOptions,
    requestBuilder: (
      input: SendActionInput,
      options: {
        defaultTimeoutMs: number;
        defaultServiceParameters: Record<string, string>;
        defaultAcceptedOutputModes: readonly string[];
        signal?: AbortSignal;
      },
    ) => NormalizedSendRequest = normalizeSendRequest,
  ): Promise<PreparedSend> {
    return this.resolveTaskContext(input).then((resolved) => {
      const normalized = requestBuilder(
        {
          ...input,
          ...(resolved.taskId !== undefined ? { task_id: resolved.taskId } : {}),
          ...(resolved.contextId !== undefined
            ? { context_id: resolved.contextId }
            : {}),
        },
        {
          defaultTimeoutMs: this.config.defaults.timeoutMs,
          defaultServiceParameters: this.config.defaults.serviceParameters,
          defaultAcceptedOutputModes: this.config.policy.acceptedOutputModes,
          signal: options.signal,
        },
      );
      const capabilityDiagnostics = evaluateSendCompatibility(
        input,
        normalized.sendParams.configuration?.acceptedOutputModes ?? [],
        this.targetCatalog.getCardSnapshot(resolved.target.baseUrl),
      );

      return {
        resolved,
        normalized,
        capabilityDiagnostics,
      };
    });
  }

  private taskQueryOptions(
    input: Pick<
      SendActionInput | WatchActionInput,
      "timeout_ms" | "service_parameters"
    >,
    signal?: AbortSignal,
  ) {
    return buildRequestOptions(
      input.timeout_ms,
      this.config.defaults.timeoutMs,
      this.config.defaults.serviceParameters,
      input.service_parameters,
      signal,
    );
  }

  private async consumeResubscribeStream<T extends StreamingAction>(
    action: T,
    resolved: ResolvedTaskContext,
    input: Pick<
      SendActionInput | WatchActionInput,
      "timeout_ms" | "service_parameters"
    >,
    state: StreamState,
    options: StreamExecutionOptions<T>,
    dedupeInitialTask?: Task,
  ): Promise<void> {
    if (resolved.taskId === undefined) {
      throw missingTargetContextError("watch");
    }

    const peerCard = this.targetCatalog.getCardSnapshot(resolved.target.baseUrl);
    if (
      peerCard?.capabilities.streaming === false ||
      (peerCard === undefined && resolved.target.streamingSupported === false)
    ) {
      throw streamingNotSupportedError(resolved.target, resolved.taskId);
    }

    const params: TaskIdParams = {
      id: resolved.taskId,
    };

    await consumeStream(
      resolved.clientEntry.client.resubscribeTask(
        params,
        this.taskQueryOptions(input, options.signal),
      ),
      action,
      resolved.target,
      state,
      () => {
        state.taskContext = this.bindTaskContext(resolved.target, state.taskContext);
      },
      options.onUpdate,
      (event, index) =>
        index === 0 &&
        dedupeInitialTask !== undefined &&
        equivalentTaskSnapshots(dedupeInitialTask, event),
    );
  }

  private async listTargets(): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.remote_agent.list_targets");

    try {
      const entries = await this.targetCatalog.hydrateAllConfigured();
      return listTargetsSuccess(entries);
    } catch (error) {
      const toolError = toToolError(error, fallbackErrorCode(error));

      log(this.logger, "error", "a2a.remote_agent.list_targets.error", {
        error: toolError,
      });

      return remoteAgentFailure("list_targets", toolError);
    } finally {
      span.end?.();
    }
  }

  private async send(
    input: SendActionInput,
    options: ExecutionOptions,
  ): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.remote_agent.send");
    let target: ResolvedTarget | undefined;
    let capabilityDiagnostics: CapabilityDiagnostics | undefined;

    try {
      const prepared = await this.prepareSend(
        input,
        options,
        isStrictTaskRequirement(input)
          ? normalizeStrictTaskCreationSendRequest
          : normalizeSendRequest,
      );
      target = prepared.resolved.target;
      capabilityDiagnostics = prepared.capabilityDiagnostics;

      const raw = await prepared.resolved.clientEntry.client.sendMessage(
        prepared.normalized.sendParams,
        prepared.normalized.requestOptions,
      );

      if (isStrictTaskRequirement(input)) {
        if (raw.kind !== "task") {
          throw taskRequiredButMessageReturnedError(raw);
        }

        return sendSuccess(
          target,
          raw,
          this.bindTaskContext(
            target,
            mergeTaskContext(prepared.resolved, taskContextFromTask(raw)),
          ),
        );
      }

      return sendSuccess(
        target,
        raw,
        this.bindTaskContext(
          target,
          mergeTaskContext(
            prepared.resolved,
            raw.kind === "task"
              ? taskContextFromTask(raw)
              : taskContextFromMessage(raw),
          ),
        ),
      );
    } catch (error) {
      let toolError = toToolError(error, fallbackErrorCode(error));

      if (capabilityDiagnostics !== undefined) {
        toolError = withErrorDetails(toolError, {
          capability_diagnostics: capabilityDiagnostics,
        });
      }

      log(this.logger, "error", "a2a.remote_agent.send.error", {
        target,
        error: toolError,
      });

      return remoteAgentFailure("send", toolError);
    } finally {
      span.end?.();
    }
  }

  private async sendStream(
    input: SendActionInput,
    options: StreamExecutionOptions<"send">,
  ): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.remote_agent.send_stream");
    let target: ResolvedTarget | undefined;
    let capabilityDiagnostics: CapabilityDiagnostics | undefined;
    const state: StreamState = {
      events: [],
      taskContext: {},
    };

    try {
      if (isStrictTaskRequirement(input)) {
        const prepared = await this.prepareSend(
          input,
          options,
          normalizeStrictTaskCreationSendRequest,
        );
        target = prepared.resolved.target;
        capabilityDiagnostics = prepared.capabilityDiagnostics;

        const raw = await prepared.resolved.clientEntry.client.sendMessage(
          prepared.normalized.sendParams,
          prepared.normalized.requestOptions,
        );

        if (raw.kind !== "task") {
          throw taskRequiredButMessageReturnedError(raw);
        }

        const createdTaskContext = this.bindTaskContext(
          target,
          mergeTaskContext(prepared.resolved, taskContextFromTask(raw)),
        );
        state.taskContext = mergeTaskContext(state.taskContext, createdTaskContext);
        appendStreamEvent("send", target, state, raw, options.onUpdate);

        if (isTerminalTaskStatus(raw.status.state)) {
          return sendStreamSuccess(target, state.events, state.taskContext);
        }

        try {
          await this.consumeResubscribeStream(
            "send",
            {
              ...prepared.resolved,
              ...createdTaskContext,
            },
            input,
            state,
            options,
            raw,
          );

          if (state.events.length === 1) {
            throw new A2AOutboundError(
              ERROR_CODES.A2A_SDK_ERROR,
              "stream ended without watch events",
            );
          }
        } catch (error) {
          let effectiveError = error;

          if (effectiveError instanceof UnsupportedOperationError) {
            effectiveError = streamingNotSupportedError(target, raw.id);
          }

          let toolError = toToolError(
            effectiveError,
            fallbackErrorCode(effectiveError),
          );
          toolError = withRecoverableStatusSuggestion(toolError, createdTaskContext);

          if (capabilityDiagnostics !== undefined) {
            toolError = withErrorDetails(toolError, {
              capability_diagnostics: capabilityDiagnostics,
            });
          }

          if (state.events.length > 0 && state.latestSummary) {
            toolError = withErrorDetails(toolError, {
              partial_event_count: state.events.length,
              latest_event_summary: state.latestSummary,
            });
          }

          log(this.logger, "error", "a2a.remote_agent.send_stream.error", {
            target,
            error: toolError,
          });

          return remoteAgentFailure("send", toolError);
        }

        if (state.events.length === 0) {
          throw new A2AOutboundError(
            ERROR_CODES.A2A_SDK_ERROR,
            "stream ended without events",
          );
        }

        return sendStreamSuccess(target, state.events, state.taskContext);
      }

      const prepared = await this.prepareSend(input, options);
      target = prepared.resolved.target;
      capabilityDiagnostics = prepared.capabilityDiagnostics;
      state.taskContext = mergeTaskContext(state.taskContext, prepared.resolved);

      await consumeStream(
        prepared.resolved.clientEntry.client.sendMessageStream(
          prepared.normalized.sendParams,
          prepared.normalized.requestOptions,
        ),
        "send",
        target,
        state,
        (event) => {
          state.taskContext = this.bindTaskContext(
            prepared.resolved.target,
            mergeTaskContext(state.taskContext, taskContextFromEvent(event)),
          );
        },
        options.onUpdate,
      );

      if (state.events.length === 0) {
        throw new A2AOutboundError(
          ERROR_CODES.A2A_SDK_ERROR,
          "stream ended without events",
        );
      }

      return sendStreamSuccess(
        target,
        state.events,
        this.bindTaskContext(target, state.taskContext),
      );
    } catch (error) {
      let toolError = toToolError(error, fallbackErrorCode(error));

      if (capabilityDiagnostics !== undefined) {
        toolError = withErrorDetails(toolError, {
          capability_diagnostics: capabilityDiagnostics,
        });
      }

      if (state.events.length > 0 && state.latestSummary) {
        toolError = withErrorDetails(toolError, {
          partial_event_count: state.events.length,
          latest_event_summary: state.latestSummary,
        });
      }

      log(this.logger, "error", "a2a.remote_agent.send_stream.error", {
        target,
        error: toolError,
      });

      return remoteAgentFailure("send", toolError);
    } finally {
      span.end?.();
    }
  }

  private async status(
    input: StatusActionInput,
    options: ExecutionOptions,
  ): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.remote_agent.status");
    let target: ResolvedTarget | undefined;
    let taskId: string | undefined;

    try {
      const resolved = await this.resolveTaskContext(input);
      target = resolved.target;
      taskId = resolved.taskId;
      if (resolved.taskId === undefined) {
        throw missingTargetContextError("status");
      }

      const params: TaskQueryParams = {
        id: resolved.taskId,
        ...(input.history_length !== undefined
          ? { historyLength: input.history_length }
          : {}),
      };

      const raw = await resolved.clientEntry.client.getTask(
        params,
        buildRequestOptions(
          input.timeout_ms,
          this.config.defaults.timeoutMs,
          this.config.defaults.serviceParameters,
          input.service_parameters,
          options.signal,
        ),
      );

      return statusSuccess(
        target,
        raw,
        this.bindTaskContext(
          target,
          mergeTaskContext(resolved, taskContextFromTask(raw)),
        ),
      );
    } catch (error) {
      const toolError = toToolError(error, fallbackErrorCode(error));

      log(this.logger, "error", "a2a.remote_agent.status.error", {
        target,
        taskId,
        error: toolError,
      });

      return remoteAgentFailure("status", toolError);
    } finally {
      span.end?.();
    }
  }

  private async watch(
    input: WatchActionInput,
    options: StreamExecutionOptions<"watch">,
  ): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.remote_agent.watch");
    let target: ResolvedTarget | undefined;
    let taskId: string | undefined;
    const state: StreamState = {
      events: [],
      taskContext: {},
    };

    try {
      const resolved = await this.resolveTaskContext(input);
      target = resolved.target;
      taskId = resolved.taskId;
      if (resolved.taskId === undefined) {
        throw missingTargetContextError("watch");
      }
      state.taskContext = mergeTaskContext(state.taskContext, resolved);

      await this.consumeResubscribeStream(
        "watch",
        resolved,
        input,
        state,
        options,
      );

      if (state.events.length === 0) {
        throw new A2AOutboundError(
          ERROR_CODES.A2A_SDK_ERROR,
          "stream ended without events",
        );
      }

      return watchSuccess(
        target,
        state.events,
        this.bindTaskContext(target, state.taskContext),
      );
    } catch (error) {
      let effectiveError = error;

      if (
        effectiveError instanceof UnsupportedOperationError &&
        target !== undefined &&
        taskId !== undefined
      ) {
        effectiveError = streamingNotSupportedError(target, taskId);
      }

      let toolError = toToolError(effectiveError, fallbackErrorCode(effectiveError));

      if (state.events.length > 0 && state.latestSummary) {
        toolError = withErrorDetails(toolError, {
          partial_event_count: state.events.length,
          latest_event_summary: state.latestSummary,
        });
      }

      log(this.logger, "error", "a2a.remote_agent.watch.error", {
        target,
        taskId,
        error: toolError,
      });

      return remoteAgentFailure("watch", toolError);
    } finally {
      span.end?.();
    }
  }

  private async cancel(
    input: CancelActionInput,
    options: ExecutionOptions,
  ): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.remote_agent.cancel");
    let target: ResolvedTarget | undefined;
    let taskId: string | undefined;

    try {
      const resolved = await this.resolveTaskContext(input);
      target = resolved.target;
      taskId = resolved.taskId;
      if (resolved.taskId === undefined) {
        throw missingTargetContextError("cancel");
      }

      const params: TaskIdParams = {
        id: resolved.taskId,
      };

      const raw = await resolved.clientEntry.client.cancelTask(
        params,
        buildRequestOptions(
          input.timeout_ms,
          this.config.defaults.timeoutMs,
          this.config.defaults.serviceParameters,
          input.service_parameters,
          options.signal,
        ),
      );

      return cancelSuccess(
        target,
        raw,
        this.bindTaskContext(
          target,
          mergeTaskContext(resolved, taskContextFromTask(raw)),
        ),
      );
    } catch (error) {
      const toolError = toToolError(error, fallbackErrorCode(error));

      log(this.logger, "error", "a2a.remote_agent.cancel.error", {
        target,
        taskId,
        error: toolError,
      });

      return remoteAgentFailure("cancel", toolError);
    } finally {
      span.end?.();
    }
  }
}

export function buildService(
  options: A2AOutboundServiceOptions = {},
): A2AOutboundService {
  return new A2AOutboundService(options);
}
