import type {
  MessageSendParams,
  TaskIdParams,
  TaskQueryParams,
} from "@a2a-js/sdk";
import type { RequestOptions } from "@a2a-js/sdk/client";
import {
  parseA2AOutboundPluginConfig,
  type A2AOutboundPluginConfig,
} from "./config.js";
import {
  type A2AOutboundErrorCode,
  A2AOutboundError,
  ERROR_CODES,
  toToolError,
} from "./errors.js";
import { log, startSpan, type LoggerLike, type TracerLike } from "./logging.js";
import {
  delegateFailure,
  delegateSuccess,
  delegateStreamFailure,
  delegateStreamSuccess,
  OPERATIONS,
  streamUpdate,
  summarizeStreamEvent,
  taskCancelFailure,
  taskCancelSuccess,
  taskResubscribeFailure,
  taskResubscribeSuccess,
  taskStatusFailure,
  taskStatusSuccess,
  type A2AStreamEventData,
  type A2AToolResult,
  type StreamOperation,
  type StreamUpdateEnvelope,
} from "./result-shape.js";
import {
  createClientPool,
  type ResolvedTarget,
  type SDKClientPool,
} from "./sdk-client-pool.js";
import {
  validateCancelInput,
  validateDelegateInput,
  validateDelegateStreamInput,
  validateResubscribeInput,
  validateStatusInput,
} from "./schemas.js";

type ExecutionOptions = {
  signal?: AbortSignal;
};

type StreamExecutionOptions<T extends StreamOperation> = ExecutionOptions & {
  onUpdate?: (update: StreamUpdateEnvelope<T>) => void;
};

type StreamState = {
  events: A2AStreamEventData[];
  latestSummary?: ReturnType<typeof summarizeStreamEvent>;
};

