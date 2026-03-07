import type { Message, MessageSendParams } from "@a2a-js/sdk";
import { ALL_TRANSPORTS, type A2ATransport } from "./constants.js";
import { createA2AOutboundAjv, toValidationError } from "./ajv-validator.js";

const MESSAGE_ROLES = ["user", "agent"] as const;

const TARGET_SCHEMA = {
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
};

const MESSAGE_PART_METADATA_SCHEMA = {
  type: "object",
  additionalProperties: true,
};

const TEXT_PART_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["text"] },
    text: { type: "string" },
    metadata: MESSAGE_PART_METADATA_SCHEMA,
  },
  required: ["kind", "text"],
};

const FILE_PART_FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    uri: { type: "string", minLength: 1 },
    bytes: { type: "string", minLength: 1 },
    name: { type: "string" },
    mimeType: { type: "string" },
  },
  anyOf: [{ required: ["uri"] }, { required: ["bytes"] }],
};

const FILE_PART_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["file"] },
    file: FILE_PART_FILE_SCHEMA,
    metadata: MESSAGE_PART_METADATA_SCHEMA,
  },
  required: ["kind", "file"],
};

const DATA_PART_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["data"] },
    data: { type: "object", additionalProperties: true },
    metadata: MESSAGE_PART_METADATA_SCHEMA,
  },
  required: ["kind", "data"],
};

const MESSAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["message"] },
    messageId: { type: "string", minLength: 1 },
    role: { type: "string", enum: MESSAGE_ROLES },
    parts: {
      type: "array",
      items: {
        oneOf: [TEXT_PART_SCHEMA, FILE_PART_SCHEMA, DATA_PART_SCHEMA],
      },
    },
    contextId: { type: "string", minLength: 1 },
    taskId: { type: "string", minLength: 1 },
    extensions: {
      type: "array",
      items: { type: "string" },
    },
    referenceTaskIds: {
      type: "array",
      items: { type: "string" },
    },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["kind", "messageId", "role", "parts"],
};

export const DELEGATE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    target: TARGET_SCHEMA,
    request: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: {
          ...MESSAGE_SCHEMA,
          description:
            "A2A message payload passed as MessageSendParams.message.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description: "Optional timeout override for this operation.",
        },
        serviceParameters: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional service parameters for this operation.",
        },
        metadata: {
          type: "object",
          additionalProperties: true,
          description: "Optional MessageSendParams.metadata payload.",
        },
      },
      required: ["message"],
    },
  },
  required: ["target", "request"],
};

export const STATUS_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    target: TARGET_SCHEMA,
    request: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          minLength: 1,
          description: "Remote task id to query.",
        },
        historyLength: {
          type: "integer",
          minimum: 0,
          description: "Optional history window length.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description: "Optional timeout override for this operation.",
        },
        serviceParameters: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional service parameters for this operation.",
        },
      },
      required: ["taskId"],
    },
  },
  required: ["target", "request"],
};

export const CANCEL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    target: TARGET_SCHEMA,
    request: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          minLength: 1,
          description: "Remote task id to cancel.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description: "Optional timeout override for this operation.",
        },
        serviceParameters: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional service parameters for this operation.",
        },
      },
      required: ["taskId"],
    },
  },
  required: ["target", "request"],
};

export type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
};

export const TOOL_DEFINITIONS = {
  a2a_delegate: {
    name: "a2a_delegate",
    label: "A2A Delegate",
    description: "Delegate a request to an external A2A agent.",
    parameters: DELEGATE_INPUT_SCHEMA,
  },
  a2a_task_status: {
    name: "a2a_task_status",
    label: "A2A Task Status",
    description: "Fetch status for an external A2A task.",
    parameters: STATUS_INPUT_SCHEMA,
  },
  a2a_task_cancel: {
    name: "a2a_task_cancel",
    label: "A2A Task Cancel",
    description: "Request cancellation for an external A2A task.",
    parameters: CANCEL_INPUT_SCHEMA,
  },
} as const satisfies Record<string, ToolDefinition>;

export interface A2ATargetInput {
  baseUrl: string;
  cardPath?: string;
  preferredTransports?: A2ATransport[];
}

export interface DelegateRequestInput {
  message: Message;
  timeoutMs?: number;
  serviceParameters?: Record<string, string>;
  metadata?: MessageSendParams["metadata"];
}

export interface StatusRequestInput {
  taskId: string;
  historyLength?: number;
  timeoutMs?: number;
  serviceParameters?: Record<string, string>;
}

export interface CancelRequestInput {
  taskId: string;
  timeoutMs?: number;
  serviceParameters?: Record<string, string>;
}

export interface DelegateToolInput {
  target: A2ATargetInput;
  request: DelegateRequestInput;
}

export interface StatusToolInput {
  target: A2ATargetInput;
  request: StatusRequestInput;
}

export interface CancelToolInput {
  target: A2ATargetInput;
  request: CancelRequestInput;
}

const ajv = createA2AOutboundAjv();

const validateDelegateSchema = ajv.compile(DELEGATE_INPUT_SCHEMA);
const validateStatusSchema = ajv.compile(STATUS_INPUT_SCHEMA);
const validateCancelSchema = ajv.compile(CANCEL_INPUT_SCHEMA);

export function validateDelegateInput(input: unknown): DelegateToolInput {
  if (!validateDelegateSchema(input)) {
    toValidationError("a2a_delegate", [...validateDelegateSchema.errors!]);
  }
  return input as unknown as DelegateToolInput;
}

export function validateStatusInput(input: unknown): StatusToolInput {
  if (!validateStatusSchema(input)) {
    toValidationError("a2a_task_status", [...validateStatusSchema.errors!]);
  }
  return input as unknown as StatusToolInput;
}

export function validateCancelInput(input: unknown): CancelToolInput {
  if (!validateCancelSchema(input)) {
    toValidationError("a2a_task_cancel", [...validateCancelSchema.errors!]);
  }
  return input as unknown as CancelToolInput;
}
