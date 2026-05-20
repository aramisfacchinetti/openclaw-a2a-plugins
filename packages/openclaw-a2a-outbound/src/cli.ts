import { writeFile } from "node:fs/promises";
import { A2AOutboundService } from "./service.js";
import {
  DEMO_AGENT_CARD_PATH,
  DEMO_JSON_RPC_PATH,
  LOCAL_DEMO_ALIAS,
  createDemoOutboundConfig,
  startDemoPeerServer,
  type StartedDemoPeer,
} from "./demo-peer.js";
import { PLUGIN_ID } from "./constants.js";
import type { A2AOutboundPluginConfig } from "./config.js";
import type { A2AToolResult, RemoteAgentSummary } from "./result-shape.js";

type CliCommand = {
  description(value: string): CliCommand;
  command(value: string): CliCommand;
  argument?(flags: string, description?: string): CliCommand;
  option(flags: string, description?: string, defaultValue?: unknown): CliCommand;
  action(handler: (opts: CommandOptions) => unknown): CliCommand;
};

type CliProgram = {
  command(value: string): CliCommand;
};

type RegisterA2ACliOptions = {
  pluginConfig: A2AOutboundPluginConfig;
  rootConfig?: unknown;
};

type CommandOptions = Record<string, unknown>;

export type DemoRunOptions = {
  writeContinuation?: string;
};

export type DemoRunStep = {
  name: "list_targets" | "send" | "watch" | "status" | "continuation_send";
  ok: boolean;
  summary?: RemoteAgentSummary;
  error?: unknown;
};

export type DemoRunResult = {
  ok: boolean;
  peer: {
    base_url: string;
    agent_card_url: string;
    json_rpc_url: string;
  };
  alias: typeof LOCAL_DEMO_ALIAS;
  steps: DemoRunStep[];
  continuation?: NonNullable<RemoteAgentSummary["continuation"]>;
  continuation_path?: string;
};

export type DemoServeInstructions = {
  base_url: string;
  agent_card_url: string;
  json_rpc_url: string;
  commands: {
    enable_plugin: string;
    configure_target: string;
  };
  remote_agent_payloads: {
    list_targets: Record<string, unknown>;
    send: Record<string, unknown>;
    watch: Record<string, unknown>;
    status: Record<string, unknown>;
    continuation_replay: Record<string, unknown>;
  };
};

export type DoctorCheck = {
  name:
    | "plugin_cli_loaded"
    | "plugins_global_enabled"
    | "plugin_entry_enabled"
    | "plugin_config_enabled"
    | "target_present"
    | "agent_card_reachable";
  status: "pass" | "fail" | "warn";
  message: string;
  details?: Record<string, unknown>;
};

