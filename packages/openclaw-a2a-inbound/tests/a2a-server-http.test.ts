import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCard, Message, Task } from "@a2a-js/sdk";
import { A2AError } from "@a2a-js/sdk/server";
import { createA2AInboundServer } from "../dist/a2a-server.js";
import {
  createPluginRuntimeHarness,
  createTestAccount,
  createUserMessage,
  waitFor,
} from "./runtime-harness.js";
import { isMessage, isTask } from "./test-helpers.js";

async function createServerHarness(
  script: Parameters<typeof createPluginRuntimeHarness>[0],
  options: {
    account?: Parameters<typeof createTestAccount>[0];
    runtime?: Parameters<typeof createPluginRuntimeHarness>[1];
  } = {},
) {
  const account = createTestAccount(options.account);
  const { pluginRuntime } = options.runtime
    ? createPluginRuntimeHarness(script, options.runtime)
    : createPluginRuntimeHarness(script);
  const server = await createA2AInboundServer({
    accountId: "default",
    account,
    cfg: {},
    channelRuntime: pluginRuntime.channel,
    pluginRuntime,
  });

  return {
    account,
    ...server,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address.");
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

async function postJsonRpc(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/a2a/jsonrpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
}

function parseSseJsonRpcEvents(body: string): Array<{
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: unknown;
}> {
  return body
    .trim()
    .split("\n\n")
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");

      return JSON.parse(data) as {
        jsonrpc: string;
        id: number | string | null;
        result?: unknown;
        error?: unknown;
      };
    });
}

test("served agent card exposes normalized transports, capabilities, and mode metadata", async () => {
  const harness = await createServerHarness(async () => {});
  const routeServer = createServer((req, res) => {
    void harness.handle(req, res);
  });

  try {
    const baseUrl = await listen(routeServer);
    const response = await fetch(`${baseUrl}${harness.account.agentCardPath}`);
    const agentCard = (await response.json()) as AgentCard;

    assert.equal(response.status, 200);
    assert.equal(
      agentCard.url,
      new URL(harness.account.jsonRpcPath, harness.account.publicBaseUrl).toString(),
    );
    assert.equal(agentCard.preferredTransport, "JSONRPC");
    assert.deepEqual(agentCard.capabilities, {
      pushNotifications: false,
      streaming: true,
      stateTransitionHistory: false,
    });
    assert.deepEqual(agentCard.defaultInputModes, [
      "text/plain",
      "application/json",
    ]);
    assert.deepEqual(agentCard.defaultOutputModes, [
      "text/plain",
      "application/json",
    ]);
    assert.deepEqual(agentCard.additionalInterfaces, [
      {
        transport: "JSONRPC",
        url: new URL(harness.account.jsonRpcPath, harness.account.publicBaseUrl).toString(),
      },
    ]);
    assert.deepEqual(agentCard.skills?.[0]?.inputModes, [
      "text/plain",
      "application/json",
    ]);
    assert.deepEqual(agentCard.skills?.[0]?.outputModes, [
      "text/plain",
      "application/json",
    ]);
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
  }
});

test("inbound server starts when the json-file task store has an orphaned writer lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-a2a-inbound-server-stale-lock-"));
  const lockPath = join(root, ".writer.lock");

  await writeFile(
    lockPath,
    JSON.stringify({
      pid: 999_999_999,
      createdAt: new Date().toISOString(),
    }),
    "utf8",
  );

  const harness = await createServerHarness(
    async () => {},
    {
      account: {
        taskStore: {
          kind: "json-file",
          path: root,
        },
      },
    },
  );
  const routeServer = createServer((req, res) => {
    void harness.handle(req, res);
  });

  try {
    const baseUrl = await listen(routeServer);
    const response = await fetch(`${baseUrl}${harness.account.agentCardPath}`);
    const agentCard = (await response.json()) as AgentCard;

    assert.equal(response.status, 200);
    assert.equal(agentCard.name, "Default");
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP JSON-RPC message/send returns a direct Message for terminal replies", async () => {
  const harness = await createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-http-direct");
    emit({
      runId: "run-http-direct",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "HTTP direct reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-http-direct",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const routeServer = createServer((req, res) => {
    void harness.handle(req, res);
  });

  try {
    const baseUrl = await listen(routeServer);
    const response = await postJsonRpc(baseUrl, "message/send", {
      message: createUserMessage(),
    });
    const payload = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result: Message;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.jsonrpc, "2.0");
    assert.equal(payload.id, 1);
    assert.equal(payload.result.kind, "message");
    assert.equal(payload.result.parts[0]?.kind, "text");
    assert.equal(
      payload.result.parts[0] && "text" in payload.result.parts[0]
        ? payload.result.parts[0].text
        : undefined,
      "HTTP direct reply",
    );
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
  }
});

