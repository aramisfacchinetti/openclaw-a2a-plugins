import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRequestOptions,
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
  assert.deepEqual(first.sendParams.message.parts, [
    {
      kind: "text",
      text: "hello world",
    },
  ]);
  assert.notEqual(
    first.sendParams.message.messageId,
    second.sendParams.message.messageId,
  );
});

test("normalizePlainIntentRequest maps flattened file and data attachments", () => {
  const normalized = normalizePlainIntentRequest(
    {
      input: "process these",
      attachments: [
        {
          kind: "file",
          uri: "https://example.com/report.pdf",
          name: "report.pdf",
          mime_type: "application/pdf",
        },
        {
          kind: "file",
          bytes: "Zm9v",
          name: "inline.txt",
          mime_type: "text/plain",
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
      kind: "file",
      file: {
        bytes: "Zm9v",
        name: "inline.txt",
        mimeType: "text/plain",
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

test("normalizePlainIntentRequest maps metadata and history_length", () => {
  const normalized = normalizePlainIntentRequest(
    {
      input: "hello",
      history_length: 4,
      metadata: {
        requestId: "req-1",
      },
    },
    {
      defaultTimeoutMs: 250,
      defaultServiceParameters: {},
    },
  );

  assert.deepEqual(normalized.sendParams.metadata, {
    requestId: "req-1",
  });
  assert.deepEqual(normalized.sendParams.configuration, {
    historyLength: 4,
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
