export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  A2A_SDK_ERROR: "A2A_SDK_ERROR",
  WAIT_TIMEOUT: "WAIT_TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type A2AOutboundErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ToolError {
  code: A2AOutboundErrorCode | string;
  message: string;
  details?: unknown;
}

export class A2AOutboundError extends Error {
  readonly code: A2AOutboundErrorCode;

  readonly details?: unknown;

  constructor(
    code: A2AOutboundErrorCode,
    message: string,
    details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "A2AOutboundError";
    this.code = code;
    this.details = details;
  }
}

export function isA2AOutboundError(value: unknown): value is A2AOutboundError {
  return value instanceof A2AOutboundError;
}

function compactStack(stack: string | undefined): string | undefined {
  if (!stack) {
    return undefined;
  }

  const maxLines = 10;
  const maxChars = 1600;
  const lines = stack.split("\n").slice(0, maxLines);
  const preview = lines.join("\n");

  if (preview.length <= maxChars) {
    return preview;
  }

  return `${preview.slice(0, maxChars)}…`;
}

function summarizeUnknown(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return `${value}n`;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
    };
  }

  if (typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value as Record<string, unknown>).slice(0, 20),
    };
  }

  return String(value);
}

type ErrorResponseShape = {
  error?: {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
};

function errorResponseDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object" || !("errorResponse" in error)) {
    return undefined;
  }

  const errorResponse = (error as { errorResponse?: unknown })
    .errorResponse as ErrorResponseShape | undefined;

  if (!errorResponse?.error || typeof errorResponse.error !== "object") {
    return undefined;
  }

  const details: Record<string, unknown> = {};

  if (typeof errorResponse.error.code === "number") {
    details.rpcCode = errorResponse.error.code;
  }

  if (errorResponse.error.data !== undefined) {
    details.rpcData = summarizeUnknown(errorResponse.error.data);
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function errorResponseMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("errorResponse" in error)) {
    return undefined;
  }

  const errorResponse = (error as { errorResponse?: unknown })
    .errorResponse as ErrorResponseShape | undefined;

  return typeof errorResponse?.error?.message === "string"
    ? errorResponse.error.message
    : undefined;
}

function isAbortOrTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const name = String((error as { name?: unknown }).name ?? "");
  return name === "AbortError" || name === "TimeoutError";
}

export function toToolError(
  error: unknown,
  fallbackCode: A2AOutboundErrorCode = ERROR_CODES.INTERNAL_ERROR,
): ToolError {
  if (isA2AOutboundError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }

  if (isAbortOrTimeoutError(error)) {
    return {
      code: ERROR_CODES.A2A_SDK_ERROR,
      message: "request timed out",
      details: {
        hint: "Increase request.timeoutMs or plugin defaults.timeoutMs.",
      },
    };
  }

  if (error instanceof Error) {
    const details: Record<string, unknown> = {
      errorName: error.name,
    };

    const stack = compactStack(error.stack);
    if (stack !== undefined) {
      details.stack = stack;
    }

    const cause = summarizeUnknown(
      (error as Error & { cause?: unknown }).cause,
    );
    if (cause !== undefined) {
      details.cause = cause;
    }

    const rpcDetails = errorResponseDetails(error);
    if (rpcDetails !== undefined) {
      Object.assign(details, rpcDetails);
    }

    return {
      code: fallbackCode,
      message: error.message || errorResponseMessage(error) || "request failed",
      details,
    };
  }

  return {
    code: fallbackCode,
    message: String(error),
  };
}
