import type {
  ChannelConfigSchema,
  OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk";
import {
  CHANNEL_ID,
  DEFAULT_AGENT_CARD_PATH,
  DEFAULT_JSON_RPC_PATH,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PROTOCOL_VERSION,
} from "./constants.js";

type JsonRecord = Record<string, unknown>;

export const DEFAULT_INPUT_MODES = [
  "text/plain",
  "application/json",
] as const;
export type A2AInboundInputMode = (typeof DEFAULT_INPUT_MODES)[number];

export const DEFAULT_OUTPUT_MODES = [
  "text/plain",
  "application/json",
] as const;

export interface A2AInboundSkillConfig {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  examples: string[];
}

export interface A2AInboundAccountConfig {
  accountId: string;
  enabled: boolean;
  label: string;
  description?: string;
  publicBaseUrl?: string;
  defaultAgentId?: string;
  sessionStore?: string;
  protocolVersion: string;
  agentCardPath: string;
  jsonRpcPath: string;
  maxBodyBytes: number;
  defaultInputModes: A2AInboundInputMode[];
  defaultOutputModes: string[];
  skills: A2AInboundSkillConfig[];
}

export interface A2AInboundChannelConfig {
  accounts: Record<string, A2AInboundAccountConfig>;
}

const DEFAULT_SKILLS: readonly A2AInboundSkillConfig[] = [
  {
    id: "chat",
    name: "Chat",
    description:
      "Routes inbound A2A requests with text and structured data into the configured OpenClaw agent. Inbound file parts are unsupported.",
    tags: ["chat", "openclaw"],
    examples: [
      "Summarize the latest incident and propose the next two steps.",
    ],
  },
];

export const A2A_INBOUND_PLUGIN_CONFIG_JSON_SCHEMA: NonNullable<
  OpenClawPluginConfigSchema["jsonSchema"]
> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export const A2A_INBOUND_OPENCLAW_PLUGIN_CONFIG_SCHEMA = {
  jsonSchema: A2A_INBOUND_PLUGIN_CONFIG_JSON_SCHEMA,
  uiHints: {},
  parse(_input?: unknown) {
    return {};
  },
} satisfies OpenClawPluginConfigSchema;

export const A2A_INBOUND_CHANNEL_CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    accounts: {
      type: "object",
      default: {},
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean", default: true },
          label: { type: "string" },
          description: { type: "string" },
          publicBaseUrl: { type: "string" },
          defaultAgentId: { type: "string" },
          sessionStore: { type: "string" },
          protocolVersion: {
            type: "string",
            default: DEFAULT_PROTOCOL_VERSION,
          },
          agentCardPath: {
            type: "string",
            default: DEFAULT_AGENT_CARD_PATH,
          },
          jsonRpcPath: {
            type: "string",
            default: DEFAULT_JSON_RPC_PATH,
          },
          maxBodyBytes: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_MAX_BODY_BYTES,
          },
          defaultInputModes: {
            type: "array",
            items: {
              type: "string",
              enum: [...DEFAULT_INPUT_MODES],
            },
            default: [...DEFAULT_INPUT_MODES],
          },
          defaultOutputModes: {
            type: "array",
            items: { type: "string" },
            default: [...DEFAULT_OUTPUT_MODES],
          },
          skills: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "name"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                tags: {
                  type: "array",
                  items: { type: "string" },
                  default: [],
                },
                examples: {
                  type: "array",
                  items: { type: "string" },
                  default: [],
                },
              },
            },
            default: [...DEFAULT_SKILLS],
          },
        },
      },
    },
  },
} as const;

export const A2A_INBOUND_CHANNEL_CONFIG_UI_HINTS = {
  accounts: {
    label: "Accounts",
    help: "A2A inbound endpoints exposed by this channel.",
  },
  "accounts.*.publicBaseUrl": {
    label: "Public Base URL",
    help: "Externally reachable base URL used in the agent card.",
    placeholder: "https://agents.example.com",
  },
  "accounts.*.defaultAgentId": {
    label: "Default Agent Id",
    help: "Preferred OpenClaw agent route for inbound requests.",
  },
  "accounts.*.agentCardPath": {
    label: "Agent Card Path",
    help: "HTTP path serving the A2A agent card.",
    advanced: true,
  },
  "accounts.*.jsonRpcPath": {
    label: "JSON-RPC Path",
    help: "HTTP path serving the A2A JSON-RPC transport.",
    advanced: true,
  },
} satisfies NonNullable<ChannelConfigSchema["uiHints"]>;

