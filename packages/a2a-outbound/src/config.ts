import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";
import {
  ALL_TRANSPORTS,
  SUPPORTED_TRANSPORTS,
  type A2ATransport,
} from "./constants.js";

export interface A2AOutboundDefaultsConfig {
  timeoutMs: number;
  cardPath: string;
  preferredTransports: A2ATransport[];
  serviceParameters: Record<string, string>;
}

export interface A2AOutboundTargetConfig {
  alias: string;
  baseUrl: string;
  description?: string;
  tags: string[];
  cardPath: string;
  preferredTransports: A2ATransport[];
  examples: string[];
  default: boolean;
}

export interface A2AOutboundTaskHandlesConfig {
  ttlMs: number;
  maxEntries: number;
}

export interface A2AOutboundPolicyConfig {
  acceptedOutputModes: string[];
  normalizeBaseUrl: boolean;
  enforceSupportedTransports: boolean;
  allowTargetUrlOverride: boolean;
}

export interface A2AOutboundPluginConfig {
  enabled: boolean;
  defaults: A2AOutboundDefaultsConfig;
  targets: A2AOutboundTargetConfig[];
  taskHandles: A2AOutboundTaskHandlesConfig;
  policy: A2AOutboundPolicyConfig;
}

export const A2A_OUTBOUND_DEFAULT_CONFIG: A2AOutboundPluginConfig = {
  enabled: false,
  defaults: {
    timeoutMs: 120000,
    cardPath: "/.well-known/agent-card.json",
    preferredTransports: [...SUPPORTED_TRANSPORTS],
    serviceParameters: {},
  },
  targets: [],
  taskHandles: {
    ttlMs: 86400000,
    maxEntries: 1000,
  },
  policy: {
    acceptedOutputModes: [],
    normalizeBaseUrl: true,
    enforceSupportedTransports: true,
    allowTargetUrlOverride: false,
  },
};

export const A2A_OUTBOUND_CONFIG_JSON_SCHEMA: NonNullable<
  OpenClawPluginConfigSchema["jsonSchema"]
> = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
      default: A2A_OUTBOUND_DEFAULT_CONFIG.enabled,
    },
    defaults: {
      type: "object",
      additionalProperties: false,
      properties: {
        timeoutMs: {
          type: "integer",
          minimum: 1,
          default: A2A_OUTBOUND_DEFAULT_CONFIG.defaults.timeoutMs,
        },
        cardPath: {
          type: "string",
          default: A2A_OUTBOUND_DEFAULT_CONFIG.defaults.cardPath,
        },
        preferredTransports: {
          type: "array",
          items: {
            type: "string",
            enum: [...ALL_TRANSPORTS],
          },
          default: [...A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports],
        },
        serviceParameters: {
          type: "object",
          additionalProperties: { type: "string" },
          default: { ...A2A_OUTBOUND_DEFAULT_CONFIG.defaults.serviceParameters },
        },
      },
    },
    targets: {
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["alias", "baseUrl"],
        properties: {
          alias: {
            type: "string",
          },
          baseUrl: {
            type: "string",
          },
          description: {
            type: "string",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          cardPath: {
            type: "string",
            default: A2A_OUTBOUND_DEFAULT_CONFIG.defaults.cardPath,
          },
          preferredTransports: {
            type: "array",
            items: {
              type: "string",
              enum: [...ALL_TRANSPORTS],
            },
            default: [...A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports],
          },
          examples: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          default: {
            type: "boolean",
            default: false,
          },
        },
      },
    },
    taskHandles: {
      type: "object",
      additionalProperties: false,
      properties: {
        ttlMs: {
          type: "integer",
          minimum: 1,
          default: A2A_OUTBOUND_DEFAULT_CONFIG.taskHandles.ttlMs,
        },
        maxEntries: {
          type: "integer",
          minimum: 1,
          default: A2A_OUTBOUND_DEFAULT_CONFIG.taskHandles.maxEntries,
        },
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      properties: {
        acceptedOutputModes: {
          type: "array",
          items: { type: "string" },
          default: [...A2A_OUTBOUND_DEFAULT_CONFIG.policy.acceptedOutputModes],
        },
        normalizeBaseUrl: {
          type: "boolean",
          default: A2A_OUTBOUND_DEFAULT_CONFIG.policy.normalizeBaseUrl,
        },
        enforceSupportedTransports: {
          type: "boolean",
          default: A2A_OUTBOUND_DEFAULT_CONFIG.policy.enforceSupportedTransports,
        },
        allowTargetUrlOverride: {
          type: "boolean",
          default: A2A_OUTBOUND_DEFAULT_CONFIG.policy.allowTargetUrlOverride,
        },
      },
    },
  },
};

export const A2A_OUTBOUND_CONFIG_UI_HINTS: NonNullable<
  OpenClawPluginConfigSchema["uiHints"]
