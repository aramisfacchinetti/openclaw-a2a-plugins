import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskQueryParams,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
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
  summarizeStreamEvent,
  watchSuccess,
  type A2AStreamEventData,
  type A2AToolResult,
  type SummaryTaskContext,
  type StreamUpdateEnvelope,
  type StreamingAction,
} from "./result-shape.js";
import {
  buildRequestOptions,
  normalizeSendRequest,
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
  latestSummary?: ReturnType<typeof summarizeStreamEvent>;
  taskContext: SummaryTaskContext;
};

type TargetContextInput = {
  target_alias?: string;
  target_url?: string;
};

type FollowUpActionInput = WatchActionInput | StatusActionInput | CancelActionInput;

type TaskAwareActionInput =
  | FollowUpActionInput
  | Pick<
      SendActionInput,
      "action" | "target_alias" | "target_url" | "task_handle" | "task_id" | "context_id"
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

async function consumeStream<T extends StreamingAction>(
  stream: AsyncIterable<A2AStreamEventData>,
  action: T,
  target: ResolvedTarget,
  state: StreamState,
  onEvent?: (event: A2AStreamEventData) => void,
  onUpdate?: (update: StreamUpdateEnvelope<T>) => void,
): Promise<void> {
  for await (const event of stream) {
    state.events.push(event);
    state.taskContext = mergeTaskContext(state.taskContext, taskContextFromEvent(event));
    onEvent?.(event);
    state.latestSummary = summarizeStreamEvent(target, event, state.taskContext);
    onUpdate?.(streamUpdate(action, target, event, state.taskContext));
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

  private async resolveTaskContext(
    input: TaskAwareActionInput,
  ): Promise<ResolvedTaskContext> {
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
      const resolved = await this.resolveTaskContext(input);
      target = resolved.target;
      const normalized = normalizeSendRequest(
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
      capabilityDiagnostics = evaluateSendCompatibility(
        input,
        normalized.sendParams.configuration?.acceptedOutputModes ?? [],
        this.targetCatalog.getCardSnapshot(target.baseUrl),
      );

      const raw = await resolved.clientEntry.client.sendMessage(
        normalized.sendParams,
        normalized.requestOptions,
      );

      const taskContext = this.bindTaskContext(
        target,
        mergeTaskContext(
          resolved,
          raw.kind === "task" ? taskContextFromTask(raw) : taskContextFromMessage(raw),
        ),
      );

      return sendSuccess(target, raw, taskContext);
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
      const resolved = await this.resolveTaskContext(input);
      target = resolved.target;
      state.taskContext = mergeTaskContext(state.taskContext, resolved);
      const normalized = normalizeSendRequest(
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
      capabilityDiagnostics = evaluateSendCompatibility(
        input,
        normalized.sendParams.configuration?.acceptedOutputModes ?? [],
        this.targetCatalog.getCardSnapshot(target.baseUrl),
      );

      await consumeStream(
        resolved.clientEntry.client.sendMessageStream(
          normalized.sendParams,
          normalized.requestOptions,
        ),
        "send",
        target,
        state,
        () => {
          if (target !== undefined) {
            state.taskContext = this.bindTaskContext(target, state.taskContext);
          }
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
          buildRequestOptions(
            input.timeout_ms,
            this.config.defaults.timeoutMs,
            this.config.defaults.serviceParameters,
            input.service_parameters,
            options.signal,
          ),
        ),
        "watch",
        target,
        state,
        () => {
          if (target !== undefined) {
            state.taskContext = this.bindTaskContext(target, state.taskContext);
          }
        },
        options.onUpdate,
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