export const A2A_INBOUND_CHANNEL_CONFIG_SCHEMA: ChannelConfigSchema = {
  schema: A2A_INBOUND_CHANNEL_CONFIG_JSON_SCHEMA,
  uiHints: A2A_INBOUND_CHANNEL_CONFIG_UI_HINTS,
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : fallback;
}

function normalizePath(value: unknown, fallback: string): string {
  const resolved = readString(value, fallback);
  return resolved.startsWith("/") ? resolved : `/${resolved}`;
}

function readOptionalUrl(value: unknown): string | undefined {
  const raw = readOptionalString(value);

  if (!raw) {
    return undefined;
  }

  try {
    return new URL(raw).toString();
  } catch {
    return undefined;
  }
}

function readStringArray(
  value: unknown,
  fallback: readonly string[],
): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const deduped = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim();

    if (trimmed.length > 0) {
      deduped.add(trimmed);
    }
  }

  return deduped.size > 0 ? [...deduped] : [...fallback];
}

function parseDefaultInputModes(
  accountId: string,
  value: unknown,
): A2AInboundInputMode[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_INPUT_MODES];
  }

  const supportedModes = new Set<A2AInboundInputMode>(DEFAULT_INPUT_MODES);
  const modes: A2AInboundInputMode[] = [];
  const seen = new Set<A2AInboundInputMode>();

  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        `channels.${CHANNEL_ID}.accounts.${accountId}.defaultInputModes must contain only supported string values: ${DEFAULT_INPUT_MODES.join(", ")}.`,
      );
    }

    const trimmed = entry.trim();

    if (!supportedModes.has(trimmed as A2AInboundInputMode)) {
      throw new Error(
        `channels.${CHANNEL_ID}.accounts.${accountId}.defaultInputModes only supports ${DEFAULT_INPUT_MODES.join(", ")}; received "${trimmed}".`,
      );
    }

    const mode = trimmed as A2AInboundInputMode;

    if (!seen.has(mode)) {
      seen.add(mode);
      modes.push(mode);
    }
  }

  return modes.length > 0 ? modes : [...DEFAULT_INPUT_MODES];
}

function parseSkills(value: unknown): A2AInboundSkillConfig[] {
  if (!Array.isArray(value)) {
    return DEFAULT_SKILLS.map((skill) => ({
      ...skill,
      tags: [...skill.tags],
      examples: [...skill.examples],
    }));
  }

  const skills: A2AInboundSkillConfig[] = [];

  for (const item of value) {
    const record = asRecord(item);
    const id = readOptionalString(record.id);
    const name = readOptionalString(record.name);

    if (!id || !name) {
      continue;
    }

    skills.push({
      id,
      name,
      ...(readOptionalString(record.description)
        ? { description: readOptionalString(record.description) }
        : {}),
      tags: readStringArray(record.tags, []),
      examples: readStringArray(record.examples, []),
    });
  }

  return skills.length > 0
    ? skills
    : DEFAULT_SKILLS.map((skill) => ({
        ...skill,
        tags: [...skill.tags],
        examples: [...skill.examples],
      }));
}

const FORBIDDEN_ACCOUNT_KEYS = [
  "restPath",
  "capabilities",
  "auth",
  "taskStore",
] as const;

function assertNoForbiddenAccountKeys(
  accountId: string,
  record: JsonRecord,
): void {
  for (const key of FORBIDDEN_ACCOUNT_KEYS) {
    if (key in record) {
      throw new Error(
        `channels.${CHANNEL_ID}.accounts.${accountId}.${key} is not supported; remove "${key}" from the A2A inbound account config.`,
      );
    }
  }
}

