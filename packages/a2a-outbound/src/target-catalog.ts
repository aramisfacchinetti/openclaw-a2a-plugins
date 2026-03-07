import type { AgentCard } from "@a2a-js/sdk";
import type { A2AOutboundPluginConfig } from "./config.js";
import {
  type A2AOutboundErrorCode,
  A2AOutboundError,
  ERROR_CODES,
  toToolError,
  type ToolError,
} from "./errors.js";
import type { A2ATargetInput } from "./schemas.js";
import type { ResolvedTarget, SDKClientPool } from "./sdk-client-pool.js";

export interface TargetCatalogSkillSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
}

export interface TargetCardCacheEntry {
  displayName?: string;
  description?: string;
  skillSummaries: TargetCatalogSkillSummary[];
  streamingSupported?: boolean;
  preferredTransport?: string;
  lastRefreshedAt?: string;
  lastRefreshError?: ToolError;
}

export interface TargetCatalogEntry {
  target: ResolvedTarget;
  configuredDescription?: string;
  default: boolean;
  tags: string[];
  examples: string[];
  card: TargetCardCacheEntry;
}

export interface TargetCatalogOptions {
  config: A2AOutboundPluginConfig;
  clientPool: SDKClientPool;
}

export interface TargetCatalogHydrationOptions {
  force?: boolean;
}

type ConfiguredTargetEntry = {
  alias: string;
  configuredDescription?: string;
  default: boolean;
  tags: readonly string[];
  examples: readonly string[];
  target: ResolvedTarget;
};

type TargetResolutionErrorReason =
  | "unknown_alias"
  | "unknown_raw_url"
  | "raw_url_disallowed_by_policy"
  | "ambiguous_normalized_url_matches";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function cloneSkillSummary(
  summary: TargetCatalogSkillSummary,
): TargetCatalogSkillSummary {
  return {
    id: summary.id,
    name: summary.name,
    description: summary.description,
    tags: [...summary.tags],
    examples: [...summary.examples],
  };
}

function cloneCardCacheEntry(entry: TargetCardCacheEntry): TargetCardCacheEntry {
  return {
    ...(entry.displayName !== undefined
      ? { displayName: entry.displayName }
      : {}),
    ...(entry.description !== undefined
      ? { description: entry.description }
      : {}),
    skillSummaries: entry.skillSummaries.map(cloneSkillSummary),
    ...(typeof entry.streamingSupported === "boolean"
      ? { streamingSupported: entry.streamingSupported }
      : {}),
    ...(entry.preferredTransport !== undefined
      ? { preferredTransport: entry.preferredTransport }
      : {}),
    ...(entry.lastRefreshedAt !== undefined
      ? { lastRefreshedAt: entry.lastRefreshedAt }
      : {}),
    ...(entry.lastRefreshError !== undefined
      ? { lastRefreshError: entry.lastRefreshError }
      : {}),
  };
}

function emptyCardCacheEntry(): TargetCardCacheEntry {
  return {
    skillSummaries: [],
  };
}

function summarizeSkill(
  skill: AgentCard["skills"][number],
): TargetCatalogSkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [...skill.tags],
    examples: [...(skill.examples ?? [])],
  };
}

function fallbackErrorCode(error: unknown): A2AOutboundErrorCode {
  return error instanceof A2AOutboundError
    ? error.code
    : ERROR_CODES.A2A_SDK_ERROR;
}

function targetResolutionError(
  reason: TargetResolutionErrorReason,
  message: string,
  details: Record<string, unknown>,
): A2AOutboundError {
  return new A2AOutboundError(ERROR_CODES.TARGET_RESOLUTION_ERROR, message, {
    reason,
    ...details,
  });
}

export class TargetCatalog {
  private readonly config: A2AOutboundPluginConfig;

  private readonly clientPool: SDKClientPool;

  private readonly configuredEntries: readonly ConfiguredTargetEntry[];

  private readonly targetsByAlias: ReadonlyMap<string, ConfiguredTargetEntry>;

  private readonly targetsByNormalizedBaseUrl: ReadonlyMap<
    string,
    readonly ConfiguredTargetEntry[]
  >;

  private readonly defaultTargetAlias: string | undefined;

  private readonly cardCache = new Map<string, TargetCardCacheEntry>();

  private readonly cardRefreshes = new Map<
    string,
    Promise<TargetCardCacheEntry>
  >();

