import type {
  MessageSendParams,
  Task,
  TaskIdParams,
  TaskQueryParams,
} from "@a2a-js/sdk";
import {
  AuthenticatedExtendedCardNotConfiguredError,
  ContentTypeNotSupportedError,
  InvalidAgentResponseError,
  TaskNotFoundError,
  UnsupportedOperationError,
  type RequestOptions,
} from "@a2a-js/sdk/client";
import { setTimeout as sleepTimeout } from "node:timers/promises";
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
  taskWaitFailure,
  taskWaitSuccess,
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
  validateWaitInput,
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

const TERMINAL_TASK_STATES = new Set<Task["status"]["state"]>([
  "completed",
  "canceled",
  "failed",
  "rejected",
  "unknown",
]);

function isTerminalTaskState(state: Task["status"]["state"]): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

function calculateBackoffDelay(
  iteration: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
): number {
  const exponent = Math.max(0, iteration - 1);
  const delayMs = initialDelayMs * backoffMultiplier ** exponent;

  return Math.min(maxDelayMs, Math.round(delayMs));
}

function remainingTimeMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

function elapsedTimeMs(startedAtMs: number, capMs?: number): number {
  const elapsedMs = Date.now() - startedAtMs;
  return capMs === undefined ? elapsedMs : Math.min(elapsedMs, capMs);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }

  const cause = (error as { cause?: unknown }).cause;
  if (
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    typeof (cause as { code?: unknown }).code === "string"
  ) {
    return (cause as { code: string }).code;
  }

  return undefined;
}

function isAbortOrTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const name = String((error as { name?: unknown }).name ?? "");
  return name === "AbortError" || name === "TimeoutError";
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = errorCode(error);
  if (
    code !== undefined &&
    /^(ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|UND_ERR_.*)$/i.test(
      code,
    )
  ) {
    return true;
  }

  return /fetch failed|network|socket|connection|terminated/i.test(error.message);
}

function isProtocolOrTaskError(error: unknown): boolean {
  if (
    error instanceof TaskNotFoundError ||
    error instanceof UnsupportedOperationError ||
    error instanceof InvalidAgentResponseError ||
    error instanceof ContentTypeNotSupportedError ||
    error instanceof AuthenticatedExtendedCardNotConfiguredError
  ) {
    return true;
  }

  return (
    error instanceof Error &&
    /^(JSON-RPC error:|REST error:)/.test(error.message)
  );
}

function isTransientPollError(error: unknown): boolean {
  if (isAbortOrTimeoutError(error)) {
    return true;
  }

  if (isProtocolOrTaskError(error)) {
    return false;
  }

  return isNetworkError(error);
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await sleepTimeout(delayMs, undefined, { signal });
}

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

function waitTimeoutError(
  taskId: string,
  waitTimeoutMs: number,
  attempts: number,
  startedAtMs: number,
  lastTask: Task | undefined,
  lastError: ToolError | undefined,
): A2AOutboundError {
  return new A2AOutboundError(
    ERROR_CODES.WAIT_TIMEOUT,
    `timed out waiting for task ${taskId}`,
    {
      taskId,
      waitTimeoutMs,
      attempts,
      elapsedMs: elapsedTimeMs(startedAtMs, waitTimeoutMs),
      lastTask: lastTask ?? null,
      ...(lastError !== undefined ? { lastError } : {}),
    },
  );
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

  async wait(
    input: unknown,
    options: ExecutionOptions = {},
  ): Promise<A2AToolResult> {
    const span = startSpan(this.tracer, "a2a.wait");
    const startedAtMs = Date.now();
    let target;
    let taskId: string | undefined;
    let attempts = 0;

    try {
      const validated = validateWaitInput(input);
      taskId = validated.request.taskId;
      const deadlineMs = startedAtMs + validated.request.waitTimeoutMs;
      const resolved = await this.clientPool.get(validated.target);
      target = resolved.target;

      const params: TaskQueryParams = {
        id: validated.request.taskId,
        ...(validated.request.historyLength !== undefined
          ? { historyLength: validated.request.historyLength }
          : {}),
      };

      let lastTask: Task | undefined;
      let lastError: ToolError | undefined;
      let retryCycle = 0;

      while (true) {
        const remainingPollBudgetMs = remainingTimeMs(deadlineMs);
        if (remainingPollBudgetMs <= 0) {
          throw waitTimeoutError(
            validated.request.taskId,
            validated.request.waitTimeoutMs,
            attempts,
            startedAtMs,
            lastTask,
            lastError,
          );
        }

        attempts += 1;

        try {
          const raw = await resolved.client.getTask(
            params,
            requestOptions(
              validated.request.timeoutMs,
              this.config.defaults.timeoutMs,
              this.config.defaults.serviceParameters,
              validated.request.serviceParameters,
              mergeSignals([
                options.signal,
                AbortSignal.timeout(remainingPollBudgetMs),
              ]),
            ),
          );

          lastTask = raw;

          if (isTerminalTaskState(raw.status.state)) {
            return taskWaitSuccess(
              target,
              validated.request.taskId,
              raw,
              attempts,
              elapsedTimeMs(startedAtMs),
            );
          }
        } catch (error) {
          if (options.signal?.aborted === true) {
            throw error;
          }

          if (!isTransientPollError(error)) {
            throw error;
          }

          lastError = toToolError(error, fallbackErrorCode(error));

          if (remainingTimeMs(deadlineMs) <= 0) {
            throw waitTimeoutError(
              validated.request.taskId,
              validated.request.waitTimeoutMs,
              attempts,
              startedAtMs,
              lastTask,
              lastError,
            );
          }
        }

        retryCycle += 1;
        const remainingSleepBudgetMs = remainingTimeMs(deadlineMs);

        if (remainingSleepBudgetMs <= 0) {
          throw waitTimeoutError(
            validated.request.taskId,
            validated.request.waitTimeoutMs,
            attempts,
            startedAtMs,
            lastTask,
            lastError,
          );
        }

        await sleep(
          Math.min(
            calculateBackoffDelay(
              retryCycle,
              validated.request.initialDelayMs,
              validated.request.maxDelayMs,
              validated.request.backoffMultiplier,
            ),
            remainingSleepBudgetMs,
          ),
          options.signal,
        );
      }
    } catch (error) {
      const toolError = toToolError(error, fallbackErrorCode(error));

      log(this.logger, "error", "a2a.wait.error", {
        target,
        taskId,
        attempts,
        error: toolError,
      });

      return taskWaitFailure(target, toolError);
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
