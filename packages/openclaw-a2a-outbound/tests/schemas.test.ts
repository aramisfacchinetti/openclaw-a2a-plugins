import test from "node:test";
import assert from "node:assert/strict";
import { parseA2AOutboundPluginConfig } from "../dist/config.js";
import {
  REMOTE_AGENT_ACTIONS,
  buildRemoteAgentToolDefinition,
  createRemoteAgentInputValidator,
} from "../dist/schemas.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "VALIDATION_ERROR"
  );
}

function ajvErrors(error: unknown): Array<Record<string, unknown>> {
  if (!isValidationError(error) || !isRecord(error) || !isRecord(error.details)) {
    return [];
  }

  if (!Array.isArray(error.details.errors)) {
    return [];
  }

  return error.details.errors.filter(isRecord);
}

function hasAjvError(
  error: unknown,
  predicate: (e: Record<string, unknown>) => boolean,
): boolean {
  return ajvErrors(error).some(predicate);
}

test("buildRemoteAgentToolDefinition exposes one tool schema with the full action enum", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
  });
  const tool = buildRemoteAgentToolDefinition(config);
  const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
  const action = properties.action as { enum: string[] };

  assert.equal(tool.name, "remote_agent");
  assert.deepEqual(action.enum, [...REMOTE_AGENT_ACTIONS]);
});

test("buildRemoteAgentToolDefinition injects configured aliases into target_alias", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
    targets: [
      {
        alias: "support",
        baseUrl: "https://support.example",
        default: true,
      },
      {
        alias: "billing",
        baseUrl: "https://billing.example",
      },
    ],
  });
  const tool = buildRemoteAgentToolDefinition(config);
  const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
  const targetAlias = properties.target_alias as { enum?: string[]; description?: string };

  assert.deepEqual(targetAlias.enum, ["support", "billing"]);
  assert.match(tool.description, /Configured targets: support, billing\./);
  assert.match(String(targetAlias.description), /default target "support"/i);
});

test("createRemoteAgentInputValidator accepts send parts and parity fields", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
    targets: [
      {
        alias: "support",
        baseUrl: "https://support.example",
        default: true,
      },
    ],
  });
  const validate = createRemoteAgentInputValidator(config);

  const out = validate({
    action: "send",
    parts: [
      {
        kind: "text",
        text: "hello",
      },
      {
        kind: "file",
        uri: "https://example.com/report.pdf",
        mime_type: "application/pdf",
      },
      {
        kind: "data",
        data: {
          ticket: "123",
        },
      },
    ],
    message_id: "message-1",
    task_id: "task-1",
    context_id: "context-1",
    accepted_output_modes: ["text/plain"],
    blocking: false,
    history_length: 3,
    metadata: {
      traceId: "trace-1",
    },
    push_notification_config: {
      url: "https://example.com/callback",
    },
  });

  assert.equal(out.action, "send");
  assert.equal(out.message_id, "message-1");
  assert.equal(out.task_id, "task-1");
  assert.equal(out.context_id, "context-1");
  assert.deepEqual(out.parts, [
    {
      kind: "text",
      text: "hello",
    },
    {
      kind: "file",
      uri: "https://example.com/report.pdf",
      mime_type: "application/pdf",
    },
    {
      kind: "data",
      data: {
        ticket: "123",
      },
    },
  ]);
  assert.deepEqual(out.accepted_output_modes, ["text/plain"]);
  assert.equal(out.blocking, false);
  assert.equal(out.history_length, 3);
});

test("createRemoteAgentInputValidator rejects send without a resolvable target", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
  });
  const validate = createRemoteAgentInputValidator(config);

  assert.throws(
    () =>
      validate({
        action: "send",
        parts: [{ kind: "text", text: "hello" }],
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (entry) =>
          entry.keyword === "anyOf" &&
          String(entry.message).includes("configured default target"),
      ),
  );
});

