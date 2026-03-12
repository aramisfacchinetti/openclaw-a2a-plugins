import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { parseA2AOutboundPluginConfig } from "../dist/config.js";
import { createClientPool } from "../dist/sdk-client-pool.js";
import { TargetCatalog } from "../dist/target-catalog.js";

type JsonObject = Record<string, unknown>;

type StartedCardPeer = {
  server: http.Server;
  baseUrl: string;
  cardPath: string;
  state: {
    cardRequests: number;
  };
};

type StartCardPeerOptions = {
  cardPath?: string;
  statusCode?: number;
  body?: JsonObject;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonObject {
  if (!isRecord(value)) {
    throw new TypeError("expected object");
  }

  return value;
}

function startCardPeer(options: StartCardPeerOptions = {}): Promise<StartedCardPeer> {
  const cardPath = options.cardPath ?? "/.well-known/agent-card.json";
  const state = {
    cardRequests: 0,
  };

  const server = http.createServer((req, res) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new TypeError("expected bound server address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    if (req.method === "GET" && req.url === cardPath) {
      state.cardRequests += 1;
      res.statusCode = options.statusCode ?? 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          options.body ?? {
            name: "Support Agent",
            description: "Routes and resolves support requests",
            protocolVersion: "0.3.0",
            version: "0.1.0",
            url: `${baseUrl}/a2a/jsonrpc`,
            preferredTransport: "HTTP+JSON",
            capabilities: {
              streaming: true,
              pushNotifications: false,
              stateTransitionHistory: false,
            },
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            skills: [
              {
                id: "triage",
                name: "Ticket Triage",
                description: "Classifies incoming requests",
                tags: ["support", "routing"],
                examples: ["Route this ticket"],
              },
            ],
          },
        ),
      );
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new TypeError("expected bound server address");
      }

      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        cardPath,
        state,
      });
    });
  });
}

function buildCatalog(config: unknown): TargetCatalog {
  const parsed = parseA2AOutboundPluginConfig(config);
  const clientPool = createClientPool({
    defaultCardPath: parsed.defaults.cardPath,
    preferredTransports: parsed.defaults.preferredTransports,
    normalizeBaseUrl: parsed.policy.normalizeBaseUrl,
    enforceSupportedTransports: parsed.policy.enforceSupportedTransports,
  });

  return new TargetCatalog({
    config: parsed,
    clientPool,
  });
}

function expectTargetResolutionError(
  error: unknown,
  expectedReason: string,
): JsonObject {
  if (!(error instanceof Error)) {
    throw error;
  }

  const resolvedError = error as Error & {
    code?: unknown;
    details?: unknown;
  };

  assert.equal(resolvedError.code, "TARGET_RESOLUTION_ERROR");

  const details = asRecord(resolvedError.details);
  assert.equal(details.reason, expectedReason);
  return details;
}

test("alias lookup resolves a configured target", async (t) => {
  const peer = await startCardPeer();
  t.after(() => peer.server.close());

  const catalog = buildCatalog({
    targets: [
      {
        alias: "support",
        baseUrl: `${peer.baseUrl}/`,
        description: "Primary support lane",
      },
    ],
  });

  const resolved = catalog.resolveAlias("support");

  assert.equal(resolved.baseUrl, `${peer.baseUrl}/`);
  assert.equal(resolved.alias, "support");
  assert.equal(resolved.description, "Primary support lane");
  assert.equal(resolved.cardPath, "/.well-known/agent-card.json");
  assert.deepEqual(resolved.preferredTransports, ["JSONRPC", "HTTP+JSON"]);
});

test("default target resolution returns the configured default", async (t) => {
  const peer = await startCardPeer();
  t.after(() => peer.server.close());

  const catalog = buildCatalog({
    targets: [
      {
        alias: "support",
        baseUrl: peer.baseUrl,
      },
      {
        alias: "billing",
        baseUrl: `${peer.baseUrl}/billing`,
        default: true,
      },
    ],
  });

  const resolved = catalog.resolveDefaultTarget();

  assert.ok(resolved);
  assert.equal(resolved.alias, "billing");
  assert.equal(resolved.baseUrl, `${peer.baseUrl}/billing`);
});

