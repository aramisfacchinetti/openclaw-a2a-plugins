import {
  ClientFactory,
  ClientFactoryOptions,
  type Client,
} from "@a2a-js/sdk/client";
import {
  ALL_TRANSPORTS,
  SUPPORTED_TRANSPORTS,
  type A2ATransport,
} from "./constants.js";
import { A2A_OUTBOUND_DEFAULT_CONFIG } from "./config.js";
import { A2AOutboundError, ERROR_CODES } from "./errors.js";
import type { A2ATargetInput } from "./schemas.js";

export interface SDKClientPoolOptions {
  defaultCardPath?: string;
  preferredTransports?: A2ATransport[];
  normalizeBaseUrl?: boolean;
  enforceSupportedTransports?: boolean;
}

export interface ResolvedTarget {
  baseUrl: string;
  cardPath: string;
  preferredTransports: A2ATransport[];
  alias?: string;
  displayName?: string;
  description?: string;
  streamingSupported?: boolean;
}

export type SDKClientPoolEntry = {
  client: Client;
  target: ResolvedTarget;
};

export type SDKClientPoolTargetInput = A2ATargetInput &
  Partial<
    Pick<
      ResolvedTarget,
      "alias" | "displayName" | "description" | "streamingSupported"
    >
  >;

function mergeUniqueTransports(values: readonly unknown[]): A2ATransport[] {
  const deduped: A2ATransport[] = [];

  for (const value of values) {
    if (
      typeof value !== "string" ||
      !ALL_TRANSPORTS.includes(value as A2ATransport)
    ) {
      continue;
    }

    if (!deduped.includes(value as A2ATransport)) {
      deduped.push(value as A2ATransport);
    }
  }

  return deduped;
}

function assertSupportedPreferredTransports(
  preferredTransports: A2ATransport[],
): void {
  const unsupported = preferredTransports.filter(
    (transport) =>
      !SUPPORTED_TRANSPORTS.includes(
        transport as (typeof SUPPORTED_TRANSPORTS)[number],
      ),
  );

  if (unsupported.length > 0) {
    throw new A2AOutboundError(
      ERROR_CODES.A2A_SDK_ERROR,
      `unsupported preferred transport(s) in this build: ${unsupported.join(", ")}`,
      {
        unsupported,
        supported: SUPPORTED_TRANSPORTS,
      },
    );
  }
}

function clientKey(target: ResolvedTarget): string {
  return JSON.stringify([
    target.baseUrl,
    target.cardPath,
    ...target.preferredTransports,
  ]);
}

function normalizeBaseUrl(baseUrl: string, normalize: boolean): string {
  if (!normalize) {
    return baseUrl.trim();
  }

  return new URL(baseUrl).toString();
}

function mergeRoutingMetadata(
  target: SDKClientPoolTargetInput,
): Partial<
  Pick<
    ResolvedTarget,
    "alias" | "displayName" | "description" | "streamingSupported"
  >
> {
  return {
    ...(typeof target.alias === "string" && target.alias.trim() !== ""
      ? { alias: target.alias }
      : {}),
    ...(typeof target.displayName === "string" && target.displayName.trim() !== ""
      ? { displayName: target.displayName }
      : {}),
    ...(typeof target.description === "string" && target.description.trim() !== ""
      ? { description: target.description }
      : {}),
    ...(typeof target.streamingSupported === "boolean"
      ? { streamingSupported: target.streamingSupported }
      : {}),
  };
}

export class SDKClientPool {
  private readonly cache = new Map<string, SDKClientPoolEntry>();

  private readonly defaultCardPath: string;

  private readonly defaultPreferredTransports: A2ATransport[];

  private readonly shouldNormalizeBaseUrl: boolean;

  private readonly shouldEnforceSupportedTransports: boolean;

  constructor(options: SDKClientPoolOptions = {}) {
    this.defaultCardPath =
      options.defaultCardPath ?? A2A_OUTBOUND_DEFAULT_CONFIG.defaults.cardPath;

    const normalizedPreferredTransports = mergeUniqueTransports(
      options.preferredTransports ??
        A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports,
    );

    this.defaultPreferredTransports =
      normalizedPreferredTransports.length > 0
        ? normalizedPreferredTransports
        : [...A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports];
    this.shouldNormalizeBaseUrl =
      options.normalizeBaseUrl ??
      A2A_OUTBOUND_DEFAULT_CONFIG.policy.normalizeBaseUrl;
    this.shouldEnforceSupportedTransports =
      options.enforceSupportedTransports ??
      A2A_OUTBOUND_DEFAULT_CONFIG.policy.enforceSupportedTransports;
  }

  normalizeTarget(target: SDKClientPoolTargetInput): ResolvedTarget {
    const preferredTransports = mergeUniqueTransports(
      target.preferredTransports && target.preferredTransports.length > 0
        ? target.preferredTransports
        : this.defaultPreferredTransports,
    );

    if (this.shouldEnforceSupportedTransports) {
      assertSupportedPreferredTransports(preferredTransports);
    }

    return {
      baseUrl: normalizeBaseUrl(target.baseUrl, this.shouldNormalizeBaseUrl),
      cardPath: target.cardPath ?? this.defaultCardPath,
      preferredTransports,
      ...mergeRoutingMetadata(target),
    };
  }

  buildFactoryOptions(
    preferredTransports: A2ATransport[],
  ): ClientFactoryOptions {
    return ClientFactoryOptions.createFrom(
      ClientFactoryOptions.default,
      {
        preferredTransports,
      },
    );
  }

  async get(target: SDKClientPoolTargetInput): Promise<SDKClientPoolEntry> {
    const normalized = this.normalizeTarget(target);
    const key = clientKey(normalized);

    const existing = this.cache.get(key);
    if (existing) {
      return {
        client: existing.client,
        target: normalized,
      };
    }

    const factory = new ClientFactory(
      this.buildFactoryOptions(normalized.preferredTransports),
    );

    const client = await factory.createFromUrl(
      normalized.baseUrl,
      normalized.cardPath,
    );

    const entry: SDKClientPoolEntry = {
      client,
      target: normalized,
    };

    this.cache.set(key, entry);

    return entry;
  }
}

export function createClientPool(
  options: SDKClientPoolOptions = {},
): SDKClientPool {
  return new SDKClientPool(options);
}
