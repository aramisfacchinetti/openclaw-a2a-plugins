import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  A2A_INBOUND_CHANNEL_CONFIG_JSON_SCHEMA,
  A2A_INBOUND_CHANNEL_CONFIG_UI_HINTS,
  A2A_INBOUND_PLUGIN_CONFIG_JSON_SCHEMA,
  A2A_INBOUND_OPENCLAW_PLUGIN_CONFIG_SCHEMA,
} from "../dist/config.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected object");
  }

  return value as Record<string, unknown>;
}

test("manifest configSchema stays in lockstep with TypeScript JSON schema export", () => {
  const rawManifest = readFileSync(
    new URL("../openclaw.plugin.json", import.meta.url),
    "utf8",
  );

  const manifest = asRecord(JSON.parse(rawManifest));
  const manifestConfigSchema = asRecord(manifest.configSchema);

  assert.deepEqual(manifestConfigSchema, A2A_INBOUND_PLUGIN_CONFIG_JSON_SCHEMA);
});

test("plugin configSchema export reuses the canonical plugin JSON schema", () => {
  assert.deepEqual(
    A2A_INBOUND_OPENCLAW_PLUGIN_CONFIG_SCHEMA.jsonSchema,
    A2A_INBOUND_PLUGIN_CONFIG_JSON_SCHEMA,
  );
});

test("channel schema keeps the restored phase 1 taskStore contract and text/json defaults", () => {
  const rootProperties = asRecord(A2A_INBOUND_CHANNEL_CONFIG_JSON_SCHEMA.properties);
  const accountsSchema = asRecord(rootProperties.accounts);
  const accountSchema = asRecord(accountsSchema.additionalProperties);
  const accountProperties = asRecord(accountSchema.properties);
  const defaultInputModes = asRecord(accountProperties.defaultInputModes);
  const agentStyle = asRecord(accountProperties.agentStyle);
  const taskStore = asRecord(accountProperties.taskStore);

  assert.equal("restPath" in accountProperties, false);
  assert.equal("capabilities" in accountProperties, false);
  assert.equal("auth" in accountProperties, false);
  assert.equal("taskStore" in accountProperties, true);
  assert.deepEqual(defaultInputModes.default, [
    "text/plain",
    "application/json",
  ]);
  assert.deepEqual(asRecord(defaultInputModes.items).enum, [
    "text/plain",
    "application/json",
  ]);
  assert.deepEqual(asRecord(accountProperties.defaultOutputModes).default, [
    "text/plain",
    "application/json",
  ]);
  assert.deepEqual(agentStyle.default, "hybrid");
  assert.deepEqual(agentStyle.enum, ["hybrid", "task-generating"]);
  assert.deepEqual(taskStore.default, {
    kind: "memory",
  });
  assert.equal(Array.isArray(taskStore.oneOf), true);
});

test("channel ui hints expose restored taskStore fields and remove legacy ones", () => {
  assert.equal("accounts.*.restPath" in A2A_INBOUND_CHANNEL_CONFIG_UI_HINTS, false);
  assert.equal("accounts.*.auth.mode" in A2A_INBOUND_CHANNEL_CONFIG_UI_HINTS, false);
  assert.equal("accounts.*.taskStore.kind" in A2A_INBOUND_CHANNEL_CONFIG_UI_HINTS, true);
  assert.equal("accounts.*.agentStyle" in A2A_INBOUND_CHANNEL_CONFIG_UI_HINTS, true);
  assert.equal("accounts.*.taskStore.path" in A2A_INBOUND_CHANNEL_CONFIG_UI_HINTS, true);
});
