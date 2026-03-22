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
    reference_task_ids: ["task-0"],
    task_requirement: "required",
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
  assert.deepEqual(out.reference_task_ids, ["task-0"]);
  assert.equal(out.task_requirement, "required");
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

test("createRemoteAgentInputValidator accepts task_id with reference_task_ids", () => {
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
    task_id: "task-1",
    reference_task_ids: ["task-2", "task-3"],
    parts: [{ kind: "text", text: "continue with references" }],
  });

  assert.equal(out.action, "send");
  assert.equal(out.task_id, "task-1");
  assert.deepEqual(out.reference_task_ids, ["task-2", "task-3"]);
});

test("createRemoteAgentInputValidator accepts send with task_handle", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
  });
  const validate = createRemoteAgentInputValidator(config);

  const out = validate({
    action: "send",
    task_handle: "rah_abc123",
    parts: [{ kind: "text", text: "continue" }],
  });

  assert.equal(out.action, "send");
  assert.equal(out.task_handle, "rah_abc123");
});

test("createRemoteAgentInputValidator accepts nested continuation for send and follow-up actions", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
  });
  const validate = createRemoteAgentInputValidator(config);
  const continuation = {
    target: {
      target_url: "https://support.example/",
      card_path: "/.well-known/agent-card.json",
      preferred_transports: ["JSONRPC", "HTTP+JSON"],
      target_alias: "support",
    },
    task: {
      task_handle: "rah_abc123",
      task_id: "task-1",
    },
    conversation: {
      context_id: "context-1",
      can_send: true,
    },
  } as const;

  assert.deepEqual(
    validate({
      action: "send",
      continuation,
      parts: [{ kind: "text", text: "continue" }],
    }).continuation,
    continuation,
  );
  assert.deepEqual(
    validate({
      action: "status",
      continuation,
    }).continuation,
    continuation,
  );
  assert.deepEqual(
    validate({
      action: "watch",
      continuation,
    }).continuation,
    continuation,
  );
  assert.deepEqual(
    validate({
      action: "cancel",
      continuation,
    }).continuation,
    continuation,
  );
});

test("createRemoteAgentInputValidator rejects follow-up continuation with only conversation continuity", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
  });
  const validate = createRemoteAgentInputValidator(config);

  for (const action of ["status", "watch", "cancel"] as const) {
    assert.throws(
      () =>
        validate({
          action,
          continuation: {
            target: {
              target_url: "https://support.example/",
              card_path: "/.well-known/agent-card.json",
              preferred_transports: ["JSONRPC", "HTTP+JSON"],
            },
            conversation: {
              context_id: "context-1",
              can_send: true,
            },
          },
        }),
      (error: unknown) =>
        isValidationError(error) &&
        hasAjvError(
          error,
          (entry) =>
            entry.keyword === "required" &&
            String(entry.message).includes("continuation.task.task_id"),
        ),
    );
  }
});

test("createRemoteAgentInputValidator rejects flat context_id on lifecycle actions", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
  });
  const validate = createRemoteAgentInputValidator(config);

  for (const action of ["status", "watch", "cancel"] as const) {
    assert.throws(
      () =>
        validate({
          action,
          target_url: "https://support.example/",
          context_id: "context-1",
          task_id: "task-1",
        }),
      (error: unknown) =>
        isValidationError(error) &&
        hasAjvError(
          error,
          (entry) =>
            entry.keyword === "not" &&
            entry.instancePath === "" &&
            String(entry.message).includes('"context_id" is not supported'),
        ),
    );
  }
});

test("createRemoteAgentInputValidator rejects mixed flat and nested continuation routing", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
  });
  const validate = createRemoteAgentInputValidator(config);

  assert.throws(
    () =>
      validate({
        action: "send",
        continuation: {
          target: {
            target_url: "https://support.example/",
            card_path: "/.well-known/agent-card.json",
            preferred_transports: ["JSONRPC", "HTTP+JSON"],
          },
          task: {
            task_id: "task-1",
          },
        },
        task_id: "task-1",
        parts: [{ kind: "text", text: "continue" }],
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (entry) =>
          entry.keyword === "not" &&
          String(entry.message).includes("does not allow"),
      ),
  );
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

test("createRemoteAgentInputValidator rejects send with task_id and no target when no default target exists", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
  });
  const validate = createRemoteAgentInputValidator(config);

  assert.throws(
    () =>
      validate({
        action: "send",
        parts: [{ kind: "text", text: "hello" }],
        task_id: "task-1",
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

test("createRemoteAgentInputValidator rejects context-only send with no target when no default target exists", () => {
  const config = parseA2AOutboundPluginConfig({
    enabled: true,
  });
  const validate = createRemoteAgentInputValidator(config);

  assert.throws(
    () =>
      validate({
        action: "send",
        parts: [{ kind: "text", text: "hello" }],
        context_id: "context-1",
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