export type DoctorResult = {
  ok: boolean;
  alias: string;
  checks: DoctorCheck[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asErrorObject(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}

function assertSuccess<T extends A2AToolResult>(
  step: DemoRunStep["name"],
  result: T,
): Extract<T, { ok: true }> {
  if (result.ok !== true) {
    throw new Error(`${step} failed: ${result.error.message}`);
  }

  return result as Extract<T, { ok: true }>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function continuationPlaceholder(baseUrl: string): Record<string, unknown> {
  return {
    target: {
      target_url: new URL("/", baseUrl).toString(),
      card_path: DEMO_AGENT_CARD_PATH,
      preferred_transports: ["JSONRPC", "HTTP+JSON"],
      target_alias: LOCAL_DEMO_ALIAS,
    },
    task: {
      task_id: "<summary.continuation.task.task_id>",
      task_handle: "<summary.continuation.task.task_handle>",
    },
    conversation: {
      context_id: "<summary.continuation.conversation.context_id>",
      can_send: true,
    },
  };
}

function printHumanDemoRun(result: DemoRunResult): void {
  console.log("OpenClaw A2A local demo");
  console.log(`Peer: ${result.peer.base_url}`);
  console.log(`Agent card: ${result.peer.agent_card_url}`);
  console.log(`JSON-RPC: ${result.peer.json_rpc_url}`);
  console.log("");

  for (const step of result.steps) {
    const label = step.ok ? "[ok]" : "[fail]";
    const summaryText =
      step.summary?.message_text ??
      (step.summary?.targets ? `${step.summary.targets.length} target(s)` : "");
    console.log(`${label} ${step.name}${summaryText ? ` - ${summaryText}` : ""}`);
  }

  if (result.continuation !== undefined) {
    console.log("");
    console.log("Persist this summary.continuation for follow-up:");
    console.log(JSON.stringify(result.continuation, null, 2));
  }

  if (result.continuation_path !== undefined) {
    console.log("");
    console.log(`Continuation written to ${result.continuation_path}`);
  }
}

function printHumanServeInstructions(instructions: DemoServeInstructions): void {
  console.log("OpenClaw A2A local demo peer");
  console.log(`Base URL: ${instructions.base_url}`);
  console.log(`Agent card: ${instructions.agent_card_url}`);
  console.log(`JSON-RPC: ${instructions.json_rpc_url}`);
  console.log("");
  console.log("Configure OpenClaw outbound:");
  console.log(instructions.commands.enable_plugin);
  console.log(instructions.commands.configure_target);
  console.log("");
  console.log("remote_agent payloads:");

  for (const [name, payload] of Object.entries(instructions.remote_agent_payloads)) {
    console.log("");
    console.log(`${name}:`);
    console.log(JSON.stringify(payload, null, 2));
  }
}

function printHumanDoctor(result: DoctorResult): void {
  console.log(`OpenClaw A2A doctor (${result.alias})`);

  for (const check of result.checks) {
    console.log(`[${check.status}] ${check.name}: ${check.message}`);
  }
}

function parsePort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`invalid port: ${String(value)}`);
  }

  return parsed;
}

function outputResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  }
}

async function runCommand(
  json: boolean,
  run: () => Promise<unknown>,
  printHuman?: (value: never) => void,
): Promise<void> {
  try {
    const result = await run();

    if (json) {
      outputResult(result, true);
    } else if (printHuman) {
      printHuman(result as never);
    }
  } catch (error) {
    process.exitCode = 1;

    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: asErrorObject(error),
          },
          null,
          2,
        ),
      );
      return;
    }

    console.error(error instanceof Error ? error.message : String(error));
  }
}

export function buildDemoServeInstructions(
  peer: Pick<StartedDemoPeer, "baseUrl" | "cardUrl" | "jsonRpcUrl">,
): DemoServeInstructions {
  const config = createDemoOutboundConfig(peer.baseUrl);
  const configJson = JSON.stringify(config);
  const continuation = continuationPlaceholder(peer.baseUrl);

  return {
    base_url: peer.baseUrl,
    agent_card_url: peer.cardUrl,
    json_rpc_url: peer.jsonRpcUrl,
    commands: {
      enable_plugin: `openclaw plugins enable ${PLUGIN_ID}`,
      configure_target: `openclaw config set plugins.entries.${PLUGIN_ID}.config ${shellQuote(
        configJson,
      )} --strict-json`,
    },
    remote_agent_payloads: {
      list_targets: {
        action: "list_targets",
      },
      send: {
        action: "send",
        target_alias: LOCAL_DEMO_ALIAS,
        task_requirement: "required",
        parts: [
          {
            kind: "text",
            text: "Create a durable demo task.",
          },
        ],
      },
      watch: {
        action: "watch",
        continuation,
      },
      status: {
        action: "status",
        continuation,
      },
      continuation_replay: {
        action: "send",
        continuation,
        parts: [
          {
            kind: "text",
            text: "Continue from the persisted continuation.",
          },
        ],
      },
    },
  };
}

