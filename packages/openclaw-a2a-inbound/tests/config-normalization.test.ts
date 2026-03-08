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
            jsonRpcPath: "rpc",
            restPath: "rest",
            auth: {
              mode: "header-token",
              token: "secret",
            },
          },
        },
      },
    },
  });

  const account = parsed.accounts.default;
  assert.ok(account);
  assert.equal(account.label, "default");
  assert.equal(account.jsonRpcPath, "/rpc");
  assert.equal(account.restPath, "/rest");
  assert.equal(account.auth.mode, "header-token");
  assert.equal(account.auth.headerName, "authorization");
  assert.deepEqual(account.defaultInputModes, [...DEFAULT_INPUT_MODES]);
  assert.deepEqual(account.defaultOutputModes, [...DEFAULT_OUTPUT_MODES]);
  assert.equal(isA2AInboundAccountConfigured(account), true);
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

test("colliding derived files prefixes are rejected", () => {
  assert.throws(
    () =>
      parseA2AInboundChannelConfig({
        channels: {
          a2a: {
            accounts: {
              primary: {
                enabled: true,
                publicBaseUrl: "https://agents.example.com",
                agentCardPath: "/primary/agent-card.json",
                restPath: "/primary/rest",
                jsonRpcPath: "/shared/jsonrpc",
              },
              secondary: {
                enabled: true,
                publicBaseUrl: "https://agents.example.com",
                agentCardPath: "/secondary/agent-card.json",
                restPath: "/secondary/rest",
                jsonRpcPath: "/shared/rpc",
              },
            },
          },
        },
      }),
    /files prefix/,
  );
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

test("json-file task store requires a path to be considered configured", () => {
  const parsed = parseA2AInboundChannelConfig({
    channels: {
      a2a: {
        accounts: {
          default: {
            enabled: true,
            publicBaseUrl: "https://agents.example.com",
            taskStore: {
              kind: "json-file",
            },
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
    /taskStore\.kind=json-file requires taskStore\.path/,
  );
});
