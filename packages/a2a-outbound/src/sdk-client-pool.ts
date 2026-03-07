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
  acceptedOutputModes?: string[];
  normalizeBaseUrl?: boolean;
  enforceSupportedTransports?: boolean;
}

export interface ResolvedTarget {
  baseUrl: string;
  cardPath: string;
  preferredTransports: A2ATransport[];
}

type ClientEntry = {
  client: Client;
  target: ResolvedTarget;
};

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

function mergeUniqueStrings(values: readonly unknown[]): string[] {
  const deduped: string[] = [];

  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") {
      continue;
    }

    if (!deduped.includes(value)) {
      deduped.push(value);
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

export class SDKClientPool {
  private readonly cache = new Map<string, ClientEntry>();

  private readonly defaultCardPath: string;

  private readonly defaultPreferredTransports: A2ATransport[];

  private readonly acceptedOutputModes: string[];

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

    this.acceptedOutputModes = mergeUniqueStrings(
      options.acceptedOutputModes ?? [],
    );
    this.shouldNormalizeBaseUrl =
      options.normalizeBaseUrl ??
      A2A_OUTBOUND_DEFAULT_CONFIG.policy.normalizeBaseUrl;
    this.shouldEnforceSupportedTransports =
      options.enforceSupportedTransports ??
      A2A_OUTBOUND_DEFAULT_CONFIG.policy.enforceSupportedTransports;
  }

  normalizeTarget(target: A2ATargetInput): ResolvedTarget {
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
    };
  }

  buildFactoryOptions(
    preferredTransports: A2ATransport[],
  ): ClientFactoryOptions {
    const overrides: Partial<ClientFactoryOptions> = {
      preferredTransports,
    };

    if (this.acceptedOutputModes.length > 0) {
      overrides.clientConfig = {
        acceptedOutputModes: this.acceptedOutputModes,
      };
    }

    return ClientFactoryOptions.createFrom(
      ClientFactoryOptions.default,
      overrides,
    );
  }

  async get(target: A2ATargetInput): Promise<ClientEntry> {
    const normalized = this.normalizeTarget(target);
    const key = clientKey(normalized);

    const existing = this.cache.get(key);
    if (existing) {
      return existing;
    }

    const factory = new ClientFactory(
      this.buildFactoryOptions(normalized.preferredTransports),
    );

    const client = await factory.createFromUrl(
      normalized.baseUrl,
      normalized.cardPath,
    );

    const entry: ClientEntry = {
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