test("raw target resolution enforces override policy for unknown URLs", async (t) => {
  const supportPeer = await startCardPeer();
  const unknownPeer = await startCardPeer();
  t.after(() => supportPeer.server.close());
  t.after(() => unknownPeer.server.close());

  const lockedCatalog = buildCatalog({
    policy: {
      allowTargetUrlOverride: false,
    },
    targets: [
      {
        alias: "support",
        baseUrl: supportPeer.baseUrl,
      },
    ],
  });

  await assert.rejects(async () => {
    lockedCatalog.resolveRawTarget({
      baseUrl: unknownPeer.baseUrl,
    });
  }, (error) => {
    const details = expectTargetResolutionError(
      error,
      "raw_url_disallowed_by_policy",
    );
    assert.equal(details.normalizedBaseUrl, `${unknownPeer.baseUrl}/`);
    assert.equal(details.suggested_action, "list_targets");
    assert.equal(details.hint, "Use target_alias or enable policy.allowTargetUrlOverride.");
    return true;
  });

  const overrideCatalog = buildCatalog({
    policy: {
      allowTargetUrlOverride: true,
    },
    targets: [
      {
        alias: "support",
        baseUrl: supportPeer.baseUrl,
      },
    ],
  });

  const resolved = overrideCatalog.resolveRawTarget({
    baseUrl: unknownPeer.baseUrl,
  });

  assert.equal(resolved.baseUrl, `${unknownPeer.baseUrl}/`);
  assert.equal(resolved.alias, undefined);
});

test("raw target resolution matches configured targets by normalized base URL", async (t) => {
  const peer = await startCardPeer();
  t.after(() => peer.server.close());

  const catalog = buildCatalog({
    targets: [
      {
        alias: "support",
        baseUrl: `${peer.baseUrl}/`,
        description: "Normalized match",
      },
    ],
  });

  const resolved = catalog.resolveConfiguredRawTarget({
    baseUrl: peer.baseUrl,
    preferredTransports: ["HTTP+JSON"],
  });

  assert.equal(resolved.baseUrl, `${peer.baseUrl}/`);
  assert.equal(resolved.alias, "support");
  assert.equal(resolved.description, "Normalized match");
  assert.deepEqual(resolved.preferredTransports, ["HTTP+JSON"]);
});

test("raw target resolution fails when normalized URL matches multiple configured targets", async (t) => {
  const peer = await startCardPeer();
  t.after(() => peer.server.close());

  const catalog = buildCatalog({
    targets: [
      {
        alias: "support",
        baseUrl: peer.baseUrl,
      },
      {
        alias: "support-canary",
        baseUrl: `${peer.baseUrl}/`,
        cardPath: "/cards/canary.json",
      },
    ],
  });

  await assert.rejects(async () => {
    catalog.resolveRawTarget({
      baseUrl: peer.baseUrl,
    });
  }, (error) => {
    const details = expectTargetResolutionError(
      error,
      "ambiguous_normalized_url_matches",
    );
    assert.deepEqual(details.aliases, ["support", "support-canary"]);
    assert.equal(details.suggested_action, "list_targets");
    assert.equal(details.hint, "Disambiguate by using target_alias instead of target_url.");
    return true;
  });
});

test("unknown configured aliases and raw URLs return target-resolution errors with suggested_action", async (t) => {
  const peer = await startCardPeer();
  t.after(() => peer.server.close());

  const catalog = buildCatalog({
    targets: [
      {
        alias: "support",
        baseUrl: peer.baseUrl,
      },
    ],
  });

  assert.throws(() => catalog.resolveAlias("missing"), (error) => {
    const details = expectTargetResolutionError(error, "unknown_alias");
    assert.ok(Array.isArray(details.availableAliases));
    assert.equal(details.suggested_action, "list_targets");
    return true;
  });

  assert.throws(
    () =>
      catalog.resolveConfiguredRawTarget({
        baseUrl: "http://127.0.0.1:65534",
      }),
    (error) => {
      const details = expectTargetResolutionError(error, "unknown_raw_url");
      assert.equal(details.normalizedBaseUrl, "http://127.0.0.1:65534/");
      assert.equal(details.suggested_action, "list_targets");
      return true;
    },
  );
});

