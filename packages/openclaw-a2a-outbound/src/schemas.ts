import type { MessageSendParams } from "@a2a-js/sdk";
import { type A2AOutboundPluginConfig } from "./config.js";
import { ALL_TRANSPORTS, type A2ATransport } from "./constants.js";
import {
  createA2AOutboundAjv,
  toValidationError,
  type ErrorObject,
} from "./ajv-validator.js";

export const REMOTE_AGENT_TOOL_NAME = "remote_agent";
export const REMOTE_AGENT_ACTIONS = [
  "list_targets",
  "send",
  "watch",
  "status",
  "cancel",
] as const;

export type RemoteAgentAction = (typeof REMOTE_AGENT_ACTIONS)[number];
export const TASK_REQUIREMENTS = ["optional", "required"] as const;
export type TaskRequirement = (typeof TASK_REQUIREMENTS)[number];

const TASK_HANDLE_SCHEMA = {
  type: "string",
  minLength: 1,
  pattern: "^rah_[A-Za-z0-9-]+$",
  description:
    "Opaque task handle issued by this plugin. Handles are process-local and invalidated by restarts.",
} as const;

const PART_METADATA_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

const TEXT_PART_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["text"] },
    text: {
      type: "string",
      description: "Text content for the message part.",
    },
    metadata: PART_METADATA_SCHEMA,
  },
  required: ["kind", "text"],
} as const;

const FILE_PART_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["file"] },
    uri: {
      type: "string",
      minLength: 1,
      description: "Remote file URI for the attachment.",
    },
    bytes: {
      type: "string",
      minLength: 1,
      description: "Base64-encoded inline file content.",
    },
    name: {
      type: "string",
      minLength: 1,
      description: "Optional filename.",
    },
    mime_type: {
      type: "string",
      minLength: 1,
      description: "Optional MIME type.",
    },
    metadata: PART_METADATA_SCHEMA,
  },
  required: ["kind"],
  anyOf: [{ required: ["uri"] }, { required: ["bytes"] }],
} as const;

const DATA_PART_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["data"] },
    data: {
      type: "object",
      additionalProperties: true,
      description: "Structured attachment payload.",
    },
    metadata: PART_METADATA_SCHEMA,
  },
  required: ["kind", "data"],
} as const;

const PUSH_NOTIFICATION_AUTHENTICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemes: {
      type: "array",
      minItems: 1,
      items: {
        type: "string",
        minLength: 1,
      },
      description: "Supported authentication schemes for push callbacks.",
    },
    credentials: {
      type: "string",
      minLength: 1,
      description: "Optional credentials for the push callback endpoint.",
    },
  },
  required: ["schemes"],
} as const;

const PUSH_NOTIFICATION_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: {
      type: "string",
      minLength: 1,
      format: "uri",
      description: "Callback URL for task push notifications.",
    },
    id: {
      type: "string",
      minLength: 1,
      description: "Optional client-managed push notification config id.",
    },
    token: {
      type: "string",
      minLength: 1,
      description: "Optional validation token for incoming notifications.",
    },
    authentication: PUSH_NOTIFICATION_AUTHENTICATION_SCHEMA,
  },
  required: ["url"],
} as const;

export interface A2ATargetInput {
  baseUrl: string;
  cardPath?: string;
  preferredTransports?: A2ATransport[];
}