function mergeServiceParameters(
  base: Record<string, string>,
  override: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged = {
    ...base,
    ...(override ?? {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const availableSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );

  if (availableSignals.length === 0) {
    throw new TypeError("expected at least one signal");
  }

  if (availableSignals.length === 1) {
    return availableSignals[0];
  }

  return AbortSignal.any(availableSignals);
}

function requestOptions(
  timeoutMs: number | undefined,
  defaultTimeoutMs: number,
  defaultServiceParameters: Record<string, string>,
  serviceParameters: Record<string, string> | undefined,
  signal?: AbortSignal,
): RequestOptions {
  const effectiveTimeoutMs = timeoutMs ?? defaultTimeoutMs;
  const mergedServiceParameters = mergeServiceParameters(
    defaultServiceParameters,
    serviceParameters,
  );

  return {
    signal: mergeSignals([AbortSignal.timeout(effectiveTimeoutMs), signal]),
    ...(mergedServiceParameters
      ? { serviceParameters: mergedServiceParameters }
      : {}),
  };
}

function fallbackErrorCode(error: unknown): A2AOutboundErrorCode {
  if (error instanceof A2AOutboundError) {
    return error.code;
  }

  if (error instanceof Error) {
    return ERROR_CODES.A2A_SDK_ERROR;
  }

  return ERROR_CODES.INTERNAL_ERROR;
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

async function consumeStream<T extends StreamOperation>(
  stream: AsyncIterable<A2AStreamEventData>,
  target: ResolvedTarget,
  operation: T,
  state: StreamState,
  onUpdate?: (update: StreamUpdateEnvelope<T>) => void,
): Promise<void> {
  for await (const event of stream) {
    state.events.push(event);
    state.latestSummary = summarizeStreamEvent(event);
    onUpdate?.(streamUpdate(operation, target, event));
  }
}

export interface A2AOutboundServiceOptions {
  config?: unknown;
  logger?: LoggerLike;
  tracer?: TracerLike;
  clientPool?: SDKClientPool;
}

export class A2AOutboundService {
  private readonly logger: LoggerLike | undefined;

  private readonly tracer: TracerLike | undefined;

  private readonly config: A2AOutboundPluginConfig;

  private readonly clientPool: SDKClientPool;

  constructor(options: A2AOutboundServiceOptions = {}) {
    this.logger = options.logger;
    this.tracer = options.tracer;
    this.config = parseA2AOutboundPluginConfig(options.config);

    this.clientPool =
      options.clientPool ??
      createClientPool({
        defaultCardPath: this.config.defaults.cardPath,
        preferredTransports: this.config.defaults.preferredTransports,
        acceptedOutputModes: this.config.policy.acceptedOutputModes,
        normalizeBaseUrl: this.config.policy.normalizeBaseUrl,
        enforceSupportedTransports:
          this.config.policy.enforceSupportedTransports,
      });
  }

  async delegate(
    input: unknown,
    options: ExecutionOptions = {},
  ): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.delegate");
    let target;

    try {
      const validated = validateDelegateInput(input);
      const resolved = await this.clientPool.get(validated.target);
      target = resolved.target;

      const messagePayload: MessageSendParams = {
        message: validated.request.message,
        ...(validated.request.metadata !== undefined
          ? { metadata: validated.request.metadata }
          : {}),
        ...(validated.request.configuration !== undefined
          ? { configuration: validated.request.configuration }
          : {}),
      };

      const raw = await resolved.client.sendMessage(
        messagePayload,
        requestOptions(
          validated.request.timeoutMs,
          this.config.defaults.timeoutMs,
          this.config.defaults.serviceParameters,
          validated.request.serviceParameters,
          options.signal,
        ),
      );

      return delegateSuccess(target, raw);
    } catch (error) {
      const toolError = toToolError(error, fallbackErrorCode(error));

      log(this.logger, "error", "a2a.delegate.error", {
        target,
        error: toolError,
      });

      return delegateFailure(target, toolError);
    } finally {
      span.end?.();
    }
  }

  async delegateStream(
    input: unknown,
    options: StreamExecutionOptions<typeof OPERATIONS.DELEGATE_STREAM> = {},
  ): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.delegate_stream");
    let target;
    const state: StreamState = {
      events: [],
    };

    try {
      const validated = validateDelegateStreamInput(input);
      const resolved = await this.clientPool.get(validated.target);
      target = resolved.target;

      const messagePayload: MessageSendParams = {
        message: validated.request.message,
        ...(validated.request.metadata !== undefined
          ? { metadata: validated.request.metadata }
          : {}),
        ...(validated.request.configuration !== undefined
          ? { configuration: validated.request.configuration }
          : {}),
      };

      await consumeStream(
        resolved.client.sendMessageStream(
          messagePayload,
          requestOptions(
            validated.request.timeoutMs,
            this.config.defaults.timeoutMs,
            this.config.defaults.serviceParameters,
            validated.request.serviceParameters,
            options.signal,
          ),
        ),
        target,
        OPERATIONS.DELEGATE_STREAM,
        state,
        options.onUpdate,
      );

      if (state.events.length === 0) {
        throw new A2AOutboundError(
          ERROR_CODES.A2A_SDK_ERROR,
          "stream ended without events",
        );
      }

      return delegateStreamSuccess(target, state.events);
    } catch (error) {
      let toolError = toToolError(error, fallbackErrorCode(error));

      if (state.events.length > 0 && state.latestSummary) {
        toolError = withErrorDetails(toolError, {
          partialEventCount: state.events.length,
          latestEventSummary: state.latestSummary,
        });
      }

      log(this.logger, "error", "a2a.delegate_stream.error", {
        target,
        error: toolError,
      });

      return delegateStreamFailure(target, toolError);
    } finally {
      span.end?.();
    }
  }

  async status(
    input: unknown,
    options: ExecutionOptions = {},
  ): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.status");
    let target;
    let taskId: string | undefined;

    try {
      const validated = validateStatusInput(input);
      taskId = validated.request.taskId;
      const resolved = await this.clientPool.get(validated.target);
      target = resolved.target;

      const params: TaskQueryParams = {
        id: validated.request.taskId,
        ...(validated.request.historyLength !== undefined
          ? { historyLength: validated.request.historyLength }
          : {}),
      };

      const raw = await resolved.client.getTask(
        params,
        requestOptions(
          validated.request.timeoutMs,
          this.config.defaults.timeoutMs,
          this.config.defaults.serviceParameters,
          validated.request.serviceParameters,
          options.signal,
        ),
      );

      return taskStatusSuccess(target, validated.request.taskId, raw);
    } catch (error) {
      const toolError = toToolError(error, fallbackErrorCode(error));

      log(this.logger, "error", "a2a.status.error", {
        target,
        taskId,
        error: toolError,
      });

      return taskStatusFailure(target, toolError);
    } finally {
      span.end?.();
    }
  }

  async resubscribe(
    input: unknown,
    options: StreamExecutionOptions<typeof OPERATIONS.TASK_RESUBSCRIBE> = {},
  ): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.resubscribe");
    let target;
    let taskId: string | undefined;
    const state: StreamState = {
      events: [],
    };

    try {
      const validated = validateResubscribeInput(input);
      taskId = validated.request.taskId;
      const resolved = await this.clientPool.get(validated.target);
      target = resolved.target;

      const params: TaskIdParams = {
        id: validated.request.taskId,
      };

      await consumeStream(
        resolved.client.resubscribeTask(
          params,
          requestOptions(
            validated.request.timeoutMs,
            this.config.defaults.timeoutMs,
            this.config.defaults.serviceParameters,
            validated.request.serviceParameters,
            options.signal,
          ),
        ),
        target,
        OPERATIONS.TASK_RESUBSCRIBE,
        state,
        options.onUpdate,
      );

      if (state.events.length === 0) {
        throw new A2AOutboundError(
          ERROR_CODES.A2A_SDK_ERROR,
          "stream ended without events",
        );
      }

      return taskResubscribeSuccess(target, state.events);
    } catch (error) {
      let toolError = toToolError(error, fallbackErrorCode(error));

      if (state.events.length > 0 && state.latestSummary) {
        toolError = withErrorDetails(toolError, {
          partialEventCount: state.events.length,
          latestEventSummary: state.latestSummary,
        });
      }

      log(this.logger, "error", "a2a.resubscribe.error", {
        target,
        taskId,
        error: toolError,
      });

      return taskResubscribeFailure(target, toolError);
    } finally {
      span.end?.();
    }
  }

  async cancel(
    input: unknown,
    options: ExecutionOptions = {},
  ): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.cancel");
    let target;
    let taskId: string | undefined;

    try {
      const validated = validateCancelInput(input);
      taskId = validated.request.taskId;
      const resolved = await this.clientPool.get(validated.target);
      target = resolved.target;

      const params: TaskIdParams = {
        id: validated.request.taskId,
      };

      const raw = await resolved.client.cancelTask(
        params,
        requestOptions(
          validated.request.timeoutMs,
          this.config.defaults.timeoutMs,
          this.config.defaults.serviceParameters,
          validated.request.serviceParameters,
          options.signal,
        ),
      );

      return taskCancelSuccess(target, validated.request.taskId, raw);
    } catch (error) {
      const toolError = toToolError(error, fallbackErrorCode(error));

      log(this.logger, "error", "a2a.cancel.error", {
        target,
        taskId,
        error: toolError,
      });

      return taskCancelFailure(target, toolError);
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
