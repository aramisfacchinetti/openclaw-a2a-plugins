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

type AgentCardAdditionalInterface = NonNullable<
  AgentCard["additionalInterfaces"]
>[number];
type AgentCardCapabilityExtension = NonNullable<
  NonNullable<AgentCard["capabilities"]>["extensions"]
>[number];
type AgentCardSkill = NonNullable<AgentCard["skills"]>[number];

export interface TargetCardAdditionalInterfaceSnapshot {
  transport: AgentCardAdditionalInterface["transport"];
  url: AgentCardAdditionalInterface["url"];
}

export interface TargetCardCapabilitiesSnapshot {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  extensions?: AgentCardCapabilityExtension[];
}

export interface TargetCardSkillSnapshot {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface TargetCardSnapshot {
  displayName?: string;
  description?: string;
  preferredTransport?: string;
  additionalInterfaces: TargetCardAdditionalInterfaceSnapshot[];
  capabilities: TargetCardCapabilitiesSnapshot;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: TargetCardSkillSnapshot[];
  lastRefreshedAt?: string;
  lastRefreshError?: ToolError;
}

export interface TargetCatalogEntry {
  target: ResolvedTarget;
  configuredDescription?: string;
  default: boolean;
  tags: string[];
  examples: string[];
  card: TargetCardSnapshot;
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

function cloneStringArray(values: readonly string[]): string[] {
  return [...values];
}

function normalizeStringArray(values: readonly unknown[] | undefined): string[] {
  if (!values) {
    return [];
  }

  const normalized = new Set<string>();

  for (const value of values) {
    if (!isNonEmptyString(value)) {
      continue;
    }

    normalized.add(value.trim());
  }

  return [...normalized];
}

function cloneCapabilityExtension(
  extension: AgentCardCapabilityExtension,
): AgentCardCapabilityExtension {
  return structuredClone(extension);
}

function cloneAdditionalInterfaceSnapshot(
  snapshot: TargetCardAdditionalInterfaceSnapshot,
): TargetCardAdditionalInterfaceSnapshot {
  return {
    transport: snapshot.transport,
    url: snapshot.url,
  };
}

function cloneCapabilitiesSnapshot(
  snapshot: TargetCardCapabilitiesSnapshot,
): TargetCardCapabilitiesSnapshot {
  return {
    ...(typeof snapshot.streaming === "boolean"
      ? { streaming: snapshot.streaming }
      : {}),
    ...(typeof snapshot.pushNotifications === "boolean"
      ? { pushNotifications: snapshot.pushNotifications }
      : {}),
    ...(typeof snapshot.stateTransitionHistory === "boolean"
      ? { stateTransitionHistory: snapshot.stateTransitionHistory }
      : {}),
    ...(snapshot.extensions !== undefined
      ? {
          extensions: snapshot.extensions.map(cloneCapabilityExtension),
        }
      : {}),
  };
}

function cloneSkillSnapshot(
  snapshot: TargetCardSkillSnapshot,
): TargetCardSkillSnapshot {
  return {
    id: snapshot.id,
    name: snapshot.name,
    description: snapshot.description,
    tags: cloneStringArray(snapshot.tags),
    examples: cloneStringArray(snapshot.examples),
    ...(snapshot.inputModes !== undefined
      ? { inputModes: cloneStringArray(snapshot.inputModes) }
      : {}),
    ...(snapshot.outputModes !== undefined
      ? { outputModes: cloneStringArray(snapshot.outputModes) }
      : {}),
  };
}

function cloneToolError(error: ToolError): ToolError {
  return structuredClone(error);
}

function cloneCardSnapshot(snapshot: TargetCardSnapshot): TargetCardSnapshot {
  return {
    ...(snapshot.displayName !== undefined
      ? { displayName: snapshot.displayName }
      : {}),
    ...(snapshot.description !== undefined
      ? { description: snapshot.description }
      : {}),
    ...(snapshot.preferredTransport !== undefined
      ? { preferredTransport: snapshot.preferredTransport }
      : {}),
    additionalInterfaces: snapshot.additionalInterfaces.map(
      cloneAdditionalInterfaceSnapshot,
    ),
    capabilities: cloneCapabilitiesSnapshot(snapshot.capabilities),
    defaultInputModes: cloneStringArray(snapshot.defaultInputModes),
    defaultOutputModes: cloneStringArray(snapshot.defaultOutputModes),
    skills: snapshot.skills.map(cloneSkillSnapshot),
    ...(snapshot.lastRefreshedAt !== undefined
      ? { lastRefreshedAt: snapshot.lastRefreshedAt }
      : {}),
    ...(snapshot.lastRefreshError !== undefined
      ? { lastRefreshError: cloneToolError(snapshot.lastRefreshError) }
      : {}),
  };
}

function emptyCardSnapshot(): TargetCardSnapshot {
  return {
    additionalInterfaces: [],
    capabilities: {},
    defaultInputModes: [],
    defaultOutputModes: [],
    skills: [],
  };
}

function normalizeAdditionalInterfaces(
  card: AgentCard,
): TargetCardAdditionalInterfaceSnapshot[] {
  if (!Array.isArray(card.additionalInterfaces)) {
    return [];
  }

  const seen = new Set<string>();
  const snapshots: TargetCardAdditionalInterfaceSnapshot[] = [];

  for (const entry of card.additionalInterfaces) {
    if (!isNonEmptyString(entry.transport) || !isNonEmptyString(entry.url)) {
      continue;
    }

    const transport = entry.transport.trim() as AgentCardAdditionalInterface["transport"];
    const url = entry.url.trim();
    const key = `${transport}\u0000${url}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    snapshots.push({ transport, url });
  }

  return snapshots;
}

function normalizeCapabilities(card: AgentCard): TargetCardCapabilitiesSnapshot {
  const capabilities: TargetCardCapabilitiesSnapshot = {};

  if (typeof card.capabilities?.streaming === "boolean") {
    capabilities.streaming = card.capabilities.streaming;
  }

  if (typeof card.capabilities?.pushNotifications === "boolean") {
    capabilities.pushNotifications = card.capabilities.pushNotifications;
  }

  if (typeof card.capabilities?.stateTransitionHistory === "boolean") {
    capabilities.stateTransitionHistory = card.capabilities.stateTransitionHistory;
  }

  if (
    Array.isArray(card.capabilities?.extensions) &&
    card.capabilities.extensions.length > 0
  ) {
    capabilities.extensions = card.capabilities.extensions.map(
      cloneCapabilityExtension,
    );
  }

  return capabilities;
}

function normalizeSkill(skill: AgentCardSkill): TargetCardSkillSnapshot {
  const inputModes = normalizeStringArray(skill.inputModes);
  const outputModes = normalizeStringArray(skill.outputModes);

  return {
    id: skill.id,
    name: skill.name,
    description:
      isNonEmptyString(skill.description) ? skill.description.trim() : skill.name,
    tags: normalizeStringArray(skill.tags),
    examples: normalizeStringArray(skill.examples ?? []),
    ...(inputModes.length > 0 ? { inputModes } : {}),
    ...(outputModes.length > 0 ? { outputModes } : {}),
  };
}

export function normalizeAgentCardSnapshot(
  card: AgentCard,
): Omit<TargetCardSnapshot, "lastRefreshedAt" | "lastRefreshError"> {
  const skills = Array.isArray(card.skills) ? card.skills : [];

  return {
    ...(isNonEmptyString(card.name) ? { displayName: card.name.trim() } : {}),
    ...(isNonEmptyString(card.description)
      ? { description: card.description.trim() }
      : {}),
    ...(isNonEmptyString(card.preferredTransport)
      ? { preferredTransport: card.preferredTransport.trim() }
      : {}),
    additionalInterfaces: normalizeAdditionalInterfaces(card),
    capabilities: normalizeCapabilities(card),
    defaultInputModes: normalizeStringArray(card.defaultInputModes),
    defaultOutputModes: normalizeStringArray(card.defaultOutputModes),
    skills: skills.map(normalizeSkill),
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

  private readonly cardCache = new Map<string, TargetCardSnapshot>();

  private readonly cardRefreshes = new Map<string, Promise<TargetCardSnapshot>>();

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

  getCardSnapshot(normalizedBaseUrl: string): TargetCardSnapshot | undefined {
    const existing = this.cardCache.get(normalizedBaseUrl);
    return existing ? cloneCardSnapshot(existing) : undefined;
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
          suggested_action: "list_targets",
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
          suggested_action: "list_targets",
          hint: "Use target_alias or enable policy.allowTargetUrlOverride.",
        },
      );
    }

    return this.applyCachedMetadata(normalizedTarget);
  }

  async hydrateAllConfigured(
    options: TargetCatalogHydrationOptions = {},
  ): Promise<TargetCatalogEntry[]> {
    await Promise.allSettled(
      this.configuredEntries.map((entry) =>
        this.loadCardMetadata(entry.target, options),
      ),
    );

    return this.listEntries();
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

  recordAgentCard(target: ResolvedTarget, card: AgentCard): ResolvedTarget {
    const refreshedAt = new Date().toISOString();
    const next: TargetCardSnapshot = {
      ...normalizeAgentCardSnapshot(card),
      lastRefreshedAt: refreshedAt,
    };

    this.cardCache.set(target.baseUrl, next);
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
          suggested_action: "list_targets",
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
        suggested_action: "list_targets",
        hint: "Disambiguate by using target_alias instead of target_url.",
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

  private cardCacheSnapshot(normalizedBaseUrl: string): TargetCardSnapshot {
    const existing = this.cardCache.get(normalizedBaseUrl);
    return cloneCardSnapshot(existing ?? emptyCardSnapshot());
  }

  private applyCachedMetadata(target: ResolvedTarget): ResolvedTarget {
    const cached = this.cardCache.get(target.baseUrl);
    const displayName = target.displayName ?? cached?.displayName;
    const description = target.description ?? cached?.description;
    const streamingSupported =
      target.streamingSupported ?? cached?.capabilities.streaming;

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
  ): Promise<TargetCardSnapshot> {
    const existing = this.cardCache.get(target.baseUrl);

    if (
      options.force !== true &&
      (existing?.lastRefreshedAt !== undefined ||
        existing?.lastRefreshError !== undefined)
    ) {
      return cloneCardSnapshot(existing);
    }

    const inFlight = this.cardRefreshes.get(target.baseUrl);
    if (inFlight) {
      return cloneCardSnapshot(await inFlight);
    }

    const refreshPromise = this.refreshCardMetadata(target);
    this.cardRefreshes.set(target.baseUrl, refreshPromise);

    try {
      return cloneCardSnapshot(await refreshPromise);
    } finally {
      if (this.cardRefreshes.get(target.baseUrl) === refreshPromise) {
        this.cardRefreshes.delete(target.baseUrl);
      }
    }
  }

  private async refreshCardMetadata(
    target: ResolvedTarget,
  ): Promise<TargetCardSnapshot> {
    const refreshedAt = new Date().toISOString();
    const previous = this.cardCache.get(target.baseUrl);

    try {
      const clientEntry = await this.clientPool.get(target);
      const card = await clientEntry.client.getAgentCard();
      const next: TargetCardSnapshot = {
        ...normalizeAgentCardSnapshot(card),
        lastRefreshedAt: refreshedAt,
      };

      this.cardCache.set(target.baseUrl, next);
      return next;
    } catch (error) {
      const next: TargetCardSnapshot = {
        ...cloneCardSnapshot(previous ?? emptyCardSnapshot()),
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
