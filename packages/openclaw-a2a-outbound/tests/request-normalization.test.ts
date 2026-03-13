import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRequestOptions,
  normalizeSendRequest,
  normalizeStrictTaskCreationSendRequest,
} from "../dist/request-normalization.js";

test("normalizeSendRequest generates user message ids when omitted", () => {
  const first = normalizeSendRequest(
    {
      action: "send",
      parts: [{ kind: "text", text: "hello world" }],
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
      defaultAcceptedOutputModes: ["text/plain"],
    },
  );
  const second = normalizeSendRequest(
    {
      action: "send",
      parts: [{ kind: "text", text: "hello again" }],
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
      defaultAcceptedOutputModes: ["text/plain"],
    },
  );

  assert.equal(first.sendParams.message.kind, "message");
  assert.equal(first.sendParams.message.role, "user");
  assert.deepEqual(first.sendParams.message.parts, [
    {
      kind: "text",
      text: "hello world",
    },
  ]);
  assert.deepEqual(first.sendParams.configuration, {
    acceptedOutputModes: ["text/plain"],
  });
  assert.notEqual(
    first.sendParams.message.messageId,
    second.sendParams.message.messageId,
  );
});

test("normalizeSendRequest forwards data-only parts verbatim", () => {
  const normalized = normalizeSendRequest(
    {
      action: "send",
      parts: [
        {
          kind: "data",
          data: {
            ticket: "123",
            priority: "high",
          },
          metadata: {
            source: "triage",
          },
        },
      ],
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
      defaultAcceptedOutputModes: [],
    },
  );

  assert.deepEqual(normalized.sendParams.message.parts, [
    {
      kind: "data",
      data: {
        ticket: "123",
        priority: "high",
      },
      metadata: {
        source: "triage",
      },
    },
  ]);
});

test("normalizeSendRequest forwards file-only parts with key translation", () => {
  const normalized = normalizeSendRequest(
    {
      action: "send",
      parts: [
        {
          kind: "file",
          bytes: "Zm9v",
          name: "inline.txt",
          mime_type: "text/plain",
          metadata: {
            source: "inline",
          },
        },
      ],
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
      defaultAcceptedOutputModes: [],
    },
  );

  assert.deepEqual(normalized.sendParams.message.parts, [
    {
      kind: "file",
      file: {
        bytes: "Zm9v",
        name: "inline.txt",
        mimeType: "text/plain",
      },
      metadata: {
        source: "inline",
      },
    },
  ]);
});

test("normalizeSendRequest forwards mixed parts exactly", () => {
  const normalized = normalizeSendRequest(
    {
      action: "send",
      parts: [
        {
          kind: "text",
          text: "process these",
          metadata: {
            emphasis: "high",
          },
        },
        {
          kind: "file",
          uri: "https://example.com/report.pdf",
          name: "report.pdf",
          mime_type: "application/pdf",
        },
        {
          kind: "data",
          data: {
            ticket: "123",
          },
        },
      ],
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
      defaultAcceptedOutputModes: [],
    },
  );

  assert.deepEqual(normalized.sendParams.message.parts, [
    {
      kind: "text",
      text: "process these",
      metadata: {
        emphasis: "high",
      },
    },
    {
      kind: "file",
      file: {
        uri: "https://example.com/report.pdf",
        name: "report.pdf",
        mimeType: "application/pdf",
      },
    },
    {
      kind: "data",
      data: {
        ticket: "123",
      },
    },
  ]);
});