export async function runDemoRun(
  options: DemoRunOptions = {},
): Promise<DemoRunResult> {
  const peer = await startDemoPeerServer();

  try {
    const service = new A2AOutboundService({
      parsedConfig: createDemoOutboundConfig(peer.baseUrl),
    });
    const steps: DemoRunStep[] = [];
    const listTargets = await service.execute({ action: "list_targets" });
    const listTargetsSuccess = assertSuccess("list_targets", listTargets);
    steps.push({
      name: "list_targets",
      ok: true,
      summary: listTargetsSuccess.summary,
    });

    const send = await service.execute({
      action: "send",
      target_alias: LOCAL_DEMO_ALIAS,
      task_requirement: "required",
      message_id: "demo-message-0001",
      parts: [
        {
          kind: "text",
          text: "Create a durable demo task and return a continuation.",
        },
      ],
    });
    const sendSuccess = assertSuccess("send", send);
    steps.push({
      name: "send",
      ok: true,
      summary: sendSuccess.summary,
    });

    const continuation = sendSuccess.summary.continuation;

    if (continuation === undefined) {
      throw new Error("demo send did not return summary.continuation");
    }

    const watch = await service.execute({
      action: "watch",
      continuation,
    });
    const watchSuccess = assertSuccess("watch", watch);
    steps.push({
      name: "watch",
      ok: true,
      summary: watchSuccess.summary,
    });

    const status = await service.execute({
      action: "status",
      continuation,
    });
    const statusSuccess = assertSuccess("status", status);
    steps.push({
      name: "status",
      ok: true,
      summary: statusSuccess.summary,
    });

    const continuationSend = await service.execute({
      action: "send",
      continuation,
      message_id: "demo-message-0002",
      parts: [
        {
          kind: "text",
          text: "Continue from the persisted continuation and close the loop.",
        },
      ],
    });
    const continuationSendSuccess = assertSuccess(
      "continuation_send",
      continuationSend,
    );
    steps.push({
      name: "continuation_send",
      ok: true,
      summary: continuationSendSuccess.summary,
    });

    if (options.writeContinuation !== undefined) {
      await writeFile(
        options.writeContinuation,
        `${JSON.stringify(continuation, null, 2)}\n`,
        "utf8",
      );
    }

    return {
      ok: true,
      peer: {
        base_url: peer.baseUrl,
        agent_card_url: peer.cardUrl,
        json_rpc_url: peer.jsonRpcUrl,
      },
      alias: LOCAL_DEMO_ALIAS,
      steps,
      continuation,
      ...(options.writeContinuation !== undefined
        ? { continuation_path: options.writeContinuation }
        : {}),
    };
  } finally {
    await peer.close();
  }
}

function readPluginEntry(rootConfig: unknown): Record<string, unknown> | undefined {
  if (!isRecord(rootConfig)) {
    return undefined;
  }

  const plugins = rootConfig.plugins;

  if (!isRecord(plugins)) {
    return undefined;
  }

  const entries = plugins.entries;

  if (!isRecord(entries)) {
    return undefined;
  }

  const entry = entries[PLUGIN_ID];
  return isRecord(entry) ? entry : undefined;
}

function pluginsGloballyEnabled(rootConfig: unknown): boolean {
  return !(
    isRecord(rootConfig) &&
    isRecord(rootConfig.plugins) &&
    rootConfig.plugins.enabled === false
  );
}

