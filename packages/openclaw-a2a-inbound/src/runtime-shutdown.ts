export class A2AInboundServerShutdownError extends Error {
  constructor(message = "A2A inbound server closed while task execution was still running.") {
    super(message);
    this.name = "A2AInboundServerShutdownError";
  }
}

export function isA2AInboundServerShutdownError(
  value: unknown,
): value is A2AInboundServerShutdownError {
  return value instanceof A2AInboundServerShutdownError;
}
