import test from "node:test";
import assert from "node:assert/strict";
import { A2AOutboundService } from "../dist/service.js";
import {
  DEMO_AGENT_NAME,
  LOCAL_DEMO_ALIAS,
  createDemoOutboundConfig,
  startDemoPeerServer,
} from "../dist/demo-peer.js";
import type { A2AToolResult } from "../dist/result-shape.js";

function success(result: A2AToolResult): Extract<A2AToolResult, { ok: true }> {
  if (result.ok !== true) {
    throw new Error(result.error.message);
  }

  assert.equal(result.ok, true);
  return result;
}

test("demo peer serves a discoverable A2A agent card", async () => {
  const peer = await startDemoPeerServer();

  try {
    const response = await fetch(peer.cardUrl);
    assert.equal(response.ok, true);

    const card = (await response.json()) as {
      name?: string;
      protocolVersion?: string;
      capabilities?: { streaming?: boolean };
      additionalInterfaces?: Array<{ transport?: string; url?: string }>;
    };

    assert.equal(card.name, DEMO_AGENT_NAME);
    assert.equal(card.protocolVersion, "0.3.0");
    assert.equal(card.capabilities?.streaming, true);
    assert.equal(card.additionalInterfaces?.[0]?.transport, "JSONRPC");
    assert.equal(card.additionalInterfaces?.[0]?.url, peer.jsonRpcUrl);
  } finally {
    await peer.close();
  }
});

test("demo peer supports direct replies, task replies, watch, status, and continuation replay", async () => {
  const peer = await startDemoPeerServer();

  try {
    const service = new A2AOutboundService({
      parsedConfig: createDemoOutboundConfig(peer.baseUrl),
    });

    const targets = success(await service.execute({ action: "list_targets" }));
    assert.equal(targets.summary.targets?.[0]?.target_alias, LOCAL_DEMO_ALIAS);

    const direct = success(await service.execute({
      action: "send",
      target_alias: LOCAL_DEMO_ALIAS,
      parts: [{ kind: "text", text: "direct hello" }],
    }));
    assert.equal(direct.summary.response_kind, "message");
    assert.match(direct.summary.message_text ?? "", /direct hello/);
    assert.equal(direct.summary.continuation?.conversation?.can_send, true);

    const task = success(await service.execute({
      action: "send",
      target_alias: LOCAL_DEMO_ALIAS,
      task_requirement: "required",
      parts: [{ kind: "text", text: "Create a durable task." }],
    }));
    assert.equal(task.summary.response_kind, "task");
    assert.equal(task.summary.continuation?.target.target_alias, LOCAL_DEMO_ALIAS);
    assert.ok(task.summary.continuation?.task?.task_id);

    const continuation = task.summary.continuation;
    assert.ok(continuation);

    const watch = success(await service.execute({
      action: "watch",
      continuation,
    }));
    assert.equal(watch.summary.response_kind, "task");
    assert.match(watch.summary.message_text ?? "", /durable task/);

    const status = success(await service.execute({
      action: "status",
      continuation,
    }));
    assert.equal(status.summary.continuation?.task?.status, "completed");

    const replay = success(await service.execute({
      action: "send",
      continuation,
      parts: [
        {
          kind: "text",
          text: "Continue from the persisted continuation.",
        },
      ],
    }));
    assert.match(replay.summary.message_text ?? "", /resumed/);
    assert.equal(
      replay.summary.continuation?.task?.task_id,
      continuation.task?.task_id,
    );
  } finally {
    await peer.close();
  }
});

test("demo peer exposes deterministic cancel semantics for non-terminal tasks", async () => {
  const peer = await startDemoPeerServer();

  try {
    const service = new A2AOutboundService({
      parsedConfig: createDemoOutboundConfig(peer.baseUrl),
    });
    const started = success(await service.execute({
      action: "send",
      target_alias: LOCAL_DEMO_ALIAS,
      task_requirement: "required",
      parts: [{ kind: "text", text: "Start a cancelable task." }],
    }));
    assert.equal(started.summary.continuation?.task?.status, "working");
    assert.equal(started.summary.continuation?.task?.can_cancel, true);

    const continuation = started.summary.continuation;
    assert.ok(continuation);

    const canceled = success(await service.execute({
      action: "cancel",
      continuation,
    }));
    assert.equal(canceled.summary.continuation?.task?.status, "canceled");
    assert.equal(canceled.summary.continuation?.task?.can_cancel, false);
  } finally {
    await peer.close();
  }
});