> = {
  enabled: {
    label: "Enable A2A Outbound",
    help: "Registers outbound A2A delegation tools when enabled.",
  },
  "defaults.timeoutMs": {
    label: "Default Timeout (ms)",
    help: "Fallback request timeout for delegated A2A operations.",
    advanced: true,
  },
  "defaults.cardPath": {
    label: "Agent Card Path",
    help: "Path used to discover the remote agent card.",
    advanced: true,
    placeholder: "/.well-known/agent-card.json",
  },
  "defaults.preferredTransports": {
    label: "Preferred Transports",
    help: "Ordered transport preference when connecting to peers.",
    advanced: true,
  },
  "defaults.serviceParameters": {
    label: "Default Service Parameters",
    help: "Default headers or provider-specific request parameters.",
    advanced: true,
  },
  targets: {
    label: "Named Targets",
    help: "Registry of reusable outbound A2A targets for future routing phases.",
  },
  "taskHandles.ttlMs": {
    label: "Task Handle TTL (ms)",
    help: "Retention window for cached delegated task handles.",
    advanced: true,
  },
  "taskHandles.maxEntries": {
    label: "Task Handle Cache Size",
    help: "Maximum number of delegated task handles retained locally.",
    advanced: true,
  },
  "policy.acceptedOutputModes": {
    label: "Accepted Output Modes",
    help: "Allowed response media types for outbound client requests.",
    advanced: true,
  },
  "policy.normalizeBaseUrl": {
    label: "Normalize Base URL",
    help: "Normalizes target URLs before client resolution.",
    advanced: true,
  },
  "policy.enforceSupportedTransports": {
    label: "Enforce Supported Transports",
    help: "Rejects targets requesting transports unsupported by this build.",
    advanced: true,
  },
  "policy.allowTargetUrlOverride": {
    label: "Allow Target URL Override",
    help: "Permits explicit request URLs to bypass the named target registry.",
    advanced: true,
  },
};

function cloneTargetConfig(
  target: A2AOutboundTargetConfig,
): A2AOutboundTargetConfig {
  return {
    alias: target.alias,
    baseUrl: target.baseUrl,
    ...(target.description !== undefined ? { description: target.description } : {}),
    tags: [...target.tags],
    cardPath: target.cardPath,
    preferredTransports: [...target.preferredTransports],
    examples: [...target.examples],
    default: target.default,
  };
}

function cloneConfig(config: A2AOutboundPluginConfig): A2AOutboundPluginConfig {
  return {
    enabled: config.enabled,
    defaults: {
      timeoutMs: config.defaults.timeoutMs,
      cardPath: config.defaults.cardPath,
      preferredTransports: [...config.defaults.preferredTransports],
      serviceParameters: { ...config.defaults.serviceParameters },
    },
    targets: config.targets.map(cloneTargetConfig),
    taskHandles: {
      ttlMs: config.taskHandles.ttlMs,
      maxEntries: config.taskHandles.maxEntries,
    },
    policy: {
      acceptedOutputModes: [...config.policy.acceptedOutputModes],
      normalizeBaseUrl: config.policy.normalizeBaseUrl,
      enforceSupportedTransports: config.policy.enforceSupportedTransports,
      allowTargetUrlOverride: config.policy.allowTargetUrlOverride,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(
  value: unknown,
  fallback: string[] = [],
): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      continue;
    }

    if (!normalized.includes(entry)) {
      normalized.push(entry);
    }
  }

  return normalized;
}

function normalizeTrimmedStringArray(
  value: unknown,
  fallback: string[] = [],
): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim();
    if (trimmed === "") {
      continue;
    }

    if (!normalized.includes(trimmed)) {
      normalized.push(trimmed);
    }
  }

  return normalized;
}

function normalizeTransports(
  value: unknown,
  fallback: A2ATransport[],
): A2ATransport[] {
  const normalized = normalizeStringArray(value).filter(
    (entry): entry is A2ATransport =>
      ALL_TRANSPORTS.includes(entry as A2ATransport),
  );

  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeTrimmedTransports(
  value: unknown,
  fallback: A2ATransport[],
): A2ATransport[] {
  const normalized = normalizeTrimmedStringArray(value).filter(
    (entry): entry is A2ATransport =>
      ALL_TRANSPORTS.includes(entry as A2ATransport),
  );

  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeStringMap(
  value: unknown,
  fallback: Record<string, string> = {},
): Record<string, string> {
  if (!isPlainObject(value)) {
    return { ...fallback };
  }

  const normalized: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      normalized[key] = entry;
    }
  }

  return normalized;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function readTrimmedString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed !== "" ? trimmed : fallback;
}

function readOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed !== "" ? trimmed : undefined;
}

function invalidConfig(message: string): TypeError {
  return new TypeError(`Invalid a2a-outbound config: ${message}`);
}

