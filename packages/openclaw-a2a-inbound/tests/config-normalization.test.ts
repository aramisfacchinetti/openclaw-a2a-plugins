import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INPUT_MODES,
  DEFAULT_OUTPUT_MODES,
  explainA2AInboundAccountUnconfigured,
  isA2AInboundAccountConfigured,
  parseA2AInboundChannelConfig,
  resolveA2AInboundAccount,
} from "../dist/config.js";

test("parser returns empty accounts when channel config is missing", () => {
  const parsed = parseA2AInboundChannelConfig({});

  assert.deepEqual(parsed, { accounts: {} });
});

test("parser normalizes paths, defaults, and account labels", () => {
  const parsed = parseA2AInboundChannelConfig({
    channels: {
      a2a: {
        accounts: {
          default: {
            enabled: true,
            publicBaseUrl: "https://agents.example.com",
            agentCardPath: "agent-card.json",
            jsonRpcPath: "rpc",
          },
        },
      },
    },
  });

  const account = parsed.accounts.default;
  assert.ok(account);
  assert.equal(account.label, "default");
  assert.equal(account.agentCardPath, "/agent-card.json");
  assert.equal(account.jsonRpcPath, "/rpc");
  assert.deepEqual(account.defaultInputModes, [...DEFAULT_INPUT_MODES]);
  assert.deepEqual(account.defaultOutputModes, [...DEFAULT_OUTPUT_MODES]);
  assert.equal(account.agentStyle, "hybrid");
  assert.equal(account.originRoutingPolicy, "suppress-generic-followup");
  assert.deepEqual(account.taskStore, { kind: "memory" });
  assert.equal(isA2AInboundAccountConfigured(account), true);
});

test("parser accepts explicit task-generating agentStyle", () => {
  const parsed = parseA2AInboundChannelConfig({
    channels: {
      a2a: {
        accounts: {
          default: {
            enabled: true,
            publicBaseUrl: "https://agents.example.com",
            agentStyle: "task-generating",
          },
        },
      },
    },
  });

  assert.equal(parsed.accounts.default?.agentStyle, "task-generating");
});

test("parser accepts explicit suppress-generic-followup originRoutingPolicy", () => {
  const parsed = parseA2AInboundChannelConfig({
    channels: {
      a2a: {
        accounts: {
          default: {
            enabled: true,
            publicBaseUrl: "https://agents.example.com",
            originRoutingPolicy: "suppress-generic-followup",
          },
        },
      },
    },
  });

  assert.equal(
    parsed.accounts.default?.originRoutingPolicy,
    "suppress-generic-followup",
  );
});

test("duplicate enabled route paths are rejected", () => {
  assert.throws(
    () =>
      parseA2AInboundChannelConfig({
        channels: {
          a2a: {
            accounts: {
              primary: {
                enabled: true,
                jsonRpcPath: "/shared",
              },
              secondary: {
                enabled: true,
                jsonRpcPath: "/shared",
              },
            },
          },
        },
      }),
    /reuses route path/,
  );
});

test("sibling JSON-RPC paths are allowed when only the removed files prefix would have collided", () => {
  const parsed = parseA2AInboundChannelConfig({
    channels: {
      a2a: {
        accounts: {
          primary: {
            enabled: true,
            publicBaseUrl: "https://agents.example.com",
            agentCardPath: "/primary/agent-card.json",
            jsonRpcPath: "/shared/jsonrpc",
          },
          secondary: {
            enabled: true,
            publicBaseUrl: "https://agents.example.com",
            agentCardPath: "/secondary/agent-card.json",
            jsonRpcPath: "/shared/rpc",
          },
        },
      },
    },
  });

  assert.equal(parsed.accounts.primary?.jsonRpcPath, "/shared/jsonrpc");
  assert.equal(parsed.accounts.secondary?.jsonRpcPath, "/shared/rpc");
});

test("synthetic fallback accounts are disabled when not configured", () => {
  const account = resolveA2AInboundAccount({}, "missing");

  assert.equal(account.accountId, "missing");
  assert.equal(account.enabled, false);
  assert.equal(isA2AInboundAccountConfigured(account), false);
  assert.match(
    explainA2AInboundAccountUnconfigured(account),
    /publicBaseUrl is required/,
  );
});