test("createRemoteAgentInputValidator rejects legacy send input and attachments", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
    targets: [
      {
        alias: "support",
        baseUrl: "https://support.example",
        default: true,
      },
    ],
  });
  const validate = createRemoteAgentInputValidator(config);

  assert.throws(
    () =>
      validate({
        action: "send",
        input: "hello",
        attachments: [
          {
            kind: "data",
            data: {
              ticket: "123",
            },
          },
        ],
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (entry) =>
          entry.keyword === "additionalProperties" &&
          ["input", "attachments"].includes(
            String(
              (
                entry.params as {
                  additionalProperty?: unknown;
                } | undefined
              )?.additionalProperty,
            ),
          ),
      ),
  );
});

test("createRemoteAgentInputValidator rejects empty send parts", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
    targets: [
      {
        alias: "support",
        baseUrl: "https://support.example",
        default: true,
      },
    ],
  });
  const validate = createRemoteAgentInputValidator(config);

  assert.throws(
    () =>
      validate({
        action: "send",
        parts: [],
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(error, (entry) => entry.keyword === "minItems"),
  );
});

test("createRemoteAgentInputValidator rejects malformed file parts without uri or bytes", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
    targets: [
      {
        alias: "support",
        baseUrl: "https://support.example",
        default: true,
      },
    ],
  });
  const validate = createRemoteAgentInputValidator(config);

  assert.throws(
    () =>
      validate({
        action: "send",
        parts: [
          {
            kind: "file",
            name: "report.pdf",
          },
        ],
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(error, (entry) => entry.keyword === "oneOf"),
  );
});

test("createRemoteAgentInputValidator rejects blocking when send follows updates", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
    targets: [
      {
        alias: "support",
        baseUrl: "https://support.example",
        default: true,
      },
    ],
  });
  const validate = createRemoteAgentInputValidator(config);

  assert.throws(
    () =>
      validate({
        action: "send",
        parts: [{ kind: "text", text: "hello" }],
        follow_updates: true,
        blocking: false,
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (entry) =>
          entry.keyword === "not" &&
          String(entry.message).includes("follow_updates=true"),
      ),
  );
});

test("createRemoteAgentInputValidator continues rejecting task_handle on send", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
    targets: [
      {
        alias: "support",
        baseUrl: "https://support.example",
        default: true,
      },
    ],
  });
  const validate = createRemoteAgentInputValidator(config);

  assert.throws(
    () =>
      validate({
        action: "send",
        parts: [{ kind: "text", text: "hello" }],
        task_handle: "rah_abc123",
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (entry) =>
          entry.keyword === "not" &&
          String(entry.message).includes("task_handle"),
      ),
  );
});

test("createRemoteAgentInputValidator rejects list_targets with extra fields", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
  });
  const validate = createRemoteAgentInputValidator(config);

  assert.throws(
    () =>
      validate({
        action: "list_targets",
        target_alias: "support",
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (entry) =>
          entry.keyword === "not" &&
          String(entry.message).includes("target_alias"),
      ),
  );
});

test("createRemoteAgentInputValidator rejects watch without task_handle or task_id", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
    targets: [
      {
        alias: "support",
        baseUrl: "https://support.example",
        default: true,
      },
    ],
  });
  const validate = createRemoteAgentInputValidator(config);

  assert.throws(
    () =>
      validate({
        action: "watch",
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (entry) =>
          entry.keyword === "anyOf" &&
          String(entry.message).includes("task_handle or task_id"),
      ),
  );
});

test("createRemoteAgentInputValidator accepts status with task_id and configured default target", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
    targets: [
      {
        alias: "support",
        baseUrl: "https://support.example",
        default: true,
      },
    ],
  });
  const validate = createRemoteAgentInputValidator(config);

  const out = validate({
    action: "status",
    task_id: "task-1",
    history_length: 2,
  });

  assert.equal(out.action, "status");
  assert.equal(out.task_id, "task-1");
  assert.equal(out.history_length, 2);
});
