import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDemoServeInstructions,
  runDemoRun,
  runDoctor,
} from "../dist/cli.js";
import {
  LOCAL_DEMO_ALIAS,
  createDemoOutboundConfig,
  startDemoPeerServer,
} from "../dist/demo-peer.js";
import { PLUGIN_ID } from "../dist/constants.js";

test("demo run performs the onboarding sequence and can write continuation JSON", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-a2a-cli-"));
  const continuationPath = join(tempDir, "continuation.json");

  try {
    const result = await runDemoRun({
      writeContinuation: continuationPath,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.steps.map((step) => step.name),
      ["list_targets", "send", "watch", "status", "continuation_send"],
    );
    assert.equal(result.alias, LOCAL_DEMO_ALIAS);
    assert.ok(result.continuation?.task?.task_id);

    const written = JSON.parse(await readFile(continuationPath, "utf8")) as {
      task?: { task_id?: string };
    };
    assert.equal(written.task?.task_id, result.continuation?.task?.task_id);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("demo serve instructions include config commands and raw remote_agent payloads", () => {
  const instructions = buildDemoServeInstructions({
    baseUrl: "http://127.0.0.1:41234",
    cardUrl: "http://127.0.0.1:41234/.well-known/agent-card.json",
    jsonRpcUrl: "http://127.0.0.1:41234/a2a/jsonrpc",
  });

  assert.equal(
    instructions.commands.enable_plugin,
    `openclaw plugins enable ${PLUGIN_ID}`,
  );
  assert.match(instructions.commands.configure_target, /--strict-json$/);
  assert.equal(
    instructions.remote_agent_payloads.send.target_alias,
    LOCAL_DEMO_ALIAS,
  );
  assert.deepEqual(instructions.remote_agent_payloads.list_targets, {
    action: "list_targets",
  });
  assert.equal(
    (
      instructions.remote_agent_payloads.continuation_replay
        .continuation as { target?: { target_alias?: string } }
    ).target?.target_alias,
    LOCAL_DEMO_ALIAS,
  );
});

test("doctor reports success for a configured reachable local demo target", async () => {
  const peer = await startDemoPeerServer();

  try {
    const result = await runDoctor({
      alias: LOCAL_DEMO_ALIAS,
      pluginConfig: createDemoOutboundConfig(peer.baseUrl),
      rootConfig: {
        plugins: {
          enabled: true,
          entries: {
            [PLUGIN_ID]: {
              enabled: true,
            },
          },
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(
      result.checks.find((check) => check.name === "agent_card_reachable")
        ?.status,
      "pass",
    );
  } finally {
    await peer.close();
  }
});

test("doctor fails when the plugin config is not enabled or the alias is missing", async () => {
  const result = await runDoctor({
    alias: "missing",
    pluginConfig: {
      ...createDemoOutboundConfig("http://127.0.0.1:1"),
      enabled: false,
    },
    rootConfig: {
      plugins: {
        enabled: false,
        entries: {
          [PLUGIN_ID]: {
            enabled: false,
          },
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find((check) => check.name === "plugin_config_enabled")
      ?.status,
    "fail",
  );
  assert.equal(
    result.checks.find((check) => check.name === "target_present")?.status,
    "fail",
  );
});
