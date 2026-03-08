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
  DEFAULT_REST_PATH,
} from "./constants.js";

type JsonRecord = Record<string, unknown>;

export interface A2AInboundSkillConfig {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  examples: string[];
}

export interface A2AInboundAuthConfig {
  mode: "none" | "header-token";
  headerName: string;
  token?: string;
  tokenEnv?: string;
}

export interface A2AInboundTaskStoreConfig {
  kind: "memory" | "json-file";
  path?: string;
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
  restPath: string;
  maxBodyBytes: number;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AInboundSkillConfig[];
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    rest: boolean;
  };
  auth: A2AInboundAuthConfig;
  taskStore: A2AInboundTaskStoreConfig;
}

export interface A2AInboundChannelConfig {
  accounts: Record<string, A2AInboundAccountConfig>;
}

const DEFAULT_SKILLS: readonly A2AInboundSkillConfig[] = [
  {
    id: "chat",
    name: "Chat",
    description:
      "Routes inbound A2A text requests into the configured OpenClaw agent.",
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
          restPath: {
            type: "string",
            default: DEFAULT_REST_PATH,
          },
          maxBodyBytes: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_MAX_BODY_BYTES,
          },
          defaultInputModes: {
            type: "array",
            items: { type: "string" },
            default: ["text"],
          },
          defaultOutputModes: {
            type: "array",
            items: { type: "string" },
            default: ["text"],
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
          capabilities: {
            type: "object",
            additionalProperties: false,
            properties: {
              streaming: { type: "boolean", default: false },
              pushNotifications: { type: "boolean", default: false },
              rest: { type: "boolean", default: true },
            },
          },
          auth: {
            type: "object",
            additionalProperties: false,
            properties: {
              mode: {
                type: "string",
                enum: ["none", "header-token"],
                default: "none",
              },
              headerName: {
                type: "string",
                default: "authorization",
              },
              token: {
                type: "string",
              },
              tokenEnv: {
                type: "string",
              },
            },
          },
          taskStore: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: {
                type: "string",
                enum: ["memory", "json-file"],
                default: "memory",
              },
              path: {
                type: "string",
              },
            },
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
  "accounts.*.restPath": {
    label: "REST Path",
    help: "HTTP path serving the A2A REST transport.",
    advanced: true,
  },
  "accounts.*.auth.mode": {
    label: "Auth Mode",
    help: "Choose whether the inbound endpoint is unauthenticated or guarded by a shared header token.",
  },
  "accounts.*.auth.headerName": {
    label: "Auth Header",
    help: "Header name checked when auth.mode is header-token.",
    advanced: true,
  },
  "accounts.*.auth.token": {
    label: "Static Auth Token",
    help: "Optional shared secret for header-token auth.",
    advanced: true,
    sensitive: true,
  },
  "accounts.*.auth.tokenEnv": {
    label: "Auth Token Env Var",
    help: "Environment variable used to load the shared secret.",
    advanced: true,
  },
  "accounts.*.taskStore.kind": {
    label: "Task Store Kind",
    help: "Choose whether A2A tasks are kept in memory or persisted under a single-writer runtime directory.",
    advanced: true,
  },
  "accounts.*.taskStore.path": {
    label: "Task Store Path",
    help: "Required when taskStore.kind is json-file. The path is a runtime-store directory root, not a single file.",
    advanced: true,
    placeholder: "/var/lib/openclaw/a2a-runtime",
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

function parseAuth(value: unknown): A2AInboundAuthConfig {
  const record = asRecord(value);
  const mode = record.mode === "header-token" ? "header-token" : "none";

  return {
    mode,
    headerName: readString(record.headerName, "authorization"),
    ...(readOptionalString(record.token)
      ? { token: readOptionalString(record.token) }
      : {}),
    ...(readOptionalString(record.tokenEnv)
      ? { tokenEnv: readOptionalString(record.tokenEnv) }
      : {}),
  };
}

function parseTaskStore(value: unknown): A2AInboundTaskStoreConfig {
  const record = asRecord(value);
  const kind = record.kind === "json-file" ? "json-file" : "memory";

  return {
    kind,
    ...(readOptionalString(record.path)
      ? { path: readOptionalString(record.path) }
      : {}),
  };
}

function parseAccount(
  accountId: string,
  value: unknown,
): A2AInboundAccountConfig {
  const record = asRecord(value);

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
    restPath: normalizePath(record.restPath, DEFAULT_REST_PATH),
    maxBodyBytes: readPositiveInteger(record.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
    defaultInputModes: readStringArray(record.defaultInputModes, ["text"]),
    defaultOutputModes: readStringArray(record.defaultOutputModes, ["text"]),
    skills: parseSkills(record.skills),
    capabilities: {
      streaming: readBoolean(
        asRecord(record.capabilities).streaming,
        false,
      ),
      pushNotifications: readBoolean(
        asRecord(record.capabilities).pushNotifications,
        false,
      ),
      rest: readBoolean(asRecord(record.capabilities).rest, true),
    },
    auth: parseAuth(record.auth),
    taskStore: parseTaskStore(record.taskStore),
  };
}

function validateEnabledRoutePaths(
  accounts: readonly A2AInboundAccountConfig[],
): void {
  const seen = new Map<string, string>();

  for (const account of accounts) {
    if (!account.enabled) {
      continue;
    }

    const paths = [
      account.agentCardPath,
      account.jsonRpcPath,
      ...(account.capabilities.rest ? [account.restPath] : []),
    ];

    for (const path of paths) {
      const owner = seen.get(path);

      if (owner) {
        throw new Error(
          `channels.${CHANNEL_ID}.accounts.${account.accountId} reuses route path "${path}" already assigned to account "${owner}"`,
        );
      }

      seen.set(path, account.accountId);
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

export function resolveConfiguredAuthToken(
  auth: A2AInboundAuthConfig,
): string | undefined {
  if (auth.mode !== "header-token") {
    return undefined;
  }

  if (auth.token) {
    return auth.token;
  }

  if (auth.tokenEnv) {
    const envValue = process.env[auth.tokenEnv];
    return typeof envValue === "string" && envValue.trim().length > 0
      ? envValue.trim()
      : undefined;
  }

  return undefined;
}

export function isA2AInboundAccountConfigured(
  account: A2AInboundAccountConfig,
): boolean {
  if (!account.publicBaseUrl) {
    return false;
  }

  if (account.taskStore.kind === "json-file" && !account.taskStore.path) {
    return false;
  }

  if (account.auth.mode === "header-token") {
    return resolveConfiguredAuthToken(account.auth) !== undefined;
  }

  return true;
}

export function explainA2AInboundAccountUnconfigured(
  account: A2AInboundAccountConfig,
): string {
  if (!account.publicBaseUrl) {
    return "publicBaseUrl is required to advertise a valid agent card.";
  }

  if (
    account.auth.mode === "header-token" &&
    resolveConfiguredAuthToken(account.auth) === undefined
  ) {
    return "auth.mode=header-token requires auth.token or an env var referenced by auth.tokenEnv.";
  }

  if (account.taskStore.kind === "json-file" && !account.taskStore.path) {
    return "taskStore.kind=json-file requires taskStore.path.";
  }

  return "account is not ready to start.";
}