test("raw JSON-RPC message/stream returns an SDK SSE stream instead of methodNotFound", async () => {
  const harness = await createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-http-stream");
    emit({
      runId: "run-http-stream",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "HTTP streamed reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-http-stream",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const routeServer = createServer((req, res) => {
    void harness.handle(req, res);
  });

  try {
    const baseUrl = await listen(routeServer);
    const response = await postJsonRpc(baseUrl, "message/stream", {
      message: createUserMessage({
        messageId: "message:http-stream",
      }),
    });
    const events = parseSseJsonRpcEvents(await response.text());

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i);
    assert.equal(events.length, 1);
    assert.equal(isMessage(events[0]?.result), true);
    if (!isMessage(events[0]?.result)) {
      assert.fail("expected streamed message result");
    }

    assert.equal(
      events[0].result.parts[0] && "text" in events[0].result.parts[0]
        ? events[0].result.parts[0].text
        : undefined,
      "HTTP streamed reply",
    );
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
  }
});

test("raw JSON-RPC tasks/resubscribe returns an SDK SSE stream instead of methodNotFound", async () => {
  let releaseRun: (() => void) | undefined;
  const harness = await createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-http-resubscribe");
    emit({
      runId: "run-http-resubscribe",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Tool summary" },
      { kind: "tool" },
    );
    await new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    await params.dispatcherOptions.deliver(
      { text: "HTTP resubscribe final" },
      { kind: "final" },
    );
    emit({
      runId: "run-http-resubscribe",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const routeServer = createServer((req, res) => {
    void harness.handle(req, res);
  });

  try {
    const baseUrl = await listen(routeServer);
    const sendResponse = await postJsonRpc(baseUrl, "message/send", {
      message: createUserMessage({
        messageId: "message:http-resubscribe",
      }),
      configuration: {
        blocking: false,
      },
    });
    const sendPayload = (await sendResponse.json()) as {
      result: Task;
    };

    assert.equal(isTask(sendPayload.result), true);
    if (!isTask(sendPayload.result)) {
      assert.fail("expected promoted task");
    }

    await waitFor(async () => {
      const response = await postJsonRpc(baseUrl, "tasks/get", {
        id: sendPayload.result.id,
        historyLength: 10,
      });
      const payload = (await response.json()) as {
        result: Task;
      };

      return (
        payload.result.status.state === "working" &&
        Boolean(
          payload.result.artifacts?.some((artifact) =>
            artifact.artifactId.startsWith("tool-result-"),
          ),
        )
      );
    });

    const response = await postJsonRpc(baseUrl, "tasks/resubscribe", {
      id: sendPayload.result.id,
    });

    releaseRun?.();

    const events = parseSseJsonRpcEvents(await response.text());

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i);
    assert.equal(isTask(events[0]?.result), true);
    if (!isTask(events[0]?.result)) {
      assert.fail("expected initial resubscribe snapshot");
    }

    assert.equal(events[0].result.id, sendPayload.result.id);
    assert.equal(
      events.some(
        (event) =>
          typeof event.result === "object" &&
          event.result !== null &&
          "kind" in event.result &&
          event.result.kind === "status-update",
      ),
      true,
    );
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
  }
});

test("raw JSON-RPC still rejects removed push-notification methods at the boundary", async () => {
  let executed = false;
  const harness = await createServerHarness(async () => {
    executed = true;
  });
  const routeServer = createServer((req, res) => {
    void harness.handle(req, res);
  });

  try {
    const baseUrl = await listen(routeServer);
    const requests: Array<[string, Record<string, unknown>]> = [
      [
        "tasks/pushNotificationConfig/set",
        {
          taskId: "task-removed",
          pushNotificationConfig: {
            url: "https://example.com/hook",
          },
        },
      ],
      ["tasks/pushNotificationConfig/get", { id: "task-removed" }],
      ["tasks/pushNotificationConfig/list", { id: "task-removed" }],
      [
        "tasks/pushNotificationConfig/delete",
        { id: "task-removed", pushNotificationConfigId: "cfg-1" },
      ],
    ];

    for (const [method, params] of requests) {
      const response = await postJsonRpc(baseUrl, method, params);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      });
    }

    assert.equal(executed, false);
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
  }
});

test("HTTP JSON-RPC rejects inbound file parts with invalidParams before execution", async () => {
  let executed = false;
  const harness = await createServerHarness(async () => {
    executed = true;
  });
  const routeServer = createServer((req, res) => {
    void harness.handle(req, res);
  });

  try {
    const baseUrl = await listen(routeServer);
    const response = await postJsonRpc(baseUrl, "message/send", {
      message: createUserMessage({
        parts: [
          {
            kind: "file",
            file: {
              uri: "https://example.com/report.pdf",
              mimeType: "application/pdf",
              name: "report.pdf",
            },
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: A2AError.invalidParams("unsupported").toJSONRPCError().code,
        message:
          "message.parts[0].kind=file is not supported; inbound A2A requests only accept text and data parts.",
      },
    });
    assert.equal(executed, false);
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
  }
});

test("former /a2a/files paths fall through to the server 404 route", async () => {
  const harness = await createServerHarness(async () => {});
  const routeServer = createServer((req, res) => {
    void harness.handle(req, res);
  });

  try {
    const baseUrl = await listen(routeServer);
    const response = await fetch(`${baseUrl}/a2a/files/missing/missing/missing`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: {
        code: "A2A_ROUTE_NOT_FOUND",
        message: "No A2A inbound route matched this request.",
        details: {
          channel: "a2a",
          accountId: "default",
        },
      },
    });
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
  }
});

test("handle reports matched JSON-RPC requests as handled to an outer fallback server", async () => {
  const harness = await createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-http-fallback");
    emit({
      runId: "run-http-fallback",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Handled reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-http-fallback",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const routeServer = createServer(async (req, res) => {
    const handled = await harness.handle(req, res);

    if (!handled && !res.writableEnded) {
      res.statusCode = 404;
      res.end("outer fallback");
    }
  });

  try {
    const baseUrl = await listen(routeServer);
    const response = await postJsonRpc(baseUrl, "message/send", {
      message: createUserMessage(),
    });
    const payload = (await response.json()) as {
      result: Message;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.result.kind, "message");
    assert.equal(
      payload.result.parts[0] && "text" in payload.result.parts[0]
        ? payload.result.parts[0].text
        : undefined,
      "Handled reply",
    );
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
  }
});

test("restarting the server loses prior memory-backed task state", async () => {
  const initialHarness = await createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-restart-loss");
    emit({
      runId: "run-restart-loss",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Ephemeral reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-restart-loss",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const initialRouteServer = createServer((req, res) => {
    void initialHarness.handle(req, res);
  });
  let taskId: string | undefined;

  try {
    const baseUrl = await listen(initialRouteServer);
    const sendResponse = await postJsonRpc(baseUrl, "message/send", {
      message: createUserMessage({
        messageId: "message-restart-loss",
      }),
      configuration: {
        blocking: false,
      },
    });
    const sendPayload = (await sendResponse.json()) as {
      result: Task;
    };

    assert.equal(isTask(sendPayload.result), true);
    if (!isTask(sendPayload.result)) {
      assert.fail("expected in-process task");
    }

    taskId = sendPayload.result.id;

    await waitFor(async () => {
      const response = await postJsonRpc(baseUrl, "tasks/get", {
        id: taskId,
        historyLength: 10,
      });
      const payload = (await response.json()) as {
        result: Task;
      };

      return payload.result.status.state === "completed";
    });
  } finally {
    await closeHttpServer(initialRouteServer);
    initialHarness.close();
  }

  if (!taskId) {
    assert.fail("expected task id");
  }

  const restartedHarness = await createServerHarness(async () => {});
  const restartedRouteServer = createServer((req, res) => {
    void restartedHarness.handle(req, res);
  });

  try {
    const baseUrl = await listen(restartedRouteServer);
    const response = await postJsonRpc(baseUrl, "tasks/get", {
      id: taskId,
      historyLength: 10,
    });
    const payload = (await response.json()) as {
      error: {
        code: number;
        message: string;
      };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.error.code, -32001);
    assert.match(payload.error.message, /Task not found/);
  } finally {
    await closeHttpServer(restartedRouteServer);
    restartedHarness.close();
  }
});

test("restarting the server with json-file task storage preserves task state and closes orphaned resubscribe streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-a2a-inbound-http-"));
  let taskId: string | undefined;
  const initialHarness = await createServerHarness(
    async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-restart-json");
      emit({
        runId: "run-restart-json",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        { text: "Tool summary" },
        { kind: "tool" },
      );
      await new Promise<void>(() => {});
    },
    {
      account: {
        taskStore: {
          kind: "json-file",
          path: root,
        },
      },
    },
  );
  const initialRouteServer = createServer((req, res) => {
    void initialHarness.handle(req, res);
  });

  try {
    const baseUrl = await listen(initialRouteServer);
    const sendResponse = await postJsonRpc(baseUrl, "message/send", {
      message: createUserMessage({
        messageId: "message-restart-json",
      }),
      configuration: {
        blocking: false,
      },
    });
    const sendPayload = (await sendResponse.json()) as {
      result: Task;
    };

    assert.equal(isTask(sendPayload.result), true);
    if (!isTask(sendPayload.result)) {
      assert.fail("expected persisted task");
    }

    taskId = sendPayload.result.id;

    await waitFor(async () => {
      const response = await postJsonRpc(baseUrl, "tasks/get", {
        id: taskId,
        historyLength: 10,
      });
      const payload = (await response.json()) as {
        result: Task;
      };

      return payload.result.status.state === "working";
    });
  } finally {
    await closeHttpServer(initialRouteServer);
    initialHarness.close();
  }

  if (!taskId) {
    assert.fail("expected task id");
  }

  const restartedHarness = await createServerHarness(
    async () => {},
    {
      account: {
        taskStore: {
          kind: "json-file",
          path: root,
        },
      },
    },
  );
  const restartedRouteServer = createServer((req, res) => {
    void restartedHarness.handle(req, res);
  });

  try {
    const baseUrl = await listen(restartedRouteServer);
    const taskResponse = await postJsonRpc(baseUrl, "tasks/get", {
      id: taskId,
      historyLength: 10,
    });
    const taskPayload = (await taskResponse.json()) as {
      result: Task;
    };
    const resubscribeResponse = await postJsonRpc(baseUrl, "tasks/resubscribe", {
      id: taskId,
    });
    const resubscribeEvents = parseSseJsonRpcEvents(await resubscribeResponse.text());

    assert.equal(taskResponse.status, 200);
    assert.equal(taskPayload.result.status.state, "working");
    assert.equal(resubscribeEvents.length, 1);
    assert.equal(isTask(resubscribeEvents[0]?.result), true);
    if (!isTask(resubscribeEvents[0]?.result)) {
      assert.fail("expected persisted snapshot");
    }

    assert.equal(resubscribeEvents[0].result.id, taskId);
    assert.equal(resubscribeEvents[0].result.status.state, "working");
  } finally {
    await closeHttpServer(restartedRouteServer);
    restartedHarness.close();
    await rm(root, { recursive: true, force: true });
  }
});
