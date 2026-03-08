export interface LoggerLike {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export function log(
  logger: LoggerLike | undefined,
  level: keyof LoggerLike,
  event: string,
  details: Record<string, unknown> = {},
): void {
  const write = logger?.[level];

  if (typeof write !== "function") {
    return;
  }

  const suffix =
    Object.keys(details).length === 0 ? "" : ` ${JSON.stringify(details)}`;

  write(`${event}${suffix}`);
}