export interface RemoteAgentTextPartInput {
  kind: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteAgentFilePartInput {
  kind: "file";
  uri?: string;
  bytes?: string;
  name?: string;
  mime_type?: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteAgentDataPartInput {
  kind: "data";
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type RemoteAgentPartInput =
  | RemoteAgentTextPartInput
  | RemoteAgentFilePartInput
  | RemoteAgentDataPartInput;

export interface RemoteAgentPushNotificationAuthenticationInput {
  schemes: string[];
  credentials?: string;
}

export interface RemoteAgentPushNotificationConfigInput {
  url: string;
  id?: string;
  token?: string;
  authentication?: RemoteAgentPushNotificationAuthenticationInput;
}

interface RemoteAgentBaseInput {
  target_alias?: string;
  target_url?: string;
  task_handle?: string;
  task_id?: string;
  timeout_ms?: number;
  service_parameters?: Record<string, string>;
}

export interface ListTargetsActionInput {
  action: "list_targets";
}

export interface SendActionInput extends RemoteAgentBaseInput {
  action: "send";
  parts: [RemoteAgentPartInput, ...RemoteAgentPartInput[]];
  message_id?: string;
  context_id?: string;
  reference_task_ids?: string[];
  task_requirement?: TaskRequirement;
  follow_updates?: boolean;
  accepted_output_modes?: string[];
  blocking?: boolean;
  history_length?: number;
  metadata?: MessageSendParams["metadata"];
  push_notification_config?: RemoteAgentPushNotificationConfigInput;
}

export interface WatchActionInput extends RemoteAgentBaseInput {
  action: "watch";
}

export interface StatusActionInput extends RemoteAgentBaseInput {
  action: "status";
  history_length?: number;
}

export interface CancelActionInput extends RemoteAgentBaseInput {
  action: "cancel";
}

export type RemoteAgentToolInput =
  | ListTargetsActionInput
  | SendActionInput
  | WatchActionInput
  | StatusActionInput
  | CancelActionInput;

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}

type TargetResolutionSummary = {
  aliases: string[];
  configuredBaseUrls: Set<string>;
  hasDefaultTarget: boolean;
};

const ACTION_ALLOWED_FIELDS: Readonly<Record<RemoteAgentAction, Set<string>>> =
  Object.freeze({
    list_targets: new Set(["action"]),
    send: new Set([
      "action",
      "target_alias",
      "target_url",
      "task_handle",
      "parts",
      "message_id",
      "task_id",
      "context_id",
      "reference_task_ids",
      "task_requirement",
      "follow_updates",
      "accepted_output_modes",
      "blocking",
      "history_length",
      "timeout_ms",
      "service_parameters",
      "metadata",
      "push_notification_config",
    ]),
    watch: new Set([
      "action",
      "target_alias",
      "target_url",
      "task_handle",
      "task_id",
      "timeout_ms",
      "service_parameters",
    ]),
    status: new Set([
      "action",
      "target_alias",
      "target_url",
      "task_handle",
      "task_id",
      "history_length",
      "timeout_ms",
      "service_parameters",
    ]),
    cancel: new Set([
      "action",
      "target_alias",
      "target_url",
      "task_handle",
      "task_id",
      "timeout_ms",
      "service_parameters",
    ]),
  });

function normalizeConfiguredBaseUrl(
  baseUrl: string,
  config: A2AOutboundPluginConfig,
): string {
  return config.policy.normalizeBaseUrl ? new URL(baseUrl).toString() : baseUrl;
}

function summarizeTargets(
  config: A2AOutboundPluginConfig,
): TargetResolutionSummary {
  return {
    aliases: config.targets.map((target) => target.alias),
    configuredBaseUrls: new Set(
      config.targets.map((target) =>
        normalizeConfiguredBaseUrl(target.baseUrl, config),
      ),
    ),
    hasDefaultTarget: config.targets.some((target) => target.default),
  };
}

function configuredTargetSummaryText(config: A2AOutboundPluginConfig): string {
  const aliases = config.targets.map((target) => target.alias);
  const defaultTarget = config.targets.find((target) => target.default);

  if (aliases.length === 0) {
    return config.policy.allowTargetUrlOverride
      ? "No configured targets. Use target_url for explicit routing."
      : "No configured targets. Add a default target or enable target_url overrides to route send/status/watch/cancel actions.";
  }

  const configured = `Configured targets: ${aliases.join(", ")}.`;
  const defaultDescription = defaultTarget
    ? ` Default target: ${defaultTarget.alias}.`
    : " No default target is configured.";
  const urlPolicy = config.policy.allowTargetUrlOverride
    ? " Explicit target_url overrides are enabled."
    : " Explicit target_url values must match configured targets.";

  return `${configured}${defaultDescription}${urlPolicy}`;
}

function targetAliasSchema(
  config: A2AOutboundPluginConfig,
): Record<string, unknown> {
  const aliases = config.targets.map((target) => target.alias);
  const defaultTarget = config.targets.find((target) => target.default);

  return {
    type: "string",
    minLength: 1,
    ...(aliases.length > 0 ? { enum: aliases } : {}),
    description: defaultTarget
      ? `Configured target alias. When omitted, the default target "${defaultTarget.alias}" is used when the action allows it.`
      : "Configured target alias.",
  };
}

export function buildRemoteAgentParametersSchema(
  config: A2AOutboundPluginConfig,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: REMOTE_AGENT_ACTIONS,
        description:
          "Action to perform: list_targets, send, watch, status, or cancel.",
      },
      target_alias: targetAliasSchema(config),
      target_url: {
        type: "string",
        minLength: 1,
        format: "uri",
        pattern: "^https?://",
        description:
          "Explicit remote target base URL. When target URL overrides are disabled, the URL must match a configured target.",
      },
      parts: {
        type: "array",
        minItems: 1,
        description:
          "Message parts for action=send. Provide one or more text, file, or data parts.",
        items: {
          oneOf: [TEXT_PART_SCHEMA, FILE_PART_SCHEMA, DATA_PART_SCHEMA],
        },
      },
      task_handle: TASK_HANDLE_SCHEMA,
      message_id: {
        type: "string",
        minLength: 1,
        description:
          "Optional client-supplied message id for action=send. A UUID is generated when omitted.",
      },
      task_id: {
        type: "string",
        minLength: 1,
        description:
          "Remote task id. For action=send this continues an existing task; for watch/status/cancel it identifies the delegated task when no task_handle is available.",
      },
      context_id: {
        type: "string",
        minLength: 1,
        description:
          "Optional remote context id for action=send to continue an existing conversation context.",
      },
      reference_task_ids: {
        type: "array",
        minItems: 1,
        items: {
          type: "string",
          minLength: 1,
        },
        description:
          "Optional related remote task ids for action=send. References prior tasks without continuing them.",
      },
      task_requirement: {
        type: "string",
        enum: TASK_REQUIREMENTS,
        description:
          'Optional action=send durable-task contract. "optional" keeps protocol-faithful message-or-task behavior; "required" fails unless the peer creates a real task.',
      },
      follow_updates: {
        type: "boolean",
        description:
          "When true, action=send streams the initial send. It does not guarantee task creation unless task_requirement=required.",
      },
      accepted_output_modes: {
        type: "array",
        items: {
          type: "string",
          minLength: 1,
        },
        description:
          "Optional output MIME types for action=send. Overrides plugin policy.acceptedOutputModes for this call.",
      },
      blocking: {
        type: "boolean",
        description:
          "Optional action=send knob for message/send. Rejected when follow_updates=true.",
      },
      history_length: {
        type: "integer",
        minimum: 0,
        description:
          "Optional history window for action=send and action=status.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1,
        description: "Optional timeout override for the remote request.",
      },
      service_parameters: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Optional request service parameters.",
      },
      metadata: {
        type: "object",
        additionalProperties: true,
        description: "Optional metadata payload for action=send.",
      },
      push_notification_config: {
        ...PUSH_NOTIFICATION_CONFIG_SCHEMA,
        description:
          "Optional action=send push notification configuration forwarded to the remote agent.",
      },
    },
    required: ["action"],
  };
}

