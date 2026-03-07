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
  taskCancelFailure,
  taskCancelSuccess,
  taskStatusFailure,
  taskStatusSuccess,
  type A2AToolResult,
} from "./result-shape.js";
import { createClientPool, type SDKClientPool } from "./sdk-client-pool.js";
import {
  validateCancelInput,
  validateDelegateInput,
  validateStatusInput,
} from "./schemas.js";

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

function requestOptions(
  timeoutMs: number | undefined,
  defaultTimeoutMs: number,
  defaultServiceParameters: Record<string, string>,
  serviceParameters: Record<string, string> | undefined,
): RequestOptions {
  const effectiveTimeoutMs = timeoutMs ?? defaultTimeoutMs;
  const mergedServiceParameters = mergeServiceParameters(
    defaultServiceParameters,
    serviceParameters,
  );

  return {
    signal: AbortSignal.timeout(effectiveTimeoutMs),
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

  async delegate(input: unknown): Promise<A2AToolResult> {
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
      };

      const raw = await resolved.client.sendMessage(
        messagePayload,
        requestOptions(
          validated.request.timeoutMs,
          this.config.defaults.timeoutMs,
          this.config.defaults.serviceParameters,
          validated.request.serviceParameters,
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

  async status(input: unknown): Promise<A2AToolResult> {
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

  async cancel(input: unknown): Promise<A2AToolResult> {
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
