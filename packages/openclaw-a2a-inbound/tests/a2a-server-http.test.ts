import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AgentCard, Message, Task } from "@a2a-js/sdk";
import { A2AError } from "@a2a-js/sdk/server";
import { createA2AInboundServer } from "../dist/a2a-server.js";
import {
  createPluginRuntimeHarness,
  createTestAccount,
  createUserMessage,
  waitFor,
} from "./runtime-harness.js";
import { isTask } from "./test-helpers.js";

function createServerHarness(
  script: Parameters<typeof createPluginRuntimeHarness>[0],
) {
  const account = createTestAccount();
  const { pluginRuntime } = createPluginRuntimeHarness(script);
  const server = createA2AInboundServer({
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

test("served agent card exposes the minimal JSON-RPC transport and capabilities", async () => {
  const harness = createServerHarness(async () => {});
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
      streaming: false,
    });
    assert.deepEqual(agentCard.defaultInputModes, [
      "text/plain",
      "application/json",
    ]);
    assert.deepEqual(agentCard.defaultOutputModes, [
      "text/plain",
      "application/json",
    ]);
    assert.ok(
      agentCard.additionalInterfaces === undefined ||
        agentCard.additionalInterfaces.length === 0,
    );
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
  }
});

test("HTTP JSON-RPC message/send returns a direct Message for terminal replies", async () => {
  const harness = createServerHarness(async ({ params, emit }) => {
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

test("raw JSON-RPC rejects removed optional methods at the boundary", async () => {
  let executed = false;
  const harness = createServerHarness(async () => {
    executed = true;
  });
  const routeServer = createServer((req, res) => {
    void harness.handle(req, res);
  });

  try {
    const baseUrl = await listen(routeServer);
    const requests: Array<[string, Record<string, unknown>]> = [
      ["message/stream", { message: createUserMessage() }],
      ["tasks/resubscribe", { id: "task-removed" }],
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
  const harness = createServerHarness(async () => {
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
  const harness = createServerHarness(async () => {});
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
  const harness = createServerHarness(async ({ params, emit }) => {
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

test("restarting the server loses prior process-local task state", async () => {
  const initialHarness = createServerHarness(async ({ params, emit }) => {
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

  const restartedHarness = createServerHarness(async () => {});
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