  constructor(options: TargetCatalogOptions) {
    this.config = options.config;
    this.clientPool = options.clientPool;

    const targetsByAlias = new Map<string, ConfiguredTargetEntry>();
    const targetsByNormalizedBaseUrl = new Map<string, ConfiguredTargetEntry[]>();
    let defaultTargetAlias: string | undefined;

    const configuredEntries = this.config.targets.map((targetConfig) => {
      const target = this.clientPool.normalizeTarget(targetConfig);
      const entry: ConfiguredTargetEntry = {
        alias: targetConfig.alias,
        ...(targetConfig.description !== undefined
          ? { configuredDescription: targetConfig.description }
          : {}),
        default: targetConfig.default,
        tags: Object.freeze([...targetConfig.tags]),
        examples: Object.freeze([...targetConfig.examples]),
        target: {
          ...target,
          alias: targetConfig.alias,
          ...(targetConfig.description !== undefined
            ? { description: targetConfig.description }
            : {}),
        },
      };

      targetsByAlias.set(entry.alias, entry);

      const existing = targetsByNormalizedBaseUrl.get(entry.target.baseUrl) ?? [];
      targetsByNormalizedBaseUrl.set(entry.target.baseUrl, [...existing, entry]);

      if (entry.default) {
        defaultTargetAlias = entry.alias;
      }

      return entry;
    });

    this.configuredEntries = Object.freeze(configuredEntries);
    this.targetsByAlias = targetsByAlias;
    this.targetsByNormalizedBaseUrl = new Map(
      [...targetsByNormalizedBaseUrl.entries()].map(([baseUrl, entries]) => [
        baseUrl,
        Object.freeze([...entries]),
      ]),
    );
    this.defaultTargetAlias = defaultTargetAlias;
  }

  listEntries(): TargetCatalogEntry[] {
    return this.configuredEntries.map((entry) => this.toCatalogEntry(entry));
  }

  getEntry(alias: string): TargetCatalogEntry | undefined {
    const normalizedAlias = alias.trim();
    const entry = this.targetsByAlias.get(normalizedAlias);
    return entry ? this.toCatalogEntry(entry) : undefined;
  }

  resolveAlias(alias: string): ResolvedTarget {
    return this.resolveConfiguredEntry(this.requireAlias(alias));
  }

  resolveDefaultTarget(): ResolvedTarget | undefined {
    return this.defaultTargetAlias
      ? this.resolveConfiguredEntry(this.requireAlias(this.defaultTargetAlias))
      : undefined;
  }

  resolveConfiguredRawTarget(target: A2ATargetInput): ResolvedTarget {
    const normalizedTarget = this.clientPool.normalizeTarget(target);
    const entry = this.findConfiguredEntry(normalizedTarget);

    if (!entry) {
      throw targetResolutionError(
        "unknown_raw_url",
        `no configured target matches raw URL "${target.baseUrl}"`,
        {
          inputBaseUrl: target.baseUrl,
          normalizedBaseUrl: normalizedTarget.baseUrl,
        },
      );
    }

    return this.resolveMatchedRawTarget(normalizedTarget, entry);
  }

  resolveRawTarget(target: A2ATargetInput): ResolvedTarget {
    const normalizedTarget = this.clientPool.normalizeTarget(target);
    const entry = this.findConfiguredEntry(normalizedTarget);

    if (entry) {
      return this.resolveMatchedRawTarget(normalizedTarget, entry);
    }

    if (
      this.config.targets.length > 0 &&
      this.config.policy.allowTargetUrlOverride !== true
    ) {
      throw targetResolutionError(
        "raw_url_disallowed_by_policy",
        `raw target URL "${target.baseUrl}" is not allowed by policy`,
        {
          inputBaseUrl: target.baseUrl,
          normalizedBaseUrl: normalizedTarget.baseUrl,
          allowTargetUrlOverride: this.config.policy.allowTargetUrlOverride,
          configuredAliases: this.config.targets.map((entry) => entry.alias),
        },
      );
    }

    return this.applyCachedMetadata(normalizedTarget);
  }

  async hydrateConfiguredTarget(
    alias: string,
    options: TargetCatalogHydrationOptions = {},
  ): Promise<TargetCatalogEntry> {
    const entry = this.requireAlias(alias);
    await this.loadCardMetadata(entry.target, options);
    return this.toCatalogEntry(entry);
  }

  async hydrateResolvedTarget(
    target: ResolvedTarget,
    options: TargetCatalogHydrationOptions = {},
  ): Promise<ResolvedTarget> {
    await this.loadCardMetadata(target, options);
    return this.applyCachedMetadata(target);
  }

  private requireAlias(alias: string): ConfiguredTargetEntry {
    const normalizedAlias = alias.trim();
    const entry = this.targetsByAlias.get(normalizedAlias);

    if (!entry) {
      throw targetResolutionError(
        "unknown_alias",
        `unknown target alias "${normalizedAlias}"`,
        {
          alias: normalizedAlias,
          availableAliases: this.configuredEntries.map((item) => item.alias),
        },
      );
    }

    return entry;
  }

  private findConfiguredEntry(
    normalizedTarget: ResolvedTarget,
  ): ConfiguredTargetEntry | undefined {
    const matches =
      this.targetsByNormalizedBaseUrl.get(normalizedTarget.baseUrl) ?? [];

    if (matches.length <= 1) {
      return matches[0];
    }

    throw targetResolutionError(
      "ambiguous_normalized_url_matches",
      `raw target URL "${normalizedTarget.baseUrl}" matches multiple configured targets`,
      {
        normalizedBaseUrl: normalizedTarget.baseUrl,
        aliases: matches.map((entry) => entry.alias),
      },
    );
  }

