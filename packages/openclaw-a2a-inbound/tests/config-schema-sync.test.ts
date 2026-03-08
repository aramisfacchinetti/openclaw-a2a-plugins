import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
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
