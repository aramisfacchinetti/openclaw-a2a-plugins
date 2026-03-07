import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRequestOptions,
  normalizeLegacyDelegateRequest,
  normalizePlainIntentRequest,
} from "../dist/request-normalization.js";

test("normalizePlainIntentRequest builds a generated user message", () => {
  const first = normalizePlainIntentRequest(
    {
      input: "hello world",
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
    },
  );
  const second = normalizePlainIntentRequest(
    {
      input: "hello again",
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
    },
  );

  assert.equal(first.sendParams.message.kind, "message");
  assert.equal(first.sendParams.message.role, "user");
  assert.equal(first.sendParams.message.parts.length, 1);
  assert.deepEqual(first.sendParams.message.parts[0], {
    kind: "text",
    text: "hello world",
  });
  assert.notEqual(first.sendParams.message.messageId, second.sendParams.message.messageId);
});

test("normalizePlainIntentRequest maps file and data attachments into A2A parts", () => {
  const normalized = normalizePlainIntentRequest(
    {
      input: "process these",
      attachments: [
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
      ],
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
    },
  );

  assert.deepEqual(normalized.sendParams.message.parts, [
    {
      kind: "text",
      text: "process these",
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

test("normalizeLegacyDelegateRequest preserves raw SDK-native message passthrough", () => {
  const message = {
    kind: "message" as const,
    messageId: "msg-legacy-1",
    role: "agent" as const,
    contextId: "ctx-legacy-1",
    taskId: "task-legacy-1",
    extensions: ["urn:example:ext"],
    referenceTaskIds: ["task-legacy-0"],
    metadata: {
      source: "legacy",
    },
    parts: [
      {
        kind: "text" as const,
        text: "passthrough",
      },
      {
        kind: "data" as const,
        data: {
          ok: true,
        },
      },
    ],
  };
  const metadata = {
    requestId: "req-legacy-1",
  };
  const configuration = {
    blocking: true,
    acceptedOutputModes: ["application/json"],
  };

  const normalized = normalizeLegacyDelegateRequest(
    {
      message,
      metadata,
      configuration,
      timeoutMs: 700,
      serviceParameters: {
        "X-Input": "input",
      },
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {
        "X-Default": "default",
      },
    },
  );

  assert.deepEqual(normalized.sendParams, {
    message,
    metadata,
    configuration,
  });
  assert.deepEqual(normalized.requestOptions.serviceParameters, {
    "X-Default": "default",
    "X-Input": "input",
  });
});