export function buildRemoteAgentToolDefinition(
  config: A2AOutboundPluginConfig,
): ToolDefinition {
  return {
    name: REMOTE_AGENT_TOOL_NAME,
    label: "Remote Agent",
    description: `Route requests to remote A2A agents and manage delegated tasks. ${configuredTargetSummaryText(config)}`,
    parameters: buildRemoteAgentParametersSchema(config),
  };
}

function makeError(
  instancePath: string,
  keyword: string,
  message: string,
  params: Record<string, unknown> = {},
): ErrorObject {
  return {
    instancePath,
    schemaPath: `#/runtime/${keyword}`,
    keyword,
    params,
    message,
  } as ErrorObject;
}

function disallowedFieldErrors(
  action: RemoteAgentAction,
  input: Record<string, unknown>,
): ErrorObject[] {
  const allowedFields = ACTION_ALLOWED_FIELDS[action];
  const errors: ErrorObject[] = [];

  for (const property of Object.keys(input)) {
    if (!allowedFields.has(property)) {
      errors.push(
        makeError(
          "",
          "not",
          `"${property}" is not supported for action=${action}`,
          {
            property,
            action,
          },
        ),
      );
    }
  }

  return errors;
}

function validateExplicitTargetFields(
  input: Pick<RemoteAgentBaseInput, "target_alias" | "target_url">,
  summary: TargetResolutionSummary,
  config: A2AOutboundPluginConfig,
): ErrorObject[] {
  const errors: ErrorObject[] = [];

  if (input.target_alias !== undefined && !summary.aliases.includes(input.target_alias)) {
    errors.push(
      makeError("/target_alias", "enum", "must match a configured target alias", {
        allowedValues: summary.aliases,
      }),
    );
  }

  if (input.target_url !== undefined) {
    const normalized = normalizeConfiguredBaseUrl(input.target_url, config);
    const isResolvable =
      config.policy.allowTargetUrlOverride ||
      summary.configuredBaseUrls.has(normalized);

    if (!isResolvable) {
      errors.push(
        makeError(
          "/target_url",
          "anyOf",
          "must resolve to a configured target or be allowed by policy",
          {
            allowTargetUrlOverride: config.policy.allowTargetUrlOverride,
            configuredTargetAliases: summary.aliases,
          },
        ),
      );
    }
  }

  return errors;
}

