import test from "node:test";
import assert from "node:assert/strict";
import type { AgentCard, Message } from "@a2a-js/sdk";
import {
  A2AError,
  DefaultRequestHandler,
  type AgentExecutor,
} from "@a2a-js/sdk/server";
import { A2ALiveExecutionRegistry } from "../dist/live-execution-registry.js";
import { A2AInboundRequestHandler } from "../dist/request-handler.js";
import { createTaskSnapshot } from "../dist/response-mapping.js";
import { createTaskStore } from "../dist/task-store.js";
import { createUserMessage } from "./runtime-harness.js";

function createAgentCard(): AgentCard {
  return {
    name: "Test inbound agent",
    description: "Test inbound agent",
    protocolVersion: "0.3.0",
    version: "test",
    url: "https://agents.example.com/a2a/jsonrpc",
    preferredTransport: "JSONRPC",
    capabilities: {
      pushNotifications: false,
      streaming: false,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [],
  };
}

function createHandlerHarness(agentExecutor: AgentExecutor) {
  const taskRuntime = createTaskStore();
  const liveExecutions = new A2ALiveExecutionRegistry();
  const base = new DefaultRequestHandler(
    createAgentCard(),
    taskRuntime,
    agentExecutor,
    liveExecutions.eventBusManager,
  );

  return {
    taskRuntime,
    requestHandler: new A2AInboundRequestHandler(
      base,
      taskRuntime,
      liveExecutions,
      agentExecutor,
      ["text/plain", "application/json"],
    ),
  };
}

test("sendMessage rejects file-part requests before execution and before task creation", async () => {
  let executeCalls = 0;
  const harness = createHandlerHarness({
    execute: async () => {
      executeCalls += 1;
      throw new Error("executor should not run");
    },
    cancelTask: async () => {
      throw new Error("unused");
    },
  });

  await assert.rejects(
    () =>
      harness.requestHandler.sendMessage({
        message: createUserMessage({
          parts: [
            {
              kind: "file",
              file: {
                bytes: "aGVsbG8=",
                mimeType: "text/plain",
                name: "hello.txt",
              },
            },
          ],
        }),
      }),
    (error: unknown) => {
      assert.equal(error instanceof A2AError, true);
      assert.equal(
        error instanceof A2AError ? error.code : undefined,
        A2AError.invalidParams("unsupported").code,
      );
      assert.match(
        error instanceof A2AError ? error.message : "",
        /only accept text and data parts/,
      );
      return true;
    },
  );

  assert.equal(executeCalls, 0);
  assert.deepEqual(await harness.taskRuntime.listTaskIds(), []);
});

test("rejected file-part follow-up requests do not append history to an existing task", async () => {
  let executeCalls = 0;
  const harness = createHandlerHarness({
    execute: async () => {
      executeCalls += 1;
      throw new Error("executor should not run");
    },
    cancelTask: async () => {
      throw new Error("unused");
    },
  });
  const originalMessage: Message = createUserMessage({
    messageId: "message-existing",
    contextId: "context-existing",
    taskId: "task-existing",
    parts: [
      {
        kind: "text",
        text: "Original request",
      },
    ],
  });

  await harness.taskRuntime.save(
    createTaskSnapshot({
      taskId: "task-existing",
      contextId: "context-existing",
      state: "completed",
      history: [originalMessage],
      messageText: "Done",
    }),
  );

  await assert.rejects(
    () =>
      harness.requestHandler.sendMessage({
        message: createUserMessage({
          messageId: "message-follow-up-file",
          contextId: "context-existing",
          taskId: "task-existing",
          parts: [
            {
              kind: "text",
              text: "Please review this",
            },
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
      }),
    /only accept text and data parts/,
  );

  const persisted = await harness.taskRuntime.load("task-existing");

  assert.equal(executeCalls, 0);
  assert.deepEqual(await harness.taskRuntime.listTaskIds(), ["task-existing"]);
  assert.deepEqual(persisted?.history, [originalMessage]);
});