async function probeAgentCard(target: {
  baseUrl: string;
  cardPath: string;
}): Promise<{ ok: true; card: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const response = await fetch(new URL(target.cardPath, target.baseUrl), {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}`,
      };
    }

    const card = (await response.json()) as unknown;

    if (!isRecord(card) || typeof card.name !== "string") {
      return {
        ok: false,
        error: "agent card response is not a valid object with name",
      };
    }

    return {
      ok: true,
      card,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runDoctor(params: {
  alias?: string;
  pluginConfig: A2AOutboundPluginConfig;
  rootConfig?: unknown;
}): Promise<DoctorResult> {
  const alias = params.alias ?? LOCAL_DEMO_ALIAS;
  const checks: DoctorCheck[] = [
    {
      name: "plugin_cli_loaded",
      status: "pass",
      message: `${PLUGIN_ID} registered this command family`,
    },
    {
      name: "plugins_global_enabled",
      status: pluginsGloballyEnabled(params.rootConfig) ? "pass" : "fail",
      message: pluginsGloballyEnabled(params.rootConfig)
        ? "plugins.enabled does not disable plugin loading"
        : "plugins.enabled=false disables plugin loading",
    },
  ];
  const pluginEntry = readPluginEntry(params.rootConfig);
  const pluginEntryEnabled = pluginEntry?.enabled !== false;

  checks.push({
    name: "plugin_entry_enabled",
    status: pluginEntryEnabled ? "pass" : "fail",
    message: pluginEntryEnabled
      ? `plugins.entries.${PLUGIN_ID}.enabled is not false`
      : `plugins.entries.${PLUGIN_ID}.enabled=false`,
  });

  checks.push({
    name: "plugin_config_enabled",
    status: params.pluginConfig.enabled === true ? "pass" : "fail",
    message:
      params.pluginConfig.enabled === true
        ? `${PLUGIN_ID} config.enabled=true`
        : `${PLUGIN_ID} config.enabled is not true`,
  });

  const target = params.pluginConfig.targets.find((entry) => entry.alias === alias);

  checks.push({
    name: "target_present",
    status: target !== undefined ? "pass" : "fail",
    message:
      target !== undefined
        ? `target alias "${alias}" is configured`
        : `target alias "${alias}" is not configured`,
  });

  if (target !== undefined) {
    const cardProbe = await probeAgentCard({
      baseUrl: target.baseUrl,
      cardPath: target.cardPath,
    });

    checks.push({
      name: "agent_card_reachable",
      status: cardProbe.ok ? "pass" : "fail",
      message: cardProbe.ok
        ? `agent card reachable at ${new URL(target.cardPath, target.baseUrl).toString()}`
        : `agent card unreachable: ${cardProbe.error}`,
      ...(cardProbe.ok
        ? {
            details: {
              name: cardProbe.card.name,
              protocolVersion: cardProbe.card.protocolVersion,
            },
          }
        : {}),
    });
  } else {
    checks.push({
      name: "agent_card_reachable",
      status: "fail",
      message: "no target to probe",
    });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    alias,
    checks,
  };
}

export function registerA2ACli(
  program: CliProgram,
  options: RegisterA2ACliOptions,
): void {
  const a2a = program.command("a2a").description("A2A outbound demo and diagnostics");
  const demo = a2a.command("demo").description("Run local A2A onboarding demos");

  demo
    .command("run")
    .description("Run a zero-config local outbound A2A demo")
    .option("--json", "Output machine-readable JSON", false)
    .option(
      "--write-continuation <path>",
      "Write the first summary.continuation JSON to a file",
    )
    .action(async (opts: CommandOptions) => {
      await runCommand(
        Boolean(opts.json),
        () =>
          runDemoRun({
            ...(typeof opts.writeContinuation === "string"
              ? { writeContinuation: opts.writeContinuation }
              : {}),
          }),
        printHumanDemoRun,
      );
    });

  demo
    .command("serve")
    .description("Serve the deterministic local A2A demo peer")
    .option("--port <port>", "Port to bind; defaults to an ephemeral port")
    .option("--json", "Output machine-readable JSON", false)
    .action(async (opts: CommandOptions) => {
      await runCommand(
        Boolean(opts.json),
        async () => {
          const peer = await startDemoPeerServer({
            port: parsePort(opts.port),
          });
          const instructions = buildDemoServeInstructions(peer);
          const shutdown = async () => {
            await peer.close();
          };

          process.once("SIGINT", () => {
            void shutdown().finally(() => {
              process.exit(0);
            });
          });
          process.once("SIGTERM", () => {
            void shutdown().finally(() => {
              process.exit(0);
            });
          });

          if (Boolean(opts.json)) {
            console.log(JSON.stringify(instructions, null, 2));
          } else {
            printHumanServeInstructions(instructions);
          }

          await new Promise<void>(() => {});
        },
      );
    });

  a2a
    .command("doctor")
    .description("Validate outbound A2A plugin config and target reachability")
    .option("--alias <alias>", "Target alias to inspect", LOCAL_DEMO_ALIAS)
    .option("--json", "Output machine-readable JSON", false)
    .action(async (opts: CommandOptions) => {
      await runCommand(
        Boolean(opts.json),
        async () => {
          const result = await runDoctor({
            alias: typeof opts.alias === "string" ? opts.alias : LOCAL_DEMO_ALIAS,
            pluginConfig: options.pluginConfig,
            rootConfig: options.rootConfig,
          });

          if (!result.ok) {
            process.exitCode = 1;
          }

          return result;
        },
        printHumanDoctor,
      );
    });
}

export const DEMO_SERVE_PATHS = {
  agentCardPath: DEMO_AGENT_CARD_PATH,
  jsonRpcPath: DEMO_JSON_RPC_PATH,
} as const;
