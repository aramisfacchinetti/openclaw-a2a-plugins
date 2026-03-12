import type { Task, TaskIdParams, TaskQueryParams } from "@a2a-js/sdk";
import { UnsupportedOperationError } from "@a2a-js/sdk/client";
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
};

type TargetContextInput = {
  target_alias?: string;
  target_url?: string;
};

type FollowUpActionInput = WatchActionInput | StatusActionInput | CancelActionInput;

type ResolvedClientContext = {
  target: ResolvedTarget;
  clientEntry: SDKClientPoolEntry;
};

type ResolvedTaskContext = ResolvedClientContext & {
  taskId: string;
  taskHandle?: string;
};

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

function firstStreamTaskId(
  events: readonly A2AStreamEventData[],
): string | undefined {
  for (const event of events) {
    switch (event.kind) {
      case "message":
        if (event.taskId !== undefined) {
          return event.taskId;
        }
        break;
      case "task":
        return event.id;
      case "status-update":
      case "artifact-update":
        return event.taskId;
    }
  }

  return undefined;
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

function missingTargetContextError(action: "send" | "watch" | "status" | "cancel") {
  const message =
    action === "send"
      ? "send requires target_alias, target_url, or a configured default target"
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
  onUpdate?: (update: StreamUpdateEnvelope<T>) => void,
): Promise<void> {
  for await (const event of stream) {
    state.events.push(event);
    state.latestSummary = summarizeStreamEvent(target, event);
    onUpdate?.(streamUpdate(action, target, event));
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

    return {
      target,
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

  private async resolveSendTarget(
    input: SendActionInput,
  ): Promise<ResolvedClientContext> {
    const explicitTarget = this.resolveExplicitTarget(input);
    const target = explicitTarget ?? this.targetCatalog.resolveDefaultTarget();

    if (!target) {
      throw missingTargetContextError("send");
    }

    return this.resolveClient(target);
  }

  private async resolveTaskContext(
    input: FollowUpActionInput,
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

      const clientEntry = await this.clientPool.get(handleRecord.target);

      return {
        target: handleRecord.target,
        clientEntry,
        taskId: handleRecord.taskId,
        taskHandle: input.task_handle,
      };
    }

    if (input.task_id === undefined) {
      throw missingTargetContextError(input.action);
    }

    const target =
      this.resolveExplicitTarget(input) ?? this.targetCatalog.resolveDefaultTarget();

    if (!target) {
      throw missingTargetContextError(input.action);
    }

    const clientEntry = await this.clientPool.get(target);

    return {
      target,
      clientEntry,
      taskId: input.task_id,
    };
  }

  private bindTaskHandle(
    target: ResolvedTarget,
    taskId: string,
    taskHandle?: string,
  ): string {
    if (taskHandle !== undefined) {
      return this.taskHandleRegistry.refresh(taskHandle, { target, taskId })
        .taskHandle;
    }

    return this.taskHandleRegistry.create({ target, taskId }).taskHandle;
  }

  private bindStreamTaskHandle(
    target: ResolvedTarget,
    events: readonly A2AStreamEventData[],
    taskHandle?: string,
  ): string | undefined {
    const taskId = firstStreamTaskId(events);

    return taskId !== undefined
      ? this.bindTaskHandle(target, taskId, taskHandle)
      : undefined;
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

    try {
      const resolved = await this.resolveSendTarget(input);
      target = resolved.target;
      const normalized = normalizeSendRequest(input, {
        defaultTimeoutMs: this.config.defaults.timeoutMs,
        defaultServiceParameters: this.config.defaults.serviceParameters,
        defaultAcceptedOutputModes: this.config.policy.acceptedOutputModes,
        signal: options.signal,
      });

      const raw = await resolved.clientEntry.client.sendMessage(
        normalized.sendParams,
        normalized.requestOptions,
      );

      const taskHandle =
        raw.kind === "task" ? this.bindTaskHandle(target, raw.id) : undefined;

      return sendSuccess(target, raw, taskHandle);
    } catch (error) {
      const toolError = toToolError(error, fallbackErrorCode(error));

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
    const state: StreamState = {
      events: [],
    };

    try {
      const resolved = await this.resolveSendTarget(input);
      target = resolved.target;
      const normalized = normalizeSendRequest(input, {
        defaultTimeoutMs: this.config.defaults.timeoutMs,
        defaultServiceParameters: this.config.defaults.serviceParameters,
        defaultAcceptedOutputModes: this.config.policy.acceptedOutputModes,
        signal: options.signal,
      });

      await consumeStream(
        resolved.clientEntry.client.sendMessageStream(
          normalized.sendParams,
          normalized.requestOptions,
        ),
        "send",
        target,
        state,
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
        this.bindStreamTaskHandle(target, state.events),
      );
    } catch (error) {
      let toolError = toToolError(error, fallbackErrorCode(error));

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
        this.bindTaskHandle(target, raw.id, resolved.taskHandle),
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
    };

    try {
      const resolved = await this.resolveTaskContext(input);
      target = resolved.target;
      taskId = resolved.taskId;

      if (resolved.target.streamingSupported === false) {
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
        this.bindStreamTaskHandle(target, state.events, resolved.taskHandle),
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
        this.bindTaskHandle(target, raw.id, resolved.taskHandle),
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