function normalizeTargets(
  value: unknown,
  defaults: A2AOutboundDefaultsConfig,
): A2AOutboundTargetConfig[] {
  if (value === undefined) {
    return A2A_OUTBOUND_DEFAULT_CONFIG.targets.map(cloneTargetConfig);
  }

  if (!Array.isArray(value)) {
    throw invalidConfig("targets must be an array");
  }

  const aliases = new Set<string>();
  let defaultTargetAlias: string | undefined;

  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw invalidConfig(`targets[${index}] must be an object`);
    }

    const alias =
      typeof entry.alias === "string" ? entry.alias.trim() : "";
    if (alias === "") {
      throw invalidConfig(`targets[${index}].alias must be a non-empty string`);
    }

    const baseUrl =
      typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
    if (baseUrl === "") {
      throw invalidConfig(
        `targets[${index}].baseUrl must be a non-empty string`,
      );
    }

    if (aliases.has(alias)) {
      throw invalidConfig(`targets contains duplicate alias "${alias}"`);
    }
    aliases.add(alias);

    const normalizedTarget: A2AOutboundTargetConfig = {
      alias,
      baseUrl,
      tags: normalizeTrimmedStringArray(entry.tags),
      cardPath: readTrimmedString(entry.cardPath, defaults.cardPath.trim()),
      preferredTransports: normalizeTrimmedTransports(
        entry.preferredTransports,
        defaults.preferredTransports,
      ),
      examples: normalizeTrimmedStringArray(entry.examples),
      default: readBoolean(entry.default, false),
    };

    const description = readOptionalTrimmedString(entry.description);
    if (description !== undefined) {
      normalizedTarget.description = description;
    }

    if (normalizedTarget.default) {
      if (defaultTargetAlias !== undefined) {
        throw invalidConfig(
          `targets contains multiple default entries ("${defaultTargetAlias}" and "${alias}")`,
        );
      }

      defaultTargetAlias = alias;
    }

    return normalizedTarget;
  });
}

export function parseA2AOutboundPluginConfig(
  input: unknown,
): A2AOutboundPluginConfig {
  if (!isPlainObject(input)) {
    return cloneConfig(A2A_OUTBOUND_DEFAULT_CONFIG);
  }

  const rawDefaults = isPlainObject(input.defaults) ? input.defaults : {};
  const normalizedDefaults: A2AOutboundDefaultsConfig = {
    timeoutMs: readPositiveInteger(
      rawDefaults.timeoutMs,
      A2A_OUTBOUND_DEFAULT_CONFIG.defaults.timeoutMs,
    ),
    cardPath: readString(
      rawDefaults.cardPath,
      A2A_OUTBOUND_DEFAULT_CONFIG.defaults.cardPath,
    ),
    preferredTransports: normalizeTransports(
      rawDefaults.preferredTransports,
      A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports,
    ),
    serviceParameters: normalizeStringMap(
      rawDefaults.serviceParameters,
      A2A_OUTBOUND_DEFAULT_CONFIG.defaults.serviceParameters,
    ),
  };

  const rawTaskHandles = isPlainObject(input.taskHandles)
    ? input.taskHandles
    : {};
  const rawPolicy = isPlainObject(input.policy) ? input.policy : {};

  return {
    enabled: readBoolean(input.enabled, A2A_OUTBOUND_DEFAULT_CONFIG.enabled),
    defaults: normalizedDefaults,
    targets: normalizeTargets(input.targets, normalizedDefaults),
    taskHandles: {
      ttlMs: readPositiveInteger(
        rawTaskHandles.ttlMs,
        A2A_OUTBOUND_DEFAULT_CONFIG.taskHandles.ttlMs,
      ),
      maxEntries: readPositiveInteger(
        rawTaskHandles.maxEntries,
        A2A_OUTBOUND_DEFAULT_CONFIG.taskHandles.maxEntries,
      ),
    },
    policy: {
      acceptedOutputModes: normalizeStringArray(
        rawPolicy.acceptedOutputModes,
        A2A_OUTBOUND_DEFAULT_CONFIG.policy.acceptedOutputModes,
      ),
      normalizeBaseUrl: readBoolean(
        rawPolicy.normalizeBaseUrl,
        A2A_OUTBOUND_DEFAULT_CONFIG.policy.normalizeBaseUrl,
      ),
      enforceSupportedTransports: readBoolean(
        rawPolicy.enforceSupportedTransports,
        A2A_OUTBOUND_DEFAULT_CONFIG.policy.enforceSupportedTransports,
      ),
      allowTargetUrlOverride: readBoolean(
        rawPolicy.allowTargetUrlOverride,
        A2A_OUTBOUND_DEFAULT_CONFIG.policy.allowTargetUrlOverride,
      ),
    },
  };
}

export const A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA: OpenClawPluginConfigSchema =
  {
    parse(value: unknown): A2AOutboundPluginConfig {
      return parseA2AOutboundPluginConfig(value);
    },
    jsonSchema: A2A_OUTBOUND_CONFIG_JSON_SCHEMA,
    uiHints: A2A_OUTBOUND_CONFIG_UI_HINTS,
  };
