import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);
const packageDir = process.cwd();
const repoRoot = resolve(packageDir, "../..");
const openclawBin = resolve(repoRoot, "node_modules/.bin/openclaw");

async function reservePort(): Promise<number> {
  const { createServer } = await import("node:net");

  return await new Promise((resolvePort, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve a TCP port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePort(port);
      });
    });
  });
}

function extractJsonObject(stdout: string): unknown {
  const trimmed = stdout.trim();

  if (trimmed.length === 0) {
    throw new Error("expected JSON output but stdout was empty");
  }

  const lines = trimmed.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.trimStart().startsWith("{")) {
      continue;
    }

    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      // keep searching for the start of the trailing JSON block
    }
  }

  return JSON.parse(trimmed);
}

async function waitForServeJson(
  child: ChildProcessWithoutNullStreams,
): Promise<Record<string, unknown>> {
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `demo serve exited early with code ${child.exitCode}: ${stderr.trim() || stdout.trim()}`,
      );
    }

    try {
      const parsed = extractJsonObject(stdout);

      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "commands" in parsed
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // wait for more stdout
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  throw new Error(
    `timed out waiting for demo serve JSON output. stdout=${stdout.trim()} stderr=${stderr.trim()}`,
  );
}

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

  assert.match(instructions.commands.configure_target, /--strict-json$/);
  assert.match(
    instructions.commands.configure_target,
    /plugins\.entries\.openclaw-a2a-outbound\.config/,
  );
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

test("installed artifact exposes the documented quickstart flow end to end", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-a2a-install-"));
  const packDir = join(tempDir, "pack");
  const homeDir = join(tempDir, "home");
  const configDir = join(tempDir, "config");
  const dataDir = join(tempDir, "data");
  const cacheDir = join(tempDir, "cache");
  let serveChild: ChildProcessWithoutNullStreams | undefined;

  try {
    await mkdir(packDir, { recursive: true });

    const packResult = await execFileAsync(
      "npm",
      ["pack", "--silent", "--pack-destination", packDir],
      {
        cwd: packageDir,
        env: process.env,
      },
    );
    const tarballName = packResult.stdout.trim();
    const tarballPath = join(packDir, tarballName);
    const env = {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: dataDir,
      XDG_CACHE_HOME: cacheDir,
    };

    await execFileAsync(
      openclawBin,
      ["plugins", "install", tarballPath],
      {
        cwd: repoRoot,
        env,
      },
    );

    const demoRun = await execFileAsync(
      openclawBin,
      ["a2a", "demo", "run", "--json"],
      {
        cwd: repoRoot,
        env,
      },
    );
    const demoRunJson = JSON.parse(demoRun.stdout) as {
      ok?: boolean;
      steps?: Array<{ name?: string }>;
      continuation?: { task?: { task_id?: string } };
    };

    assert.equal(demoRunJson.ok, true);
    assert.deepEqual(
      demoRunJson.steps?.map((step) => step.name),
      ["list_targets", "send", "watch", "status", "continuation_send"],
    );
    assert.equal(typeof demoRunJson.continuation?.task?.task_id, "string");

    const continuationPath = join(tempDir, "continuation.json");
    await execFileAsync(
      openclawBin,
      [
        "a2a",
        "demo",
        "run",
        "--write-continuation",
        continuationPath,
      ],
      {
        cwd: repoRoot,
        env,
      },
    );
    const continuationFile = JSON.parse(
      await readFile(continuationPath, "utf8"),
    ) as {
      task?: { task_id?: string };
    };
    assert.equal(typeof continuationFile.task?.task_id, "string");

    const port = await reservePort();
    serveChild = spawn(
      openclawBin,
      [
        "a2a",
        "demo",
        "serve",
        "--port",
        String(port),
        "--json",
      ],
      {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const serveJson = await waitForServeJson(serveChild);
    const commands = serveJson.commands as
      | { configure_target?: string }
      | undefined;

    assert.equal(typeof commands?.configure_target, "string");

    await execFileAsync("bash", ["-lc", commands!.configure_target!], {
      cwd: repoRoot,
      env,
    });

    const doctor = await execFileAsync(
      openclawBin,
      ["a2a", "doctor", "--alias", "local-demo", "--json"],
      {
        cwd: repoRoot,
        env,
      },
    );
    const doctorJson = JSON.parse(doctor.stdout) as {
      ok?: boolean;
      checks?: Array<{ name?: string; status?: string }>;
    };

    assert.equal(doctorJson.ok, true);
    assert.equal(
      doctorJson.checks?.find((check) => check.name === "agent_card_reachable")
        ?.status,
      "pass",
    );
  } finally {
    if (serveChild !== undefined && serveChild.exitCode === null) {
      serveChild.kill("SIGINT");
      await once(serveChild, "exit");
    }

    await rm(tempDir, { recursive: true, force: true });
  }
});
