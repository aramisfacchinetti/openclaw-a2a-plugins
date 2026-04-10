import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

export const PLUGIN_ID = "openclaw-a2a-inbound";
export const CHANNEL_ID = "a2a";
export const CHANNEL_LABEL = "A2A Inbound";
export const CHANNEL_DOCS_PATH = "/channels/a2a";
export const PLUGIN_VERSION: string = _pkg.version;
export const A2A_INBOUND_UNSUPPORTED_OUTBOUND_DELIVERY_ERROR_CODE =
  "A2A_OUTBOUND_DELIVERY_UNSUPPORTED";
export const A2A_INBOUND_UNSUPPORTED_OUTBOUND_DELIVERY_MESSAGE =
  `${A2A_INBOUND_UNSUPPORTED_OUTBOUND_DELIVERY_ERROR_CODE}: openclaw-a2a-inbound does not implement OpenClaw-initiated outbound delivery. Use openclaw-a2a-outbound for delegated outbound A2A calls.`;

export const DEFAULT_PROTOCOL_VERSION = "0.3.0";
export const DEFAULT_AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const DEFAULT_JSON_RPC_PATH = "/a2a/jsonrpc";
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
