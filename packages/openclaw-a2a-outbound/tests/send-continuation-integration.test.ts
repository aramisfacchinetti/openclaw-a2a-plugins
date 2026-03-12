import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Message, Task } from "@a2a-js/sdk";
import { A2AOutboundService } from "../dist/service.js";
import { parseA2AOutboundPluginConfig } from "../dist/config.js";
import type { A2AToolResult, SuccessEnvelope } from "../dist/result-shape.js";
import { createA2AInboundServer } from "../../openclaw-a2a-inbound/src/a2a-server.js";
import {
  createPluginRuntimeHarness,
  createTestAccount,
} from "../../openclaw-a2a-inbound/tests/runtime-harness.js";

function asSuccess(result: A2AToolResult): SuccessEnvelope {
  if (result.ok !== true) {
    throw new TypeError("expected success result");
  }

  return result;
}

function taskContinuationFromSummary(
  summary: SuccessEnvelope["summary"],
): NonNullable<NonNullable<SuccessEnvelope["summary"]["continuation"]>["task"]> {
  const task = summary.continuation?.task;

  if (!task) {
    throw new TypeError("expected task continuation");
  }

  return task;
}

function conversationContinuationFromSummary(
  summary: SuccessEnvelope["summary"],
): NonNullable<
  NonNullable<SuccessEnvelope["summary"]["continuation"]>["conversation"]
> {
  const conversation = summary.continuation?.conversation;

  if (!conversation) {
    throw new TypeError("expected conversation continuation");
  }

  return conversation;
}

function taskHandleFromSummary(summary: SuccessEnvelope["summary"]): string {
  const task = taskContinuationFromSummary(summary);

  if (typeof task.task_handle !== "string") {
    throw new TypeError("expected task_handle summary field");
  }

  return task.task_handle;
}

function taskIdFromSummary(summary: SuccessEnvelope["summary"]): string {
  const task = taskContinuationFromSummary(summary);

  if (typeof task.task_id !== "string") {
    throw new TypeError("expected task_id summary field");
  }

  return task.task_id;
}

function asTask(raw: SuccessEnvelope["raw"]): Task {
  if (typeof raw !== "object" || raw === null || (raw as { kind?: unknown }).kind !== "task") {
    throw new TypeError("expected raw task");
  }

  return raw as Task;
}

function readMessageText(message: Message): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new TypeError("expected bound server address");
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

test("integration: send resumes the same inbound task via task_handle", async (t) => {
  let callCount = 0;
  const { pluginRuntime } = createPluginRuntimeHarness(async ({ params, emit }) => {
    callCount += 1;
    params.replyOptions?.onAgentRunStart?.(`run-${callCount}`);
    emit({
      runId: `run-${callCount}`,
      stream: "lifecycle",
      data: { phase: "start" },
    });

    if (callCount === 1) {
      emit({
        runId: "run-1",
        stream: "tool",
        data: {
          phase: "result",
          name: "exec",
          toolCallId: "exec/1",
          isError: false,
          result: {
            status: "approval-pending",
            requiresApproval: {
              type: "approval_request",
              prompt: "Approve the delegated action?",
            },
            command: "echo approved",
          },
        },
      });
      emit({
        runId: "run-1",
        stream: "lifecycle",
        data: { phase: "end" },
      });
      return;
    }

    await params.dispatcherOptions.deliver(
      { text: "Approved and completed." },
      { kind: "final" },
    );
    emit({
      runId: `run-${callCount}`,
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  let inboundServer:
    | ReturnType<typeof createA2AInboundServer>
    | undefined;
  const routeServer = createServer((req, res) => {
    if (!inboundServer) {
      res.statusCode = 503;
      res.end("server not ready");
      return;
    }

    void inboundServer.handle(req, res);
  });

  const baseUrl = await listen(routeServer);
  const account = createTestAccount({
    publicBaseUrl: baseUrl,
  });
  inboundServer = createA2AInboundServer({
    accountId: "default",
    account,
    cfg: {},
    channelRuntime: pluginRuntime.channel,
    pluginRuntime,
  });

  t.after(async () => {
    inboundServer?.close();
    await closeHttpServer(routeServer);
  });

  const service = new A2AOutboundService({
    parsedConfig: parseA2AOutboundPluginConfig({
      enabled: true,
      defaults: {
        timeoutMs: 1_000,
        cardPath: account.agentCardPath,
        preferredTransports: ["JSONRPC", "HTTP+JSON"],
        serviceParameters: {},
      },
      targets: [
        {
          alias: "inbound",
          baseUrl,
          cardPath: account.agentCardPath,
          preferredTransports: ["JSONRPC", "HTTP+JSON"],
          default: true,
        },
      ],
      taskHandles: {
        ttlMs: 60_000,
        maxEntries: 100,
      },
      policy: {
        acceptedOutputModes: ["text/plain"],
        normalizeBaseUrl: true,
        enforceSupportedTransports: true,
        allowTargetUrlOverride: false,
      },
    }),
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });

  const firstSend = asSuccess(
    await service.execute({
      action: "send",
      parts: [{ kind: "text", text: "Please request approval first." }],
    }),
  );
  const taskHandle = taskHandleFromSummary(firstSend.summary);
  const taskId = taskIdFromSummary(firstSend.summary);
  const firstTask = taskContinuationFromSummary(firstSend.summary);
  const firstConversation = conversationContinuationFromSummary(firstSend.summary);

  assert.equal(firstSend.action, "send");
  assert.equal(firstTask.status, "input-required");
  assert.equal(firstTask.task_id, taskId);
  assert.equal(typeof firstConversation.context_id, "string");

  const secondSend = asSuccess(
    await service.execute({
      action: "send",
      task_handle: taskHandle,
      parts: [{ kind: "text", text: "Approved. Continue and finish." }],
    }),
  );
  const secondTask = taskContinuationFromSummary(secondSend.summary);
  const secondConversation = conversationContinuationFromSummary(secondSend.summary);

  assert.equal(secondSend.action, "send");
  assert.equal(secondTask.task_handle, taskHandle);
  assert.equal(secondTask.task_id, taskId);
  assert.equal(secondTask.status, "completed");
  assert.equal(secondConversation.context_id, firstConversation.context_id);

  const status = asSuccess(
    await service.execute({
      action: "status",
      task_handle: taskHandle,
      history_length: 10,
    }),
  );
  const rawTask = asTask(status.raw);
  const userTurns = (rawTask.history ?? [])
    .filter((message) => message.role === "user")
    .map(readMessageText);
  const statusTask = taskContinuationFromSummary(status.summary);

  assert.equal(statusTask.task_id, taskId);
  assert.equal(statusTask.status, "completed");
  assert.equal(callCount, 2);
  assert.deepEqual(userTurns, [
    "Please request approval first.",
    "Approved. Continue and finish.",
  ]);
});