for (const forbiddenKey of [
  "restPath",
  "capabilities",
  "auth",
] as const) {
  test(`parser rejects removed account key ${forbiddenKey}`, () => {
    assert.throws(
      () =>
        parseA2AInboundChannelConfig({
          channels: {
            a2a: {
              accounts: {
                default: {
                  enabled: true,
                  publicBaseUrl: "https://agents.example.com",
                  [forbiddenKey]:
                    forbiddenKey === "restPath"
                      ? "/legacy"
                      : forbiddenKey === "capabilities"
                        ? { streaming: true }
                        : { mode: "header-token", token: "secret" },
                },
              },
            },
          },
        }),
      new RegExp(`accounts\\.default\\.${forbiddenKey} is not supported`),
    );
  });
}

test("publicBaseUrl is the only account readiness prerequisite", () => {
  const parsed = parseA2AInboundChannelConfig({
    channels: {
      a2a: {
        accounts: {
          default: {
            enabled: true,
            jsonRpcPath: "/rpc",
          },
        },
      },
    },
  });

  const account = parsed.accounts.default;
  assert.ok(account);
  assert.equal(isA2AInboundAccountConfigured(account), false);
  assert.match(
    explainA2AInboundAccountUnconfigured(account),
    /publicBaseUrl is required/,
  );
});

test("defaultInputModes rejects application/octet-stream and other unsupported values", () => {
  for (const unsupportedMode of [
    "application/octet-stream",
    "image/png",
  ]) {
    assert.throws(
      () =>
        parseA2AInboundChannelConfig({
          channels: {
            a2a: {
              accounts: {
                default: {
                  enabled: true,
                  publicBaseUrl: "https://agents.example.com",
                  defaultInputModes: ["text/plain", unsupportedMode],
                },
              },
            },
          },
        }),
      new RegExp(`defaultInputModes only supports .*${unsupportedMode.replace("/", "\\/")}`),
    );
  }
});

test("taskStore accepts memory and absolute json-file paths", () => {
  const parsed = parseA2AInboundChannelConfig({
    channels: {
      a2a: {
        accounts: {
          memory: {
            enabled: true,
            publicBaseUrl: "https://agents.example.com",
          },
          durable: {
            enabled: true,
            publicBaseUrl: "https://agents.example.com",
            agentCardPath: "/durable/agent-card.json",
            jsonRpcPath: "/durable/jsonrpc",
            taskStore: {
              kind: "json-file",
              path: "/tmp/openclaw-a2a-tasks",
            },
          },
        },
      },
    },
  });

  assert.deepEqual(parsed.accounts.memory?.taskStore, { kind: "memory" });
  assert.deepEqual(parsed.accounts.durable?.taskStore, {
    kind: "json-file",
    path: "/tmp/openclaw-a2a-tasks",
  });
});

for (const invalidPath of ["", "   ", "relative/path"]) {
  test(`taskStore rejects invalid json-file.path ${JSON.stringify(invalidPath)}`, () => {
    assert.throws(
      () =>
        parseA2AInboundChannelConfig({
          channels: {
            a2a: {
              accounts: {
                default: {
                  enabled: true,
                  publicBaseUrl: "https://agents.example.com",
                  taskStore: {
                    kind: "json-file",
                    path: invalidPath,
                  },
                },
              },
            },
          },
        }),
      /taskStore\.path must be a non-empty absolute path/,
    );
  });
}

test("defaultInputModes accepts only supported text/json values", () => {
  const parsed = parseA2AInboundChannelConfig({
    channels: {
      a2a: {
        accounts: {
          default: {
            enabled: true,
            publicBaseUrl: "https://agents.example.com",
            defaultInputModes: ["application/json", "text/plain", "application/json"],
          },
        },
      },
    },
  });

  assert.deepEqual(parsed.accounts.default?.defaultInputModes, [
    "application/json",
    "text/plain",
  ]);
});
