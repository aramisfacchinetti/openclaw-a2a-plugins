import { randomUUID } from "node:crypto";
import { A2AError } from "@a2a-js/sdk/server";
import type {
  Artifact,
  DataPart,
  FilePart,
  Message,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TextPart,
} from "@a2a-js/sdk";
import { inferMimeTypeFromUri, readUriBasename } from "./file-delivery.js";

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
const JSON_OUTPUT_MODE = "application/json";
const OCTET_STREAM_OUTPUT_MODE = "application/octet-stream";

export interface ReplyVendorMetadata {
  channelData?: JsonRecord;
  isError?: boolean;
  audioAsVoice?: boolean;
  replyToId?: string;
  replyToTag?: string;
  replyToCurrent?: boolean;
}

export interface NormalizedReplyPayload {
  text?: string;
  mediaUrls: string[];
  vendorMetadata?: ReplyVendorMetadata;
}

export interface BuiltReplyContent {
  parts: Part[];
  metadata?: JsonRecord;
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

function mergeMetadata(
  ...records: Array<JsonRecord | undefined>
): JsonRecord | undefined {
  const merged: JsonRecord = {};

  for (const record of records) {
    if (!record) {
      continue;
    }

    for (const [key, value] of Object.entries(record)) {
      if (
        key === "openclaw" &&
        isRecord(value) &&
        isRecord(merged.openclaw)
      ) {
        merged.openclaw = {
          ...(merged.openclaw as JsonRecord),
          ...value,
        };
        continue;
      }

      merged[key] = value;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function buildVendorMetadata(value: unknown): ReplyVendorMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const metadata: ReplyVendorMetadata = {};
  const replyToId = readTrimmedString(value.replyToId);
  const replyToTag = readTrimmedString(value.replyToTag);

  if ("channelData" in value) {
    const channelData = sanitizeJsonRecord(value.channelData);

    if (channelData) {
      metadata.channelData = channelData;
    }
  }

  if (typeof value.isError === "boolean") {
    metadata.isError = value.isError;
  }

  if (typeof value.audioAsVoice === "boolean") {
    metadata.audioAsVoice = value.audioAsVoice;
  }

  if (replyToId) {
    metadata.replyToId = replyToId;
  }

  if (replyToTag) {
    metadata.replyToTag = replyToTag;
  }

  if (typeof value.replyToCurrent === "boolean") {
    metadata.replyToCurrent = value.replyToCurrent;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function buildVendorReplyRecord(
  payload: NormalizedReplyPayload,
): JsonRecord | undefined {
  if (!payload.vendorMetadata) {
    return undefined;
  }

  const reply: JsonRecord = {};

  if (payload.vendorMetadata.channelData) {
    reply.channelData = structuredClone(payload.vendorMetadata.channelData);
  }

  if ("isError" in payload.vendorMetadata) {
    reply.isError = payload.vendorMetadata.isError === true;
  }

  if ("audioAsVoice" in payload.vendorMetadata) {
    reply.audioAsVoice = payload.vendorMetadata.audioAsVoice === true;
  }

  if (payload.vendorMetadata.replyToId) {
    reply.replyToId = payload.vendorMetadata.replyToId;
  }

  if (payload.vendorMetadata.replyToTag) {
    reply.replyToTag = payload.vendorMetadata.replyToTag;
  }

  if ("replyToCurrent" in payload.vendorMetadata) {
    reply.replyToCurrent = payload.vendorMetadata.replyToCurrent === true;
  }

  return Object.keys(reply).length > 0 ? reply : undefined;
}

function buildReplyMetadata(
  payload: NormalizedReplyPayload,
): JsonRecord | undefined {
  const reply = buildVendorReplyRecord(payload);

  return reply
    ? {
        openclaw: {
          reply,
        },
      }
    : undefined;
}

function buildReplyPartMetadata(
  payload: NormalizedReplyPayload,
  extraOpenClaw?: JsonRecord,
): JsonRecord | undefined {
  const metadata = buildReplyMetadata(payload);

  if (!extraOpenClaw) {
    return metadata;
  }

  return mergeMetadata(metadata, {
    openclaw: extraOpenClaw,
  });
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

function buildReplyFilePart(
  payload: NormalizedReplyPayload,
  uri: string,
): {
  availableOutputModes: string[];
  part: FilePart;
} {
  const name = readUriBasename(uri);
  const mimeType = inferMimeTypeFromUri(uri);

  return {
    availableOutputModes: mimeType
      ? [mimeType, OCTET_STREAM_OUTPUT_MODE]
      : [OCTET_STREAM_OUTPUT_MODE],
    part: {
      kind: "file",
      file: {
        uri,
        ...(name ? { name } : {}),
        ...(mimeType ? { mimeType } : {}),
      },
      ...(buildReplyPartMetadata(payload) ? { metadata: buildReplyPartMetadata(payload) } : {}),
    },
  };
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
    ...(buildVendorMetadata(payload)
      ? { vendorMetadata: buildVendorMetadata(payload) }
      : {}),
  };
}

export function hasReplyPayloadExtras(payload: NormalizedReplyPayload): boolean {
  return payload.mediaUrls.length > 0 || typeof payload.vendorMetadata !== "undefined";
}

export function mergeReplyVendorMetadata(
  current: ReplyVendorMetadata | undefined,
  next: ReplyVendorMetadata | undefined,
): ReplyVendorMetadata | undefined {
  if (!current) {
    return next ? structuredClone(next) : undefined;
  }

  if (!next) {
    return current;
  }

  return {
    ...current,
    ...next,
    ...(next.channelData ? { channelData: structuredClone(next.channelData) } : {}),
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
  const metadata = buildReplyMetadata(params.payload);

  if (params.payload.text) {
    availableOutputModes.add(TEXT_PLAIN_OUTPUT_MODE);

    if (hasAllowedOutputMode(acceptedOutputModes, TEXT_PLAIN_OUTPUT_MODE)) {
      const textPart: TextPart = {
        kind: "text",
        text: params.payload.text,
        ...(buildReplyPartMetadata(params.payload)
          ? { metadata: buildReplyPartMetadata(params.payload) }
          : {}),
      };
      parts.push(textPart);
    }
  }

  for (const uri of params.payload.mediaUrls) {
    const filePart = buildReplyFilePart(params.payload, uri);

    for (const mode of filePart.availableOutputModes) {
      availableOutputModes.add(mode);
    }

    if (
      filePart.availableOutputModes.some((mode) =>
        hasAllowedOutputMode(acceptedOutputModes, mode),
      )
    ) {
      parts.push(filePart.part);
    }
  }

  if (params.payload.vendorMetadata) {
    availableOutputModes.add(JSON_OUTPUT_MODE);

    if (hasAllowedOutputMode(acceptedOutputModes, JSON_OUTPUT_MODE)) {
      const dataPart: DataPart = {
        kind: "data",
        data: {
          openclaw: {
            reply: buildVendorReplyRecord(params.payload),
          },
        },
        ...(buildReplyPartMetadata(params.payload, { schema: "reply-v1" })
          ? { metadata: buildReplyPartMetadata(params.payload, { schema: "reply-v1" }) }
          : {}),
      };
      parts.push(dataPart);
    }
  }

  return {
    parts,
    metadata,
    availableOutputModes: [...availableOutputModes],
    hasCandidates: availableOutputModes.size > 0,
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
  eventMetadata?: JsonRecord;
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
    metadata: params.eventMetadata,
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
  eventMetadata?: JsonRecord;
  append?: boolean;
  lastChunk?: boolean;
}): TaskArtifactUpdateEvent {
  return createArtifactUpdate({
    taskId: params.taskId,
    contextId: params.contextId,
    artifactId: params.artifactId,
    name: params.name,
    parts: params.content.parts,
    metadata: mergeMetadata(
      {
        sequence: params.sequence,
        source: params.name,
      },
      params.content.metadata,
    ),
    eventMetadata: params.eventMetadata,
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
  eventMetadata?: JsonRecord;
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
    eventMetadata: params.eventMetadata,
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