  private resolveConfiguredEntry(entry: ConfiguredTargetEntry): ResolvedTarget {
    return this.applyCachedMetadata(entry.target);
  }

  private resolveMatchedRawTarget(
    normalizedTarget: ResolvedTarget,
    entry: ConfiguredTargetEntry,
  ): ResolvedTarget {
    return this.applyCachedMetadata({
      ...normalizedTarget,
      alias: entry.alias,
      ...(entry.configuredDescription !== undefined
        ? { description: entry.configuredDescription }
        : {}),
    });
  }

  private toCatalogEntry(entry: ConfiguredTargetEntry): TargetCatalogEntry {
    return {
      target: this.applyCachedMetadata(entry.target),
      ...(entry.configuredDescription !== undefined
        ? { configuredDescription: entry.configuredDescription }
        : {}),
      default: entry.default,
      tags: [...entry.tags],
      examples: [...entry.examples],
      card: this.cardCacheSnapshot(entry.target.baseUrl),
    };
  }

  private cardCacheSnapshot(normalizedBaseUrl: string): TargetCardCacheEntry {
    const existing = this.cardCache.get(normalizedBaseUrl);
    return cloneCardCacheEntry(existing ?? emptyCardCacheEntry());
  }

  private applyCachedMetadata(target: ResolvedTarget): ResolvedTarget {
    const cached = this.cardCache.get(target.baseUrl);
    const displayName = target.displayName ?? cached?.displayName;
    const description = target.description ?? cached?.description;
    const streamingSupported =
      target.streamingSupported ?? cached?.streamingSupported;

    return {
      baseUrl: target.baseUrl,
      cardPath: target.cardPath,
      preferredTransports: [...target.preferredTransports],
      ...(target.alias !== undefined ? { alias: target.alias } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(streamingSupported !== undefined ? { streamingSupported } : {}),
    };
  }

  private async loadCardMetadata(
    target: ResolvedTarget,
    options: TargetCatalogHydrationOptions,
  ): Promise<TargetCardCacheEntry> {
    const existing = this.cardCache.get(target.baseUrl);

    if (
      options.force !== true &&
      (existing?.lastRefreshedAt !== undefined ||
        existing?.lastRefreshError !== undefined)
    ) {
      return cloneCardCacheEntry(existing);
    }

    const inFlight = this.cardRefreshes.get(target.baseUrl);
    if (inFlight) {
      return cloneCardCacheEntry(await inFlight);
    }

    const refreshPromise = this.refreshCardMetadata(target);
    this.cardRefreshes.set(target.baseUrl, refreshPromise);

    try {
      return cloneCardCacheEntry(await refreshPromise);
    } finally {
      if (this.cardRefreshes.get(target.baseUrl) === refreshPromise) {
        this.cardRefreshes.delete(target.baseUrl);
      }
    }
  }

  private async refreshCardMetadata(
    target: ResolvedTarget,
  ): Promise<TargetCardCacheEntry> {
    const refreshedAt = new Date().toISOString();
    const previous = this.cardCache.get(target.baseUrl);

    try {
      const clientEntry = await this.clientPool.get(target);
      const card = await clientEntry.client.getAgentCard();
      const next: TargetCardCacheEntry = {
        ...(isNonEmptyString(card.name) ? { displayName: card.name } : {}),
        ...(isNonEmptyString(card.description)
          ? { description: card.description }
          : {}),
        skillSummaries: card.skills.map(summarizeSkill),
        ...(typeof card.capabilities?.streaming === "boolean"
          ? { streamingSupported: card.capabilities.streaming }
          : {}),
        ...(isNonEmptyString(card.preferredTransport)
          ? { preferredTransport: card.preferredTransport }
          : {}),
        lastRefreshedAt: refreshedAt,
      };

      this.cardCache.set(target.baseUrl, next);
      return next;
    } catch (error) {
      const next: TargetCardCacheEntry = {
        ...(previous?.displayName !== undefined
          ? { displayName: previous.displayName }
          : {}),
        ...(previous?.description !== undefined
          ? { description: previous.description }
          : {}),
        skillSummaries:
          previous?.skillSummaries.map(cloneSkillSummary) ?? [],
        ...(typeof previous?.streamingSupported === "boolean"
          ? { streamingSupported: previous.streamingSupported }
          : {}),
        ...(previous?.preferredTransport !== undefined
          ? { preferredTransport: previous.preferredTransport }
          : {}),
        lastRefreshedAt: refreshedAt,
        lastRefreshError: toToolError(error, fallbackErrorCode(error)),
      };

      this.cardCache.set(target.baseUrl, next);
      return next;
    }
  }
}

export function createTargetCatalog(options: TargetCatalogOptions): TargetCatalog {
  return new TargetCatalog(options);
}
