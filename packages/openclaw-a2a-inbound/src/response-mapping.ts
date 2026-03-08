import { randomUUID } from "node:crypto";
import type {
  Artifact,
  Message,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";

type JsonRecord = Record<string, unknown>;
type TaskState = Task["status"]["state"];

export interface NormalizedReplyPayload {
  text?: string;
  mediaUrls: string[];
  channelData?: JsonRecord;
  isError: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      isError: false,
    };
  }

  const text =
    typeof payload.text === "string"
      ? payload.text.trim()
      : typeof payload.body === "string"
        ? payload.body.trim()
        : undefined;
  const mediaUrls =
    Array.isArray(payload.mediaUrls) && payload.mediaUrls.every((item) => typeof item === "string")
      ? [...payload.mediaUrls]
      : typeof payload.mediaUrl === "string" && payload.mediaUrl.trim().length > 0
        ? [payload.mediaUrl]
        : [];

  return {
    text: text && text.length > 0 ? text : undefined,
    mediaUrls,
    channelData: isRecord(payload.channelData) ? payload.channelData : undefined,
    isError: payload.isError === true,
  };
}

export function hasReplyPayloadExtras(payload: NormalizedReplyPayload): boolean {
  return payload.mediaUrls.length > 0 || typeof payload.channelData !== "undefined";
}

export function createAgentTextMessage(params: {
  contextId: string;
  text: string;
  taskId?: string;
}): Message {
  return {
    kind: "message",
    messageId: randomUUID(),
    role: "agent",
    parts: [{ kind: "text", text: params.text }],
    contextId: params.contextId,
    taskId: params.taskId,
  };
}

export function createTaskSnapshot(params: {
  taskId: string;
  contextId: string;
  state: TaskState;
  history?: Message[];
  artifacts?: Artifact[];
  metadata?: JsonRecord;
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
  messageText?: string;
  timestamp?: string;
}): TaskStatusUpdateEvent {
  return {
    kind: "status-update",
    taskId: params.taskId,
    contextId: params.contextId,
    final: params.final === true,
    status: createTaskStatus(params),
  };
}

export function createArtifactUpdate(params: {
  taskId: string;
  contextId: string;
  artifactId: string;
  name?: string;
  description?: string;
  text?: string;
  data?: JsonRecord;
  metadata?: JsonRecord;
  append?: boolean;
  lastChunk?: boolean;
}): TaskArtifactUpdateEvent {
  const parts: Part[] = [];

  if (typeof params.text === "string" && params.text.length > 0) {
    parts.push({ kind: "text", text: params.text });
  }

  if (params.data) {
    parts.push({ kind: "data", data: params.data });
  }

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
  payload: NormalizedReplyPayload;
  append?: boolean;
  lastChunk?: boolean;
}): TaskArtifactUpdateEvent {
  return createArtifactUpdate({
    taskId: params.taskId,
    contextId: params.contextId,
    artifactId: params.artifactId,
    name: params.name,
    text: params.payload.text,
    data: buildReplyPayloadData(params.payload),
    metadata: {
      sequence: params.sequence,
      source: params.name,
    },
    append: params.append,
    lastChunk: params.lastChunk,
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

function createTaskStatus(params: {
  contextId: string;
  taskId: string;
  state: TaskState;
  messageText?: string;
  timestamp?: string;
}): Task["status"] {
  return {
    state: params.state,
    timestamp: params.timestamp ?? new Date().toISOString(),
    message: params.messageText
      ? createAgentTextMessage({
          contextId: params.contextId,
          taskId: params.taskId,
          text: params.messageText,
        })
      : undefined,
  };
}

function buildReplyPayloadData(
  payload: NormalizedReplyPayload,
): JsonRecord | undefined {
  const data: JsonRecord = {};

  if (payload.mediaUrls.length > 0) {
    data.mediaUrls = payload.mediaUrls;
  }

  if (payload.channelData) {
    data.channelData = payload.channelData;
  }

  if (payload.isError) {
    data.isError = true;
  }

  return Object.keys(data).length > 0 ? data : undefined;
}
