import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHANNEL_ID, PLUGIN_ID } from "../dist/constants.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected object");
  }

  return value as JsonRecord;
}

function unscopedPackageName(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("expected package name");
  }

  const segments = value.split("/");
  return segments.at(-1) ?? value;
}

test("package name leaf stays aligned with the plugin id", () => {
  const rawPackage = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  const rawManifest = readFileSync(
    new URL("../openclaw.plugin.json", import.meta.url),
    "utf8",
  );

  const packageJson = asRecord(JSON.parse(rawPackage));
  const manifest = asRecord(JSON.parse(rawManifest));

  assert.equal(unscopedPackageName(packageJson.name), PLUGIN_ID);
  assert.equal(manifest.id, PLUGIN_ID);
});

test("package channel metadata stays aligned with the exported channel id", () => {
  const rawPackage = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  const packageJson = asRecord(JSON.parse(rawPackage));
  const openclaw = asRecord(packageJson.openclaw);
  const channel = asRecord(openclaw.channel);

  assert.equal(CHANNEL_ID, "a2a");
  assert.notEqual(CHANNEL_ID, PLUGIN_ID);
  assert.equal(channel.id, CHANNEL_ID);
});

test("exploratory inbound scaffold stays private until intentionally published", () => {
  const rawPackage = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  const packageJson = asRecord(JSON.parse(rawPackage));

  assert.equal(packageJson.private, true);
});
