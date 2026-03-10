import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { A2AError } from "@a2a-js/sdk/server";
import type {
  Artifact,
  Message,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TextPart,
} from "@a2a-js/sdk";

export type JsonRecord = Record<string, unknown>;
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonRecord
  | JsonValue[];
type TaskState = Task["status"]["state"];
export type TaskLifecycleClass = "active" | "quiescent" | "terminal";
export type ToolProgressPhase = "start" | "update" | "result";

const TEXT_PLAIN_OUTPUT_MODE = "text/plain";
const OCTET_STREAM_OUTPUT_MODE = "application/octet-stream";
const FILE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

export interface NormalizedReplyPayload {
  text?: string;
  mediaUrls: string[];
  hasVendorContent: boolean;
}

export interface BuiltReplyContent {
  parts: Part[];
  availableOutputModes: string[];
  hasCandidates: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeJsonValue(value: unknown): JsonValue | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    const sanitizedItems = value.flatMap((item) => {
      const sanitized = sanitizeJsonValue(item);
      return typeof sanitized === "undefined" ? [] : [sanitized];
    });
    return sanitizedItems;
  }

  if (isRecord(value)) {
    const sanitized: JsonRecord = {};

    for (const [key, entry] of Object.entries(value)) {
      const nextValue = sanitizeJsonValue(entry);

      if (typeof nextValue !== "undefined") {
        sanitized[key] = nextValue;
      }
    }

    return sanitized;
  }

  return String(value);
}

