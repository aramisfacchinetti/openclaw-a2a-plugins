import test from "node:test";
import assert from "node:assert/strict";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { createA2AInboundServer } from "../dist/a2a-server.js";
import { createPluginRuntimeHarness, createTestAccount, createUserMessage } from "./runtime-harness.js";

test("protocol queued replies append artifacts onto the local A2A task", async () => {
  const account = createTestAccount();
  const { pluginRuntime } = createPluginRuntimeHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-queued-reply");
    emit({
      runId: "run-queued-reply",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Initial tool summary" },
      { kind: "tool" },
    );
    await params.dispatcherOptions.deliver(
      { text: "Initial task completed" },
      { kind: "final" },
    );
    emit({
      runId: "run-queued-reply",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  const server = await createA2AInboundServer({
    accountId: "default",
    account,
    cfg: {},
    channelRuntime: pluginRuntime.channel,
    pluginRuntime: pluginRuntime as PluginRuntime,
  });

  try {
    const initial = await server.requestHandler.sendMessage({
      message: createUserMessage({
        messageId: "queued-reply-user-message",
        parts: [{ kind: "text", text: "Start a tracked task." }],
      }),
      configuration: {
        blocking: false,
      },
    });

    assert.equal(initial.kind, "task");

    const delivery = await server.deliverQueuedReply({
      taskId: initial.id,
      payload: {
        text: "Queued follow-up artifact",
        channelData: {
          a2a: {
            phase: "queued",
          },
        },
      },
      sessionKey: "session:test",
      to: "a2a:default",
    });

    assert.equal(delivery.ok, true);
    assert.equal(typeof delivery.messageId, "string");

    const task = await server.requestHandler.getTask({ id: initial.id });
    const queuedArtifact = task.artifacts?.find(
      (artifact) => artifact.artifactId === delivery.messageId,
    );

    assert.ok(queuedArtifact);
    assert.equal(queuedArtifact?.name, "Queued follow-up reply");
    assert.deepEqual(queuedArtifact?.parts[0], {
      kind: "text",
      text: "Queued follow-up artifact",
    });
    assert.deepEqual(queuedArtifact?.parts[1], {
      kind: "data",
      data: {
        channelData: {
          a2a: {
            phase: "queued",
          },
        },
      },
    });
  } finally {
    server.close();
  }
});
