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

export interface A2AOutboundPolicyConfig {
  acceptedOutputModes: string[];
  normalizeBaseUrl: boolean;
  enforceSupportedTransports: boolean;
}

export interface A2AOutboundPluginConfig {
  enabled: boolean;
  defaults: A2AOutboundDefaultsConfig;
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
  policy: {
    acceptedOutputModes: [],
    normalizeBaseUrl: true,
    enforceSupportedTransports: true,
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
};

function cloneConfig(config: A2AOutboundPluginConfig): A2AOutboundPluginConfig {
  return {
    enabled: config.enabled,
    defaults: {
      timeoutMs: config.defaults.timeoutMs,
      cardPath: config.defaults.cardPath,
      preferredTransports: [...config.defaults.preferredTransports],
      serviceParameters: { ...config.defaults.serviceParameters },
    },
    policy: {
      acceptedOutputModes: [...config.policy.acceptedOutputModes],
      normalizeBaseUrl: config.policy.normalizeBaseUrl,
      enforceSupportedTransports: config.policy.enforceSupportedTransports,
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

export function parseA2AOutboundPluginConfig(
  input: unknown,
): A2AOutboundPluginConfig {
  if (!isPlainObject(input)) {
    return cloneConfig(A2A_OUTBOUND_DEFAULT_CONFIG);
  }

  const rawDefaults = isPlainObject(input.defaults) ? input.defaults : {};
  const rawPolicy = isPlainObject(input.policy) ? input.policy : {};

  return {
    enabled: readBoolean(input.enabled, A2A_OUTBOUND_DEFAULT_CONFIG.enabled),
    defaults: {
      timeoutMs: readPositiveInteger(
        rawDefaults.timeoutMs,
        A2A_OUTBOUND_DEFAULT_CONFIG.defaults.timeoutMs,
      ),
      cardPath:
        typeof rawDefaults.cardPath === "string" &&
        rawDefaults.cardPath.trim() !== ""
          ? rawDefaults.cardPath
          : A2A_OUTBOUND_DEFAULT_CONFIG.defaults.cardPath,
      preferredTransports: normalizeTransports(
        rawDefaults.preferredTransports,
        A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports,
      ),
      serviceParameters: normalizeStringMap(
        rawDefaults.serviceParameters,
        A2A_OUTBOUND_DEFAULT_CONFIG.defaults.serviceParameters,
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