function parseAccount(
  accountId: string,
  value: unknown,
): A2AInboundAccountConfig {
  const record = asRecord(value);
  assertNoForbiddenAccountKeys(accountId, record);

  return {
    accountId,
    enabled: readBoolean(record.enabled, true),
    label: readString(record.label, accountId),
    ...(readOptionalString(record.description)
      ? { description: readOptionalString(record.description) }
      : {}),
    ...(readOptionalUrl(record.publicBaseUrl)
      ? { publicBaseUrl: readOptionalUrl(record.publicBaseUrl) }
      : {}),
    ...(readOptionalString(record.defaultAgentId)
      ? { defaultAgentId: readOptionalString(record.defaultAgentId) }
      : {}),
    ...(readOptionalString(record.sessionStore)
      ? { sessionStore: readOptionalString(record.sessionStore) }
      : {}),
    protocolVersion: readString(
      record.protocolVersion,
      DEFAULT_PROTOCOL_VERSION,
    ),
    agentCardPath: normalizePath(record.agentCardPath, DEFAULT_AGENT_CARD_PATH),
    jsonRpcPath: normalizePath(record.jsonRpcPath, DEFAULT_JSON_RPC_PATH),
    maxBodyBytes: readPositiveInteger(record.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
    defaultInputModes: parseDefaultInputModes(accountId, record.defaultInputModes),
    defaultOutputModes: readStringArray(record.defaultOutputModes, DEFAULT_OUTPUT_MODES),
    skills: parseSkills(record.skills),
  };
}

function validateEnabledRoutePaths(
  accounts: readonly A2AInboundAccountConfig[],
): void {
  const exactRoutes = new Map<string, string>();

  const registerExactRoute = (accountId: string, path: string): void => {
    const owner = exactRoutes.get(path);

    if (owner) {
      throw new Error(
        `channels.${CHANNEL_ID}.accounts.${accountId} reuses route path "${path}" already assigned to account "${owner}"`,
      );
    }

    exactRoutes.set(path, accountId);
  };

  for (const account of accounts) {
    if (!account.enabled) {
      continue;
    }

    const paths = [
      account.agentCardPath,
      account.jsonRpcPath,
    ];

    for (const path of paths) {
      registerExactRoute(account.accountId, path);
    }
  }
}

export function parseA2AInboundChannelConfig(
  rootConfig: unknown,
): A2AInboundChannelConfig {
  const root = asRecord(rootConfig);
  const channels = asRecord(root.channels);
  const rawChannelConfig = asRecord(channels[CHANNEL_ID]);
  const rawAccounts = asRecord(rawChannelConfig.accounts);
  const accounts = Object.fromEntries(
    Object.keys(rawAccounts)
      .sort()
      .map((accountId) => [accountId, parseAccount(accountId, rawAccounts[accountId])]),
  ) as Record<string, A2AInboundAccountConfig>;

  validateEnabledRoutePaths(Object.values(accounts));

  return {
    accounts,
  };
}

export function listA2AInboundAccountIds(rootConfig: unknown): string[] {
  return Object.keys(parseA2AInboundChannelConfig(rootConfig).accounts);
}

export function resolveA2AInboundDefaultAccountId(
  config: A2AInboundChannelConfig,
): string | undefined {
  const accounts = Object.values(config.accounts);
  const enabled = accounts.find((account) => account.enabled);

  return enabled?.accountId ?? accounts[0]?.accountId;
}

export function resolveA2AInboundAccount(
  rootConfig: unknown,
  accountId?: string | null,
): A2AInboundAccountConfig {
  const config = parseA2AInboundChannelConfig(rootConfig);
  const resolvedAccountId =
    accountId?.trim() || resolveA2AInboundDefaultAccountId(config) || "default";

  return (
    config.accounts[resolvedAccountId] ??
    parseAccount(resolvedAccountId, { label: resolvedAccountId, enabled: false })
  );
}

export function isA2AInboundAccountConfigured(
  account: A2AInboundAccountConfig,
): boolean {
  return Boolean(account.publicBaseUrl);
}

export function explainA2AInboundAccountUnconfigured(
  account: A2AInboundAccountConfig,
): string {
  if (!account.publicBaseUrl) {
    return "publicBaseUrl is required to advertise a valid agent card.";
  }

  return "account is not ready to start.";
}