test("normalizeSendRequest maps ids and per-call configuration fields", () => {
  const normalized = normalizeSendRequest(
    {
      action: "send",
      message_id: "message-1",
      task_id: "task-1",
      context_id: "context-1",
      reference_task_ids: ["task-0", "task-9"],
      parts: [{ kind: "text", text: "hello" }],
      accepted_output_modes: ["application/json"],
      blocking: false,
      history_length: 4,
      push_notification_config: {
        url: "https://example.com/callback",
        id: "push-1",
        token: "token-1",
        authentication: {
          schemes: ["Bearer"],
          credentials: "secret",
        },
      },
      metadata: {
        requestId: "req-1",
      },
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
      defaultAcceptedOutputModes: ["text/plain"],
    },
  );

  assert.equal(normalized.sendParams.message.messageId, "message-1");
  assert.equal(normalized.sendParams.message.taskId, "task-1");
  assert.equal(normalized.sendParams.message.contextId, "context-1");
  assert.deepEqual(normalized.sendParams.message.referenceTaskIds, [
    "task-0",
    "task-9",
  ]);
  assert.deepEqual(normalized.sendParams.metadata, {
    requestId: "req-1",
  });
  assert.deepEqual(normalized.sendParams.configuration, {
    acceptedOutputModes: ["application/json"],
    blocking: false,
    historyLength: 4,
    pushNotificationConfig: {
      url: "https://example.com/callback",
      id: "push-1",
      token: "token-1",
      authentication: {
        schemes: ["Bearer"],
        credentials: "secret",
      },
    },
  });
});

test("normalizeSendRequest still generates a fresh message id for continuation sends", () => {
  const first = normalizeSendRequest(
    {
      action: "send",
      task_id: "task-1",
      context_id: "context-1",
      parts: [{ kind: "text", text: "first follow-up" }],
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
      defaultAcceptedOutputModes: [],
    },
  );
  const second = normalizeSendRequest(
    {
      action: "send",
      task_id: "task-1",
      context_id: "context-1",
      parts: [{ kind: "text", text: "second follow-up" }],
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
      defaultAcceptedOutputModes: [],
    },
  );

  assert.equal(first.sendParams.message.taskId, "task-1");
  assert.equal(first.sendParams.message.contextId, "context-1");
  assert.equal(second.sendParams.message.taskId, "task-1");
  assert.equal(second.sendParams.message.contextId, "context-1");
  assert.notEqual(
    first.sendParams.message.messageId,
    second.sendParams.message.messageId,
  );
});

test("normalizeSendRequest applies plugin default accepted output modes only when omitted", () => {
  const inherited = normalizeSendRequest(
    {
      action: "send",
      parts: [{ kind: "text", text: "default modes" }],
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
      defaultAcceptedOutputModes: ["text/plain", "application/json"],
    },
  );
  const overridden = normalizeSendRequest(
    {
      action: "send",
      parts: [{ kind: "text", text: "override modes" }],
      accepted_output_modes: [],
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
      defaultAcceptedOutputModes: ["text/plain", "application/json"],
    },
  );

  assert.deepEqual(inherited.sendParams.configuration, {
    acceptedOutputModes: ["text/plain", "application/json"],
  });
  assert.deepEqual(overridden.sendParams.configuration, {
    acceptedOutputModes: [],
  });
});

test("normalizeStrictTaskCreationSendRequest forces explicit non-blocking task creation", () => {
  const normalized = normalizeStrictTaskCreationSendRequest(
    {
      action: "send",
      parts: [{ kind: "text", text: "require a task" }],
      blocking: true,
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
      defaultAcceptedOutputModes: ["text/plain"],
    },
  );

  assert.deepEqual(normalized.sendParams.configuration, {
    acceptedOutputModes: ["text/plain"],
    blocking: false,
  });
});

test("buildRequestOptions merges default and per-call service parameters", () => {
  const controller = new AbortController();
  const options = buildRequestOptions(
    500,
    250,
    {
      "X-From-Default": "default",
      "X-Shared": "default",
    },
    {
      "X-From-Input": "input",
      "X-Shared": "override",
    },
    controller.signal,
  );

  assert.deepEqual(options.serviceParameters, {
    "X-From-Default": "default",
    "X-From-Input": "input",
    "X-Shared": "override",
  });
  assert.ok(options.signal instanceof AbortSignal);
});
