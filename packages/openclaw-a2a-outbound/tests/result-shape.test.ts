import test from "node:test";
import assert from "node:assert/strict";
import {
  listTargetsSuccess,
  sendSuccess,
  statusSuccess,
  streamUpdate,
} from "../dist/result-shape.js";
import type { ResolvedTarget } from "../dist/sdk-client-pool.js";
import type { TargetCatalogEntry } from "../dist/target-catalog.js";

function target(): ResolvedTarget {
  return {
    alias: "support",
    baseUrl: "https://support.example/",
    cardPath: "/.well-known/agent-card.json",
    preferredTransports: ["JSONRPC", "HTTP+JSON"],
  };
}

test("sendSuccess exposes context_id for raw messages and fallback task context", () => {
  const result = sendSuccess(
    target(),
    {
      kind: "message",
      messageId: "message-1",
      role: "agent",
      contextId: "context-1",
      parts: [{ kind: "text", text: "continued" }],
    },
    {
      taskId: "task-1",
      taskHandle: "rah_123",
    },
  );

  assert.equal(result.summary.task_id, "task-1");
  assert.equal(result.summary.task_handle, "rah_123");
  assert.equal(result.summary.context_id, "context-1");
});

test("statusSuccess exposes context_id for raw tasks", () => {
  const result = statusSuccess(
    target(),
    {
      kind: "task",
      id: "task-1",
      contextId: "context-1",
      status: {
        state: "completed",
      },
    },
    {
      taskHandle: "rah_123",
    },
  );

  assert.equal(result.summary.task_id, "task-1");
  assert.equal(result.summary.task_handle, "rah_123");
  assert.equal(result.summary.context_id, "context-1");
});

test("streamUpdate exposes context_id for status and artifact events", () => {
  const status = streamUpdate("watch", target(), {
    kind: "status-update",
    taskId: "task-1",
    contextId: "context-1",
    status: {
      state: "working",
    },
    final: false,
  });
  const artifact = streamUpdate("watch", target(), {
    kind: "artifact-update",
    taskId: "task-1",
    contextId: "context-1",
    artifact: {
      artifactId: "artifact-1",
      parts: [{ kind: "text", text: "partial" }],
    },
    append: false,
    lastChunk: false,
  });

  assert.equal(status.summary.context_id, "context-1");
  assert.equal(artifact.summary.context_id, "context-1");
  assert.deepEqual(artifact.summary.artifacts?.[0]?.parts, [
    { kind: "text", text: "partial" },
  ]);
});

test("listTargetsSuccess nests peer-card data under peer_card without flat capability mirrors", () => {
  const entry: TargetCatalogEntry = {
    target: {
      ...target(),
      displayName: "Support",
      description: "Configured description",
      streamingSupported: true,
    },
    configuredDescription: "Configured description",
    default: true,
    tags: ["ops"],
    examples: ["Escalate this incident"],
    card: {
      displayName: "Peer Support",
      description: "Remote peer card description",
      preferredTransport: "JSONRPC",
      additionalInterfaces: [
        {
          transport: "JSONRPC",
          url: "https://support.example/a2a/jsonrpc",
        },
        {
          transport: "HTTP+JSON",
          url: "https://support.example/a2a/rest",
        },
      ],
      capabilities: {
        streaming: true,
        pushNotifications: true,
        stateTransitionHistory: false,
        extensions: [{ uri: "https://example.com/extensions/audit" }],
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [
        {
          id: "triage",
          name: "Ticket Triage",
          description: "Routes tickets",
          tags: ["support"],
          examples: ["Route this ticket"],
          inputModes: ["application/json"],
          outputModes: ["application/pdf"],
        },
      ],
      lastRefreshedAt: "2026-03-12T10:00:00.000Z",
    },
  };

  const result = listTargetsSuccess([entry]);
  const summaryEntry = result.summary.targets?.[0];
  const rawEntry = result.raw[0];

  assert.ok(summaryEntry);
  assert.ok(rawEntry);
  assert.equal("streaming_supported" in (summaryEntry as Record<string, unknown>), false);
  assert.equal("preferred_transport" in (summaryEntry as Record<string, unknown>), false);
  assert.deepEqual(summaryEntry?.peer_card, {
    preferred_transport: "JSONRPC",
    additional_interfaces: [
      {
        transport: "JSONRPC",
        url: "https://support.example/a2a/jsonrpc",
      },
      {
        transport: "HTTP+JSON",
        url: "https://support.example/a2a/rest",
      },
    ],
    capabilities: {
      streaming: true,
      push_notifications: true,
      state_transition_history: false,
      extensions: [{ uri: "https://example.com/extensions/audit" }],
    },
    default_input_modes: ["text/plain"],
    default_output_modes: ["text/plain"],
    skills: [
      {
        id: "triage",
        name: "Ticket Triage",
        description: "Routes tickets",
        tags: ["support"],
        examples: ["Route this ticket"],
        input_modes: ["application/json"],
        output_modes: ["application/pdf"],
      },
    ],
  });
  assert.deepEqual(rawEntry.card.additionalInterfaces, [
    {
      transport: "JSONRPC",
      url: "https://support.example/a2a/jsonrpc",
    },
    {
      transport: "HTTP+JSON",
      url: "https://support.example/a2a/rest",
    },
  ]);
  assert.deepEqual(rawEntry.card.capabilities, {
    streaming: true,
    pushNotifications: true,
    stateTransitionHistory: false,
    extensions: [{ uri: "https://example.com/extensions/audit" }],
  });
  assert.deepEqual(rawEntry.card.skills[0]?.inputModes, ["application/json"]);
  assert.deepEqual(rawEntry.card.skills[0]?.outputModes, ["application/pdf"]);
});