function sanitizeJsonRecord(value: unknown): JsonRecord | undefined {
  const sanitized = sanitizeJsonValue(value);

  if (isRecord(sanitized)) {
    return sanitized;
  }

  if (typeof sanitized === "undefined") {
    return undefined;
  }

  return {
    value: sanitized,
  };
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readUriBasename(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    const name = basename(parsed.pathname);
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function inferMimeTypeFromUri(uri: string): string | undefined {
  const name = readUriBasename(uri);

  if (!name) {
    return undefined;
  }

  const extension = extname(name).toLowerCase();
  return FILE_MIME_BY_EXTENSION[extension];
}

function mergeMetadata(
  ...records: Array<JsonRecord | undefined>
): JsonRecord | undefined {
  const merged: JsonRecord = {};

  for (const record of records) {
    if (!record) {
      continue;
    }

    Object.assign(merged, record);
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function detectVendorReplyContent(value: JsonRecord): boolean {
  return Boolean(
    sanitizeJsonRecord(value.channelData) ||
      typeof value.isError === "boolean" ||
      typeof value.audioAsVoice === "boolean" ||
      readTrimmedString(value.replyToId) ||
      readTrimmedString(value.replyToTag) ||
      typeof value.replyToCurrent === "boolean",
  );
}

function normalizeMediaUrls(payload: JsonRecord): string[] {
  if (
    Array.isArray(payload.mediaUrls) &&
    payload.mediaUrls.every((item) => typeof item === "string")
  ) {
    return payload.mediaUrls
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  const mediaUrl = readTrimmedString(payload.mediaUrl);
  return mediaUrl ? [mediaUrl] : [];
}

function hasAllowedOutputMode(
  acceptedOutputModes: ReadonlySet<string>,
  mode: string,
): boolean {
  return acceptedOutputModes.has(mode);
}

export function normalizeOutputModes(
  value: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim().toLowerCase();

    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }

  return [...normalized];
}

export function createContentTypeNotSupportedError(params: {
  acceptedOutputModes: readonly string[];
  availableOutputModes: readonly string[];
}): A2AError {
  return new A2AError(
    -32005,
    "The response could not be represented in any accepted output mode.",
    {
      acceptedOutputModes: [...params.acceptedOutputModes],
      availableOutputModes: [...params.availableOutputModes],
    },
  );
}

export function collectReplyText(chunks: string[], payload: unknown): void {
  const normalized = normalizeReplyPayload(payload);

  if (!normalized.text) {
    return;
  }

  chunks.push(normalized.text);
}

export function summarizeBufferedReplies(
  chunks: readonly string[],
): string | undefined {
  const filtered = chunks.filter((chunk) => chunk.trim().length > 0);

  if (filtered.length === 0) {
    return undefined;
  }

  return filtered.join("\n\n");
}

export function normalizeReplyPayload(payload: unknown): NormalizedReplyPayload {
  if (!isRecord(payload)) {
    return {
      mediaUrls: [],
      hasVendorContent: false,
    };
  }

  const text =
    typeof payload.text === "string"
      ? payload.text
      : typeof payload.body === "string"
        ? payload.body
        : undefined;

  return {
    ...(text && text.trim().length > 0 ? { text } : {}),
    mediaUrls: normalizeMediaUrls(payload),
    hasVendorContent: detectVendorReplyContent(payload),
  };
}

export function buildReplyContent(params: {
  payload: NormalizedReplyPayload;
  acceptedOutputModes: readonly string[];
}): BuiltReplyContent {
  const acceptedOutputModes = new Set(
    normalizeOutputModes(params.acceptedOutputModes),
  );
  const availableOutputModes = new Set<string>();
  const parts: Part[] = [];

  if (params.payload.text) {
    availableOutputModes.add(TEXT_PLAIN_OUTPUT_MODE);

    if (hasAllowedOutputMode(acceptedOutputModes, TEXT_PLAIN_OUTPUT_MODE)) {
      const textPart: TextPart = {
        kind: "text",
        text: params.payload.text,
      };
      parts.push(textPart);
    }
  }

  for (const uri of params.payload.mediaUrls) {
    const mimeType = inferMimeTypeFromUri(uri);
    availableOutputModes.add(OCTET_STREAM_OUTPUT_MODE);

    if (mimeType) {
      availableOutputModes.add(mimeType);
    }
  }

  return {
    parts,
    availableOutputModes: [...availableOutputModes],
    hasCandidates:
      availableOutputModes.size > 0 || params.payload.hasVendorContent,
  };
}

export function createAgentMessage(params: {
  contextId: string;
  parts: Part[];
  taskId?: string;
  metadata?: JsonRecord;
}): Message {
  return {
    kind: "message",
    messageId: randomUUID(),
    role: "agent",
    parts: structuredClone(params.parts),
    ...(params.metadata ? { metadata: structuredClone(params.metadata) } : {}),
    contextId: params.contextId,
    taskId: params.taskId,
  };
}

export function createAgentTextMessage(params: {
  contextId: string;
  text: string;
  taskId?: string;
}): Message {
  return createAgentMessage({
    contextId: params.contextId,
    taskId: params.taskId,
    parts: [{ kind: "text", text: params.text }],
  });
}

export function createTaskSnapshot(params: {
  taskId: string;
  contextId: string;
  state: TaskState;
  history?: Message[];
  artifacts?: Artifact[];
  metadata?: JsonRecord;
  message?: Message;
  messageText?: string;
  timestamp?: string;
}): Task {
  return {
    kind: "task",
    id: params.taskId,
    contextId: params.contextId,
    history: params.history,
    artifacts: params.artifacts,
    metadata: params.metadata,
    status: createTaskStatus({
      contextId: params.contextId,
      taskId: params.taskId,
      state: params.state,
      message: params.message,
      messageText: params.messageText,
      timestamp: params.timestamp,
    }),
  };
}

export function createTaskStatusUpdate(params: {
  taskId: string;
  contextId: string;
  state: TaskState;
  final?: boolean;
  message?: Message;
  messageText?: string;
  timestamp?: string;
  metadata?: JsonRecord;
}): TaskStatusUpdateEvent {
  return {
    kind: "status-update",
    taskId: params.taskId,
    contextId: params.contextId,
    final: params.final === true,
    metadata: params.metadata,
    status: createTaskStatus(params),
  };
}

export function createArtifactUpdate(params: {
  taskId: string;
  contextId: string;
  artifactId: string;
  name?: string;
  description?: string;
  parts?: Part[];
  text?: string;
  data?: JsonRecord;
  metadata?: JsonRecord;
  append?: boolean;
  lastChunk?: boolean;
}): TaskArtifactUpdateEvent {
  const parts =
    params.parts ??
    (() => {
      const nextParts: Part[] = [];

      if (typeof params.text === "string" && params.text.length > 0) {
        nextParts.push({ kind: "text", text: params.text });
      }

      if (params.data) {
        nextParts.push({ kind: "data", data: params.data });
      }

      return nextParts;
    })();

  return {
    kind: "artifact-update",
    taskId: params.taskId,
    contextId: params.contextId,
    append: params.append,
    lastChunk: params.lastChunk,
    artifact: {
      artifactId: params.artifactId,
      name: params.name,
      description: params.description,
      metadata: params.metadata,
      parts,
    },
  };
}

export function createReplyArtifactUpdate(params: {
  taskId: string;
  contextId: string;
  artifactId: string;
  name: string;
  sequence: number;
  content: BuiltReplyContent;
  append?: boolean;
  lastChunk?: boolean;
}): TaskArtifactUpdateEvent {
  return createArtifactUpdate({
    taskId: params.taskId,
    contextId: params.contextId,
    artifactId: params.artifactId,
    name: params.name,
    parts: params.content.parts,
    metadata: mergeMetadata({
      sequence: params.sequence,
      source: params.name,
    }),
    append: params.append,
    lastChunk: params.lastChunk,
  });
}

export function sanitizeToolCallId(toolCallId: string): string {
  return toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function createToolProgressArtifactUpdate(params: {
  taskId: string;
  contextId: string;
  toolName: string;
  toolCallId: string;
  phase: ToolProgressPhase;
  payload: unknown;
  sequence: number;
  isError?: boolean;
}): TaskArtifactUpdateEvent {
  const text =
    params.phase === "start"
      ? `Started tool ${params.toolName}`
      : params.phase === "update"
        ? `Updated tool ${params.toolName}`
        : params.isError
          ? `Tool ${params.toolName} failed`
          : `Completed tool ${params.toolName}`;

  return createArtifactUpdate({
    taskId: params.taskId,
    contextId: params.contextId,
    artifactId: `tool-progress-${sanitizeToolCallId(params.toolCallId)}`,
    name: `${params.toolName} progress`,
    text,
    data: sanitizeJsonRecord(params.payload) ?? {},
    metadata: {
      source: "tool",
      phase: params.phase,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      sequence: params.sequence,
    },
    lastChunk: params.phase === "result",
  });
}

export function isTerminalTaskState(state: TaskState): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "canceled" ||
    state === "rejected"
  );
}

export function isQuiescentTaskState(state: TaskState): boolean {
  return state === "input-required" || state === "auth-required";
}

export function isActiveExecutionTaskState(state: TaskState): boolean {
  return state === "submitted" || state === "working";
}

export function classifyTaskState(state: TaskState): TaskLifecycleClass {
  if (isActiveExecutionTaskState(state)) {
    return "active";
  }

  if (isTerminalTaskState(state)) {
    return "terminal";
  }

  return "quiescent";
}

function createTaskStatus(params: {
  contextId: string;
  taskId: string;
  state: TaskState;
  message?: Message;
  messageText?: string;
  timestamp?: string;
}): Task["status"] {
  return {
    state: params.state,
    timestamp: params.timestamp ?? new Date().toISOString(),
    message:
      params.message ??
      (params.messageText
        ? createAgentTextMessage({
            contextId: params.contextId,
            taskId: params.taskId,
            text: params.messageText,
          })
        : undefined),
  };
}
