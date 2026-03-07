export const PLUGIN_ID = "a2a-outbound";

export const ALL_TRANSPORTS = ["JSONRPC", "HTTP+JSON", "GRPC"] as const;
export const SUPPORTED_TRANSPORTS = ["JSONRPC", "HTTP+JSON"] as const;

export type A2ATransport = (typeof ALL_TRANSPORTS)[number];
