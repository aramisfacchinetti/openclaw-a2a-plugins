import test from "node:test";
import assert from "node:assert/strict";
import {
  listTargetsSuccess,
  sendSuccess,
  statusSuccess,
  streamUpdate,
  type TargetListPeerCardSummary,
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

function streamingTarget(): ResolvedTarget {
  return {
    ...target(),
    streamingSupported: true,
  };
}

function peerCardSummaryFromRaw(
  entry: TargetCatalogEntry,
): TargetListPeerCardSummary {
  return {
    ...(entry.card.preferredTransport !== undefined
      ? { preferred_transport: entry.card.preferredTransport }
      : {}),
    additional_interfaces: entry.card.additionalInterfaces.map((cardInterface) => ({
      transport: cardInterface.transport,
      url: cardInterface.url,
    })),
    capabilities: {
      ...(typeof entry.card.capabilities.streaming === "boolean"
        ? { streaming: entry.card.capabilities.streaming }
        : {}),
      ...(typeof entry.card.capabilities.pushNotifications === "boolean"
        ? { push_notifications: entry.card.capabilities.pushNotifications }
        : {}),
      ...(typeof entry.card.capabilities.stateTransitionHistory === "boolean"
        ? {
            state_transition_history:
              entry.card.capabilities.stateTransitionHistory,
          }
        : {}),
      ...(entry.card.capabilities.extensions !== undefined
        ? {
            extensions: entry.card.capabilities.extensions.map((extension) =>
              structuredClone(extension),
            ),
          }
        : {}),
    },
    default_input_modes: [...entry.card.defaultInputModes],
    default_output_modes: [...entry.card.defaultOutputModes],
    skills: entry.card.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [...skill.tags],
      examples: [...skill.examples],
      ...(skill.inputModes !== undefined
        ? { input_modes: [...skill.inputModes] }
        : {}),
      ...(skill.outputModes !== undefined
        ? { output_modes: [...skill.outputModes] }
        : {}),
    })),
  };
}

test("sendSuccess exposes only conversation continuation for context-only message replies", () => {
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

  assert.equal(result.summary.response_kind, "message");
  assert.deepEqual(result.summary.continuation, {
    conversation: {
      context_id: "context-1",
      can_send: true,
    },
  });
});

test("sendSuccess preserves task continuation when a message payload includes taskId", () => {
  const result = sendSuccess(
    target(),
    {
      kind: "message",
      messageId: "message-1",
      role: "agent",
      taskId: "task-1",
      contextId: "context-1",
      parts: [{ kind: "text", text: "continued" }],
    },
    {
      taskId: "task-1",
      taskHandle: "rah_123",
    },
  );

  assert.equal(result.summary.response_kind, "message");
  assert.deepEqual(result.summary.continuation, {
    task: {
      task_handle: "rah_123",
      task_id: "task-1",
      can_resume_send: true,
      can_send: true,
      can_status: true,
      can_cancel: true,
      can_watch: false,
    },
    conversation: {
      context_id: "context-1",
      can_send: true,
    },
  });
});

test("statusSuccess exposes nested task and conversation continuations for raw tasks", () => {
  const result = statusSuccess(
    streamingTarget(),
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

  assert.equal(result.summary.response_kind, "task");
  assert.deepEqual(result.summary.continuation, {
    task: {
      task_handle: "rah_123",
      task_id: "task-1",
      status: "completed",
      can_resume_send: false,
      can_send: false,
      can_status: true,
      can_cancel: false,
      can_watch: false,
    },
    conversation: {
      context_id: "context-1",
      can_send: true,
    },
  });
});

test("streamUpdate exposes nested continuations for status and artifact events", () => {
  const status = streamUpdate("watch", streamingTarget(), {
    kind: "status-update",
    taskId: "task-1",
    contextId: "context-1",
    status: {
      state: "working",
    },
    final: false,
  });
  const artifact = streamUpdate("watch", streamingTarget(), {
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

  assert.equal(status.summary.response_kind, "task");
  assert.deepEqual(status.summary.continuation, {
    task: {
      task_id: "task-1",
      status: "working",
      can_resume_send: true,
      can_send: true,
      can_status: true,
      can_cancel: true,
      can_watch: true,
    },
    conversation: {
      context_id: "context-1",
      can_send: true,
    },
  });
  assert.deepEqual(artifact.summary.continuation, {
    task: {
      task_id: "task-1",
      can_resume_send: true,
      can_send: true,
      can_status: true,
      can_cancel: true,
      can_watch: false,
    },
    conversation: {
      context_id: "context-1",
      can_send: true,
    },
  });
  assert.deepEqual(artifact.summary.artifacts?.[0]?.parts, [
    { kind: "text", text: "partial" },
  ]);
});

test("streamUpdate summarizes accumulated task state instead of only the final event", () => {
  const update = streamUpdate("send", streamingTarget(), [
    {
      kind: "task",
      id: "task-1",
      contextId: "context-1",
      status: {
        state: "submitted",
      },
    },
    {
      kind: "artifact-update",
      taskId: "task-1",
      contextId: "context-1",
      artifact: {
        artifactId: "artifact-1",
        parts: [{ kind: "text", text: "partial reply" }],
      },
      append: false,
      lastChunk: false,
    },
    {
      kind: "status-update",
      taskId: "task-1",
      contextId: "context-1",
      status: {
        state: "completed",
      },
      final: true,
    },
  ]);

  assert.equal(update.summary.response_kind, "task");
  assert.equal(update.summary.message_text, "partial reply");
  assert.deepEqual(update.summary.continuation?.task, {
    task_id: "task-1",
    status: "completed",
    can_resume_send: false,
    can_send: false,
    can_status: true,
    can_cancel: false,
    can_watch: false,
  });
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
  assert.equal(
    "streaming_supported" in (summaryEntry as unknown as Record<string, unknown>),
    false,
  );
  assert.equal(
    "preferred_transport" in (summaryEntry as unknown as Record<string, unknown>),
    false,
  );
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
  assert.deepEqual(summaryEntry?.peer_card, peerCardSummaryFromRaw(rawEntry));
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
  assert.deepEqual(rawEntry.card.defaultInputModes, ["text/plain"]);
  assert.deepEqual(rawEntry.card.defaultOutputModes, ["text/plain"]);
  assert.deepEqual(rawEntry.card.skills[0]?.inputModes, ["application/json"]);
  assert.deepEqual(rawEntry.card.skills[0]?.outputModes, ["application/pdf"]);
});