test("successful card hydration populates cached card metadata", async (t) => {
  const peer = await startCardPeer();
  t.after(() => peer.server.close());

  const catalog = buildCatalog({
    targets: [
      {
        alias: "support",
        baseUrl: peer.baseUrl,
        description: "Configured description",
        tags: ["ops"],
        examples: ["Escalate a ticket"],
      },
    ],
  });

  const hydrated = await catalog.hydrateConfiguredTarget("support");

  assert.equal(hydrated.target.alias, "support");
  assert.equal(hydrated.target.displayName, "Support Agent");
  assert.equal(hydrated.target.description, "Configured description");
  assert.equal(hydrated.target.streamingSupported, true);
  assert.equal(hydrated.card.displayName, "Support Agent");
  assert.equal(
    hydrated.card.description,
    "Routes and resolves support requests",
  );
  assert.equal(hydrated.card.preferredTransport, "HTTP+JSON");
  assert.equal(hydrated.card.streamingSupported, true);
  assert.equal(hydrated.card.skillSummaries.length, 1);
  assert.equal(hydrated.card.skillSummaries[0].name, "Ticket Triage");
  assert.ok(hydrated.card.lastRefreshedAt);
  assert.equal(peer.state.cardRequests, 1);
});

test("repeated card hydration reuses cached metadata without another card request", async (t) => {
  const peer = await startCardPeer();
  t.after(() => peer.server.close());

  const catalog = buildCatalog({
    targets: [
      {
        alias: "support",
        baseUrl: peer.baseUrl,
      },
    ],
  });

  const first = await catalog.hydrateConfiguredTarget("support");
  const second = await catalog.hydrateConfiguredTarget("support");
  const entry = catalog.getEntry("support");

  assert.equal(first.card.displayName, "Support Agent");
  assert.equal(second.card.displayName, "Support Agent");
  assert.equal(entry?.card.displayName, "Support Agent");
  assert.equal(peer.state.cardRequests, 1);
});

test("hydrateAllConfigured populates reachable targets and records errors for unreachable ones", async (t) => {
  const reachablePeer = await startCardPeer();
  const unreachablePeer = await startCardPeer({ statusCode: 503, body: { error: "down" } });
  t.after(() => reachablePeer.server.close());
  t.after(() => unreachablePeer.server.close());

  const catalog = buildCatalog({
    targets: [
      {
        alias: "reachable",
        baseUrl: reachablePeer.baseUrl,
      },
      {
        alias: "unreachable",
        baseUrl: unreachablePeer.baseUrl,
      },
    ],
  });

  const entries = await catalog.hydrateAllConfigured();

  assert.equal(entries.length, 2);

  const reachable = entries.find((e) => e.target.alias === "reachable");
  const unreachable = entries.find((e) => e.target.alias === "unreachable");

  assert.ok(reachable);
  assert.equal(reachable.card.displayName, "Support Agent");
  assert.equal(reachable.card.skillSummaries.length, 1);
  assert.equal(reachable.card.streamingSupported, true);
  assert.ok(reachable.card.lastRefreshedAt);
  assert.equal(reachable.card.lastRefreshError, undefined);

  assert.ok(unreachable);
  assert.equal(unreachable.card.displayName, undefined);
  assert.equal(unreachable.card.skillSummaries.length, 0);
  assert.ok(unreachable.card.lastRefreshError);
  assert.ok(unreachable.card.lastRefreshedAt);
});

test("card refresh failures are recorded without breaking configured resolution", async (t) => {
  const peer = await startCardPeer({
    statusCode: 503,
    body: {
      error: "unavailable",
    },
  });
  t.after(() => peer.server.close());

  const catalog = buildCatalog({
    targets: [
      {
        alias: "support",
        baseUrl: peer.baseUrl,
        description: "Configured fallback",
      },
    ],
  });

  const resolvedBefore = catalog.resolveAlias("support");
  const hydrated = await catalog.hydrateConfiguredTarget("support");
  const resolvedAfter = catalog.resolveAlias("support");

  assert.equal(resolvedBefore.alias, "support");
  assert.equal(resolvedAfter.alias, "support");
  assert.equal(resolvedAfter.description, "Configured fallback");
  assert.equal(hydrated.card.displayName, undefined);
  assert.equal(hydrated.card.skillSummaries.length, 0);
  assert.equal(hydrated.card.lastRefreshError?.code, "A2A_SDK_ERROR");
  assert.match(hydrated.card.lastRefreshError?.message ?? "", /agent card/i);
  assert.equal(peer.state.cardRequests, 1);
});