function validateSendInput(
  input: SendActionInput,
  summary: TargetResolutionSummary,
  config: A2AOutboundPluginConfig,
): ErrorObject[] {
  const errors = validateExplicitTargetFields(input, summary, config);

  if (input.parts === undefined) {
    errors.push(
      makeError("", "required", "send requires parts", {
        missingProperty: "parts",
      }),
    );
  }

  if (input.follow_updates === true && input.blocking !== undefined) {
    errors.push(
      makeError(
        "/blocking",
        "not",
        "send does not allow blocking when follow_updates=true",
      ),
    );
  }

  const hasExplicitTarget =
    input.target_alias !== undefined || input.target_url !== undefined;
  const hasTaskHandle = input.task_handle !== undefined;

  if (!hasTaskHandle && !hasExplicitTarget && !summary.hasDefaultTarget) {
    errors.push(
      makeError(
        "",
        "anyOf",
        "send requires target_alias, target_url, or a configured default target",
      ),
    );
  }

  return errors;
}

function validateFollowUpInput(
  input: WatchActionInput | StatusActionInput | CancelActionInput,
  summary: TargetResolutionSummary,
  config: A2AOutboundPluginConfig,
): ErrorObject[] {
  const errors = validateExplicitTargetFields(input, summary, config);
  const hasTaskHandle = input.task_handle !== undefined;
  const hasTaskId = input.task_id !== undefined;

  if (!hasTaskHandle && !hasTaskId) {
    errors.push(
      makeError(
        "",
        "anyOf",
        `${input.action} requires task_handle or task_id`,
      ),
    );
  }

  if (
    !hasTaskHandle &&
    hasTaskId &&
    input.target_alias === undefined &&
    input.target_url === undefined &&
    !summary.hasDefaultTarget
  ) {
    errors.push(
      makeError(
        "",
        "anyOf",
        `${input.action} requires target_alias, target_url, or a configured default target when task_id is used without task_handle`,
      ),
    );
  }

  return errors;
}

function validateActionSpecificRules(
  input: RemoteAgentToolInput,
  summary: TargetResolutionSummary,
  config: A2AOutboundPluginConfig,
): ErrorObject[] {
  const recordInput = input as unknown as Record<string, unknown>;
  const errors = disallowedFieldErrors(input.action, recordInput);

  switch (input.action) {
    case "list_targets":
      return errors;
    case "send":
      return [...errors, ...validateSendInput(input, summary, config)];
    case "watch":
    case "status":
    case "cancel":
      return [...errors, ...validateFollowUpInput(input, summary, config)];
  }
}

export type RemoteAgentInputValidator = (
  input: unknown,
) => RemoteAgentToolInput;

export function createRemoteAgentInputValidator(
  config: A2AOutboundPluginConfig,
): RemoteAgentInputValidator {
  const ajv = createA2AOutboundAjv();
  const schema = buildRemoteAgentParametersSchema(config);
  const validateSchema = ajv.compile(schema);
  const targetSummary = summarizeTargets(config);

  return (input: unknown): RemoteAgentToolInput => {
    if (!validateSchema(input)) {
      toValidationError(REMOTE_AGENT_TOOL_NAME, [...validateSchema.errors!]);
    }

    const validated = input as RemoteAgentToolInput;
    const customErrors = validateActionSpecificRules(
      validated,
      targetSummary,
      config,
    );

    if (customErrors.length > 0) {
      toValidationError(REMOTE_AGENT_TOOL_NAME, customErrors);
    }

    return validated;
  };
}

export const PUBLIC_TARGET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    baseUrl: {
      type: "string",
      minLength: 1,
      format: "uri",
      pattern: "^https?://",
      description: "Target agent base URL.",
    },
    cardPath: {
      type: "string",
      minLength: 1,
      description:
        "Optional override for the target agent-card path. Defaults from plugin config when omitted.",
    },
    preferredTransports: {
      type: "array",
      items: {
        type: "string",
        enum: ALL_TRANSPORTS,
      },
      description:
        "Optional transport preference override for this call. Defaults from plugin config when omitted.",
    },
  },
  required: ["baseUrl"],
} as const;
