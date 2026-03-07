export type LoggerLike = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export function log(
  logger: LoggerLike | undefined,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const sink = logger?.[level] ?? logger?.info;

  if (typeof sink !== "function") {
    return;
  }

  const details =
    Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  sink(`${event}${details}`);
}

export type TraceSpan = {
  setAttribute?: (name: string, value: unknown) => void;
  recordException?: (error: unknown) => void;
  end?: () => void;
};

export type TracerLike = {
  startSpan?: (
    name: string,
    options?: { attributes?: Record<string, unknown> },
  ) => TraceSpan;
};

export function startSpan(
  tracer: TracerLike | undefined,
  name: string,
  attributes: Record<string, unknown> = {},
): TraceSpan {
  if (!tracer || typeof tracer.startSpan !== "function") {
    return {
      setAttribute() {},
      recordException() {},
      end() {},
    };
  }

  return tracer.startSpan(name, { attributes });
}
