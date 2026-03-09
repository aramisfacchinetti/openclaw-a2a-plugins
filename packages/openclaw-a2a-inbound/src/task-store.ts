import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  appendFile,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createReadStream,
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import {
  MAX_MATERIALIZED_FILE_BYTES,
  buildContentDispositionHeader,
  buildTaskFileLogicalKey,
  buildTaskFileUrl,
  decodeTaskStorageId,
  encodeTaskStorageId,
  mapBuiltReplyContentFiles,
  parseContentDispositionFilename,
  type StoredTaskArtifactFileIndex,
  type StoredTaskFileDescriptor,
  type StoredTaskFileMeta,
} from "./file-delivery.js";
import {
  type BuiltReplyContent,
  classifyTaskState,
  createTaskStatusUpdate,
  isActiveExecutionTaskState,
} from "./response-mapping.js";

type JsonRecord = Record<string, unknown>;
type JournalEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
type TaskRuntimeLeaseState = "active" | "released";
type StoredTaskBindingMatchedBy =
  | "binding.peer"
  | "binding.peer.parent"
  | "binding.guild+roles"
  | "binding.guild"
  | "binding.team"
  | "binding.account"
  | "binding.channel"
  | "default";

export const TASK_HEARTBEAT_INTERVAL_MS = 5_000;
export const TASK_LEASE_TTL_MS = 20_000;
export const INTERRUPTED_TASK_FAILURE_TEXT =
  "Task execution was interrupted by process loss before completion.";

export interface TaskExecutionLease {
  ownerId?: string;
  runId?: string;
  state: TaskRuntimeLeaseState;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  releasedAt?: string;
}

export interface StoredTaskRuntime {
  currentSequence: number;
  lease?: TaskExecutionLease;
}

export type StoredTaskBindingPeerSource =
  | "server-user-name"
  | "context-id"
  | "task-id"
  | "message-id";

export interface StoredTaskBinding {
  schemaVersion: 1;
  agentId: string;
  channel: string;
  accountId: string;
  matchedBy: StoredTaskBindingMatchedBy;
  sessionKey: string;
  mainSessionKey: string;
  storePath: string;
  peer: {
    kind: string;
    id: string;
    source: StoredTaskBindingPeerSource;
  };
  createdAt: string;
  updatedAt: string;
}

export interface TaskEventProvenance {
  runId?: string;
  sessionKey?: string;
  agentEventSeq?: number;
  agentEventTs?: number;
}

export interface StoredTaskJournalRecord {
  sequence: number;
  committedAt: string;
  event: JournalEvent;
  provenance: TaskEventProvenance;
}

export interface TaskJournalSubscriptionHandle {
  next(): Promise<StoredTaskJournalRecord | undefined>;
  close(): void;
}

type TaskRuntimeSubscriber = (record: StoredTaskJournalRecord) => void;

type PreparedLiveTail = {
  subscription?: TaskJournalSubscriptionHandle;
  task: Task;
};

type PreparedReplayTail = {
  subscription?: TaskJournalSubscriptionHandle;
  task: Task;
  events: StoredTaskJournalRecord[];
};

type MaterializedTaskState = {
  task: Task;
  currentSequence: number;
  runtime: StoredTaskRuntime;
};

type LiveTaskFileDescriptor = StoredTaskFileDescriptor & {
  dirty: boolean;
};

type LiveTaskArtifactFileIndex = {
  artifactId: string;
  dirty: boolean;
  fileIdsByLogicalKey: Map<string, string>;
};

type TaskFileDownload = {
  blobPath: string;
  descriptor: StoredTaskFileDescriptor;
  meta?: StoredTaskFileMeta;
  contentDisposition?: string;
  contentLength?: number;
  contentType: string;
};

type TaskFileRegistrySnapshot = {
  descriptors: StoredTaskFileDescriptor[];
  indexes: StoredTaskArtifactFileIndex[];
};

type TaskFileFetchLike = typeof fetch;
type TaskFileLookupFn = typeof dnsLookup;

type TaskStoreOptions = {
  fetchImpl?: TaskFileFetchLike;
  lookupFn?: TaskFileLookupFn;
};

export interface A2AInboundTaskStoreConfig {
  kind: "memory" | "json-file";
  path?: string;
}

interface TaskRuntimeStorage {
  readonly kind: A2AInboundTaskStoreConfig["kind"];
  close(): void;
  listTaskIds(): Promise<string[]>;
  readBinding(taskId: string): Promise<StoredTaskBinding | undefined>;
  writeBinding(taskId: string, binding: StoredTaskBinding): Promise<void>;
  readSnapshot(taskId: string): Promise<Task | undefined>;
  writeSnapshot(taskId: string, task: Task): Promise<void>;
  readRuntime(taskId: string): Promise<StoredTaskRuntime | undefined>;
  writeRuntime(taskId: string, runtime: StoredTaskRuntime): Promise<void>;
  readEventsAfter(
    taskId: string,
    afterSequence: number,
  ): Promise<StoredTaskJournalRecord[]>;
  appendEvent(taskId: string, record: StoredTaskJournalRecord): Promise<void>;
  readTaskFileRegistry(taskId: string): Promise<TaskFileRegistrySnapshot>;
  readFileDescriptor(
    taskId: string,
    artifactId: string,
    fileId: string,
  ): Promise<StoredTaskFileDescriptor | undefined>;
  writeFileDescriptor(
    taskId: string,
    artifactId: string,
    descriptor: StoredTaskFileDescriptor,
  ): Promise<void>;
  readArtifactFileIndex(
    taskId: string,
    artifactId: string,
  ): Promise<StoredTaskArtifactFileIndex | undefined>;
  writeArtifactFileIndex(
    taskId: string,
    artifactId: string,
    index: StoredTaskArtifactFileIndex,
  ): Promise<void>;
  readFileMeta(
    taskId: string,
    artifactId: string,
    fileId: string,
  ): Promise<StoredTaskFileMeta | undefined>;
  writeFileMeta(
    taskId: string,
    artifactId: string,
    fileId: string,
    meta: StoredTaskFileMeta,
  ): Promise<void>;
  blobPath(taskId: string, artifactId: string, fileId: string): string;
  blobExists(taskId: string, artifactId: string, fileId: string): Promise<boolean>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function cloneTask(task: Task): Task {
  return structuredClone(task);
}

function cloneMessage(message: Message): Message {
  return structuredClone(message);
}

function cloneTaskBinding(binding: StoredTaskBinding): StoredTaskBinding {
  return structuredClone(binding);
}

function cloneJournalEvent(event: JournalEvent): JournalEvent {
  return structuredClone(event);
}

function cloneJournalRecord(record: StoredTaskJournalRecord): StoredTaskJournalRecord {
  return structuredClone(record);
}

function cloneTaskFileDescriptor(
  descriptor: StoredTaskFileDescriptor,
): StoredTaskFileDescriptor {
  return structuredClone(descriptor);
}

function cloneTaskArtifactFileIndex(
  index: StoredTaskArtifactFileIndex,
): StoredTaskArtifactFileIndex {
  return structuredClone(index);
}

function cloneTaskFileMeta(meta: StoredTaskFileMeta): StoredTaskFileMeta {
  return structuredClone(meta);
}

function toIsoString(value: Date | number | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  return new Date(value).toISOString();
}

function normalizeCurrentSequence(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : 0;
}

function normalizeLease(value: unknown): TaskExecutionLease | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const state = value.state === "active" ? "active" : value.state === "released" ? "released" : undefined;

  if (!state) {
    return undefined;
  }

  return {
    state,
    ...(typeof value.ownerId === "string" ? { ownerId: value.ownerId } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.heartbeatAt === "string"
      ? { heartbeatAt: value.heartbeatAt }
      : {}),
    ...(typeof value.leaseExpiresAt === "string"
      ? { leaseExpiresAt: value.leaseExpiresAt }
      : {}),
    ...(typeof value.releasedAt === "string"
      ? { releasedAt: value.releasedAt }
      : {}),
  };
}

function normalizeRuntimeRecord(value: unknown): StoredTaskRuntime {
  const record = isRecord(value) ? value : {};
  return {
    currentSequence: normalizeCurrentSequence(record.currentSequence),
    ...(normalizeLease(record.lease) ? { lease: normalizeLease(record.lease) } : {}),
  };
}

function readEventRunId(
  event: Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): string | undefined {
  const openclaw = extractOpenClawMetadata(event.metadata);

  return typeof openclaw.runId === "string" ? openclaw.runId : undefined;
}

function readEventProvenanceMetadata(
  event: Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): Pick<TaskEventProvenance, "agentEventSeq" | "agentEventTs"> {
  const openclaw = extractOpenClawMetadata(event.metadata);

  return {
    ...(typeof openclaw.agentEventSeq === "number" &&
    Number.isInteger(openclaw.agentEventSeq)
      ? { agentEventSeq: openclaw.agentEventSeq }
      : {}),
    ...(typeof openclaw.agentEventTs === "number" &&
    Number.isFinite(openclaw.agentEventTs)
      ? { agentEventTs: openclaw.agentEventTs }
      : {}),
  };
}

function extractOpenClawMetadata(metadata: unknown): JsonRecord {
  if (!isRecord(metadata)) {
    return {};
  }

  const openclaw = metadata.openclaw;
  return isRecord(openclaw) ? openclaw : {};
}

function mergeMetadata(
  metadata: JsonRecord | undefined,
  patch: JsonRecord,
): JsonRecord {
  const nextMetadata = metadata ? structuredClone(metadata) : {};
  const nextOpenclaw = extractOpenClawMetadata(nextMetadata);

  nextMetadata.openclaw = {
    ...nextOpenclaw,
    ...patch,
  };

  return nextMetadata;
}

function withCurrentSequence(task: Task, sequence: number): Task {
  const nextTask = cloneTask(task);
  nextTask.metadata = mergeMetadata(nextTask.metadata as JsonRecord | undefined, {
    currentSequence: sequence,
  });
  return nextTask;
}

function withTaskRunId(task: Task, runId: string | undefined): Task {
  if (!runId || runId.trim().length === 0) {
    return task;
  }

  const nextTask = cloneTask(task);
  nextTask.metadata = mergeMetadata(nextTask.metadata as JsonRecord | undefined, {
    runId,
  });
  return nextTask;
}

function withRuntimeRunId(
  runtime: StoredTaskRuntime,
  runId: string | undefined,
): StoredTaskRuntime {
  if (!runId || !runtime.lease) {
    return runtime;
  }

  return {
    currentSequence: runtime.currentSequence,
    lease: {
      ...runtime.lease,
      runId,
    },
  };
}

function normalizeBindingPeerSource(
  value: unknown,
): StoredTaskBindingPeerSource | undefined {
  return value === "server-user-name" ||
    value === "context-id" ||
    value === "task-id" ||
    value === "message-id"
    ? value
    : undefined;
}

function normalizeMatchedBy(
  value: unknown,
): StoredTaskBindingMatchedBy | undefined {
  switch (value) {
    case "binding.peer":
    case "binding.peer.parent":
    case "binding.guild+roles":
    case "binding.guild":
    case "binding.team":
    case "binding.account":
    case "binding.channel":
    case "default":
      return value;
    default:
      return undefined;
  }
}

function normalizeBindingRecord(value: unknown): StoredTaskBinding | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.peer)) {
    return undefined;
  }

  const matchedBy = normalizeMatchedBy(value.matchedBy);
  const peerSource = normalizeBindingPeerSource(value.peer.source);
  const peerKind =
    typeof value.peer.kind === "string" && value.peer.kind.trim().length > 0
      ? value.peer.kind.trim()
      : undefined;
  const peerId =
    typeof value.peer.id === "string" && value.peer.id.trim().length > 0
      ? value.peer.id.trim()
      : undefined;
  const createdAt =
    typeof value.createdAt === "string" && value.createdAt.trim().length > 0
      ? value.createdAt
      : undefined;
  const updatedAt =
    typeof value.updatedAt === "string" && value.updatedAt.trim().length > 0
      ? value.updatedAt
      : undefined;
  const agentId =
    typeof value.agentId === "string" && value.agentId.trim().length > 0
      ? value.agentId.trim()
      : undefined;
  const channel =
    typeof value.channel === "string" && value.channel.trim().length > 0
      ? value.channel.trim()
      : undefined;
  const accountId =
    typeof value.accountId === "string" && value.accountId.trim().length > 0
      ? value.accountId.trim()
      : undefined;
  const sessionKey =
    typeof value.sessionKey === "string" && value.sessionKey.trim().length > 0
      ? value.sessionKey.trim()
      : undefined;
  const mainSessionKey =
    typeof value.mainSessionKey === "string" &&
    value.mainSessionKey.trim().length > 0
      ? value.mainSessionKey.trim()
      : undefined;
  const storePath =
    typeof value.storePath === "string" && value.storePath.trim().length > 0
      ? value.storePath
      : undefined;

  if (
    !matchedBy ||
    !peerSource ||
    !peerKind ||
    !peerId ||
    !createdAt ||
    !updatedAt ||
    !agentId ||
    !channel ||
    !accountId ||
    !sessionKey ||
    !mainSessionKey ||
    !storePath
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    agentId,
    channel,
    accountId,
    matchedBy,
    sessionKey,
    mainSessionKey,
    storePath,
    peer: {
      kind: peerKind,
      id: peerId,
      source: peerSource,
    },
    createdAt,
    updatedAt,
  };
}

function normalizeTaskFileDescriptor(
  value: unknown,
): StoredTaskFileDescriptor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const fileId = readTrimmedString(value.fileId);
  const artifactId = readTrimmedString(value.artifactId);
  const sourceUri = readTrimmedString(value.sourceUri);
  const firstEmittedAt = readTrimmedString(value.firstEmittedAt);
  const lastReferencedAt = readTrimmedString(value.lastReferencedAt);

  if (!fileId || !artifactId || !sourceUri || !firstEmittedAt || !lastReferencedAt) {
    return undefined;
  }

  return {
    fileId,
    artifactId,
    sourceUri,
    ...(readTrimmedString(value.originalName)
      ? { originalName: readTrimmedString(value.originalName) }
      : {}),
    ...(readTrimmedString(value.originalMimeType)
      ? { originalMimeType: readTrimmedString(value.originalMimeType) }
      : {}),
    firstEmittedAt,
    lastReferencedAt,
  };
}

function normalizeTaskArtifactFileIndex(
  value: unknown,
): StoredTaskArtifactFileIndex | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return undefined;
  }

  const artifactId = readTrimmedString(value.artifactId);
  const updatedAt = readTrimmedString(value.updatedAt);
  const rawMappings = isRecord(value.fileIdsByLogicalKey)
    ? value.fileIdsByLogicalKey
    : undefined;

  if (!artifactId || !updatedAt || !rawMappings) {
    return undefined;
  }

  const fileIdsByLogicalKey: Record<string, string> = {};

  for (const [logicalKey, fileId] of Object.entries(rawMappings)) {
    const normalizedFileId = readTrimmedString(fileId);

    if (logicalKey.length === 0 || !normalizedFileId) {
      continue;
    }

    fileIdsByLogicalKey[logicalKey] = normalizedFileId;
  }

  return {
    schemaVersion: 1,
    artifactId,
    fileIdsByLogicalKey,
    updatedAt,
  };
}

function normalizeTaskFileMeta(value: unknown): StoredTaskFileMeta | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return undefined;
  }

  const size =
    typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0
      ? value.size
      : undefined;
  const materializedAt = readTrimmedString(value.materializedAt);
  const finalUrl = readTrimmedString(value.finalUrl);

  if (typeof size !== "number" || !materializedAt || !finalUrl) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    size,
    materializedAt,
    finalUrl,
    ...(readTrimmedString(value.contentType)
      ? { contentType: readTrimmedString(value.contentType) }
      : {}),
    ...(readTrimmedString(value.fileName)
      ? { fileName: readTrimmedString(value.fileName) }
      : {}),
  };
}

function decorateJournalEvent<T extends JournalEvent>(
  event: T,
  sequence: number,
): T {
  const nextEvent = cloneJournalEvent(event);
  nextEvent.metadata = mergeMetadata(nextEvent.metadata as JsonRecord | undefined, {
    sequence,
  });
  return nextEvent as T;
}

function markEventAsReplayed<T extends JournalEvent>(event: T): T {
  const nextEvent = cloneJournalEvent(event);
  nextEvent.metadata = mergeMetadata(nextEvent.metadata as JsonRecord | undefined, {
    replayed: true,
  });
  return nextEvent as T;
}

function mergeArtifact(
  task: Task,
  event: TaskArtifactUpdateEvent,
): Task {
  const nextTask = cloneTask(task);
  const nextArtifact = structuredClone(event.artifact);

  if (!nextTask.artifacts) {
    nextTask.artifacts = [];
  }

  const existingArtifactIndex = nextTask.artifacts.findIndex(
    (artifact) => artifact.artifactId === nextArtifact.artifactId,
  );

  if (existingArtifactIndex === -1) {
    nextTask.artifacts.push(nextArtifact);
    return nextTask;
  }

  if (!event.append) {
    nextTask.artifacts[existingArtifactIndex] = nextArtifact;
    return nextTask;
  }

  const existingArtifact = nextTask.artifacts[existingArtifactIndex];
  existingArtifact.parts.push(...nextArtifact.parts);

  if (nextArtifact.name) {
    existingArtifact.name = nextArtifact.name;
  }

  if (nextArtifact.description) {
    existingArtifact.description = nextArtifact.description;
  }

  if (nextArtifact.metadata) {
    existingArtifact.metadata = {
      ...existingArtifact.metadata,
      ...nextArtifact.metadata,
    };
  }

  return nextTask;
}

function mergeStatus(task: Task, event: TaskStatusUpdateEvent): Task {
  const nextTask = cloneTask(task);
  nextTask.status = structuredClone(event.status);

  if (!event.status.message) {
    return nextTask;
  }

  const statusMessageId = event.status.message.messageId;
  const history = nextTask.history ? [...nextTask.history] : [];

  if (!history.some((entry) => entry.messageId === statusMessageId)) {
    history.push(structuredClone(event.status.message));
    nextTask.history = history;
  }

  return nextTask;
}

function foldTaskJournalOntoSnapshot(
  snapshot: Task,
  records: readonly StoredTaskJournalRecord[],
): {
  task: Task;
  currentSequence: number;
} {
  let currentSequence = readTaskCurrentSequence(snapshot);
  let nextTask = withCurrentSequence(snapshot, currentSequence);

  for (const record of [...records].sort((left, right) => left.sequence - right.sequence)) {
    if (record.sequence <= currentSequence) {
      continue;
    }

    nextTask =
      record.event.kind === "status-update"
        ? mergeStatus(nextTask, record.event)
        : mergeArtifact(nextTask, record.event);
    nextTask = withTaskRunId(nextTask, record.provenance.runId);
    currentSequence = record.sequence;
  }

  return {
    task: withCurrentSequence(nextTask, currentSequence),
    currentSequence,
  };
}

function readLeaseExpiry(lease: TaskExecutionLease | undefined): number | undefined {
  if (!lease?.leaseExpiresAt) {
    return undefined;
  }

  const expiresAt = Date.parse(lease.leaseExpiresAt);
  return Number.isFinite(expiresAt) ? expiresAt : undefined;
}

function hasExpiredOrMissingLease(
  runtime: StoredTaskRuntime | undefined,
  nowMs: number,
): boolean {
  const lease = runtime?.lease;

  if (!lease || lease.state !== "active") {
    return true;
  }

  const expiresAt = readLeaseExpiry(lease);
  return typeof expiresAt !== "number" || expiresAt <= nowMs;
}

function createLease(
  currentSequence: number,
  params: {
    ownerId: string;
    nowIso: string;
    runId?: string;
  },
): StoredTaskRuntime {
  return {
    currentSequence,
    lease: {
      ownerId: params.ownerId,
      state: "active",
      heartbeatAt: params.nowIso,
      leaseExpiresAt: new Date(
        Date.parse(params.nowIso) + TASK_LEASE_TTL_MS,
      ).toISOString(),
      ...(params.runId ? { runId: params.runId } : {}),
    },
  };
}

function releaseLease(
  runtime: StoredTaskRuntime,
  params: {
    nowIso: string;
    ownerId?: string;
    runId?: string;
  },
): StoredTaskRuntime {
  const previousLease = runtime.lease;

  return {
    currentSequence: runtime.currentSequence,
    lease: {
      state: "released",
      heartbeatAt: params.nowIso,
      leaseExpiresAt: params.nowIso,
      releasedAt: params.nowIso,
      ...(params.ownerId ?? previousLease?.ownerId
        ? { ownerId: params.ownerId ?? previousLease?.ownerId }
        : {}),
      ...(params.runId ?? previousLease?.runId
        ? { runId: params.runId ?? previousLease?.runId }
        : {}),
    },
  };
}

function buildJournalProvenance(params: {
  event: Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
  binding?: StoredTaskBinding;
  runId?: string;
}): TaskEventProvenance {
  const metadata = readEventProvenanceMetadata(params.event);

  return {
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.binding?.sessionKey ? { sessionKey: params.binding.sessionKey } : {}),
    ...metadata,
  };
}

function createInterruptedFailureRecord(params: {
  task: Task;
  sequence: number;
  committedAt: string;
  runId?: string;
  sessionKey?: string;
}): {
  event: TaskStatusUpdateEvent;
  snapshot: Task;
  record: StoredTaskJournalRecord;
} {
  const event = decorateJournalEvent(
    createTaskStatusUpdate({
      taskId: params.task.id,
      contextId: params.task.contextId,
      state: "failed",
      final: true,
      messageText: INTERRUPTED_TASK_FAILURE_TEXT,
      timestamp: params.committedAt,
    }),
    params.sequence,
  );
  const snapshot = withTaskRunId(
    withCurrentSequence(mergeStatus(params.task, event), params.sequence),
    params.runId,
  );

  return {
    event,
    snapshot,
    record: {
      sequence: params.sequence,
      committedAt: params.committedAt,
      event,
      provenance: {
        ...(params.runId ? { runId: params.runId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      },
    },
  };
}

function ensureHistoryContainsMessage(task: Task, message: Message): Task {
  const nextTask = cloneTask(task);
  const history = nextTask.history ? [...nextTask.history] : [];

  if (!history.some((entry) => entry.messageId === message.messageId)) {
    history.push(cloneMessage(message));
    nextTask.history = history;
  }

  return nextTask;
}

function isJournalEvent(
  event: Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): event is JournalEvent {
  return event.kind === "status-update" || event.kind === "artifact-update";
}

function maybeReadJsonFileSync<T>(filePath: string): T | undefined {
  try {
    const raw = readFileSync(filePath, "utf8");

    if (raw.trim().length === 0) {
      return undefined;
    }

    return JSON.parse(raw) as T;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function maybeReadJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");

    if (raw.trim().length === 0) {
      return undefined;
    }

    return JSON.parse(raw) as T;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function readNdjsonFileSync<T>(filePath: string): T[] {
  try {
    const raw = readFileSync(filePath, "utf8");

    if (raw.trim().length === 0) {
      return [];
    }

    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

    if (code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readNdjsonFile<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, "utf8");

    if (raw.trim().length === 0) {
      return [];
    }

    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

    if (code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function writeJsonFileAtomicallySync(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2));
  renameSync(tempPath, filePath);
}

async function writeJsonFileAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2));
  await rename(tempPath, filePath);
}

class MemoryTaskRuntimeStorage implements TaskRuntimeStorage {
  readonly kind = "memory" as const;

  private readonly bindings = new Map<string, StoredTaskBinding>();
  private readonly snapshots = new Map<string, Task>();
  private readonly runtimes = new Map<string, StoredTaskRuntime>();
  private readonly journals = new Map<string, StoredTaskJournalRecord[]>();
  private readonly fileDescriptors = new Map<
    string,
    Map<string, Map<string, StoredTaskFileDescriptor>>
  >();
  private readonly fileIndexes = new Map<
    string,
    Map<string, StoredTaskArtifactFileIndex>
  >();
  private readonly fileMetas = new Map<string, Map<string, Map<string, StoredTaskFileMeta>>>();
  private readonly tempRootPath = mkdtempSync(
    join(tmpdir(), "openclaw-a2a-inbound-files-"),
  );

  close(): void {
    rmSync(this.tempRootPath, { recursive: true, force: true });
  }

  async listTaskIds(): Promise<string[]> {
    return [...this.snapshots.keys()];
  }

  async readBinding(taskId: string): Promise<StoredTaskBinding | undefined> {
    const binding = this.bindings.get(taskId);
    return binding ? cloneTaskBinding(binding) : undefined;
  }

  async writeBinding(taskId: string, binding: StoredTaskBinding): Promise<void> {
    this.bindings.set(taskId, cloneTaskBinding(binding));
  }

  async readSnapshot(taskId: string): Promise<Task | undefined> {
    const snapshot = this.snapshots.get(taskId);
    return snapshot ? cloneTask(snapshot) : undefined;
  }

  async writeSnapshot(taskId: string, task: Task): Promise<void> {
    this.snapshots.set(taskId, cloneTask(task));
  }

  async readRuntime(taskId: string): Promise<StoredTaskRuntime | undefined> {
    const runtime = this.runtimes.get(taskId);
    return runtime ? structuredClone(runtime) : undefined;
  }

  async writeRuntime(taskId: string, runtime: StoredTaskRuntime): Promise<void> {
    this.runtimes.set(taskId, structuredClone(runtime));
  }

  async readEventsAfter(
    taskId: string,
    afterSequence: number,
  ): Promise<StoredTaskJournalRecord[]> {
    const records = this.journals.get(taskId) ?? [];
    return records
      .filter((record) => record.sequence > afterSequence)
      .map((record) => cloneJournalRecord(record));
  }

  async appendEvent(
    taskId: string,
    record: StoredTaskJournalRecord,
  ): Promise<void> {
    const existing = this.journals.get(taskId) ?? [];
    existing.push(cloneJournalRecord(record));
    this.journals.set(taskId, existing);
  }

  async readTaskFileRegistry(taskId: string): Promise<TaskFileRegistrySnapshot> {
    const descriptors = this.fileDescriptors.get(taskId);
    const indexes = this.fileIndexes.get(taskId);

    return {
      descriptors: descriptors
        ? [...descriptors.values()].flatMap((artifactDescriptors) =>
            [...artifactDescriptors.values()].map((descriptor) =>
              cloneTaskFileDescriptor(descriptor),
            ),
          )
        : [],
      indexes: indexes
        ? [...indexes.values()].map((index) => cloneTaskArtifactFileIndex(index))
        : [],
    };
  }

  async readFileDescriptor(
    taskId: string,
    artifactId: string,
    fileId: string,
  ): Promise<StoredTaskFileDescriptor | undefined> {
    const descriptor = this.fileDescriptors
      .get(taskId)
      ?.get(artifactId)
      ?.get(fileId);
    return descriptor ? cloneTaskFileDescriptor(descriptor) : undefined;
  }

  async writeFileDescriptor(
    taskId: string,
    artifactId: string,
    descriptor: StoredTaskFileDescriptor,
  ): Promise<void> {
    const artifacts = this.fileDescriptors.get(taskId) ?? new Map();
    const descriptors = artifacts.get(artifactId) ?? new Map();
    descriptors.set(descriptor.fileId, cloneTaskFileDescriptor(descriptor));
    artifacts.set(artifactId, descriptors);
    this.fileDescriptors.set(taskId, artifacts);
  }

  async readArtifactFileIndex(
    taskId: string,
    artifactId: string,
  ): Promise<StoredTaskArtifactFileIndex | undefined> {
    const index = this.fileIndexes.get(taskId)?.get(artifactId);
    return index ? cloneTaskArtifactFileIndex(index) : undefined;
  }

  async writeArtifactFileIndex(
    taskId: string,
    artifactId: string,
    index: StoredTaskArtifactFileIndex,
  ): Promise<void> {
    const indexes = this.fileIndexes.get(taskId) ?? new Map();
    indexes.set(artifactId, cloneTaskArtifactFileIndex(index));
    this.fileIndexes.set(taskId, indexes);
  }

  async readFileMeta(
    taskId: string,
    artifactId: string,
    fileId: string,
  ): Promise<StoredTaskFileMeta | undefined> {
    const meta = this.fileMetas.get(taskId)?.get(artifactId)?.get(fileId);
    return meta ? cloneTaskFileMeta(meta) : undefined;
  }

  async writeFileMeta(
    taskId: string,
    artifactId: string,
    fileId: string,
    meta: StoredTaskFileMeta,
  ): Promise<void> {
    const artifacts = this.fileMetas.get(taskId) ?? new Map();
    const metas = artifacts.get(artifactId) ?? new Map();
    metas.set(fileId, cloneTaskFileMeta(meta));
    artifacts.set(artifactId, metas);
    this.fileMetas.set(taskId, artifacts);
  }

  blobPath(taskId: string, artifactId: string, fileId: string): string {
    return join(
      this.tempRootPath,
      encodeTaskStorageId(taskId),
      encodeTaskStorageId(artifactId),
      fileId,
      "blob",
    );
  }

  async blobExists(taskId: string, artifactId: string, fileId: string): Promise<boolean> {
    try {
      await stat(this.blobPath(taskId, artifactId, fileId));
      return true;
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }
}

class JsonFileTaskRuntimeStorage implements TaskRuntimeStorage {
  readonly kind = "json-file" as const;

  private readonly rootPath: string;
  private readonly taskRootPath: string;
  private readonly lockFilePath: string;

  constructor(
    rootPath: string,
    private readonly instanceId: string,
  ) {
    this.rootPath = rootPath;
    this.taskRootPath = join(rootPath, "tasks");
    this.lockFilePath = join(rootPath, "writer.lock.json");

    this.ensureRootDirectory();
    this.acquireWriterLock();
    this.runStartupSweep();
  }

  close(): void {
    try {
      const existing = maybeReadJsonFileSync<{ instanceId?: string }>(
        this.lockFilePath,
      );

      if (existing?.instanceId === this.instanceId || !existing) {
        unlinkSync(this.lockFilePath);
      }
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  async listTaskIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.taskRootPath, { withFileTypes: true });
      return entries.flatMap((entry) => {
        if (!entry.isDirectory()) {
          return [];
        }

        const taskId = decodeTaskStorageId(entry.name);
        return taskId ? [taskId] : [];
      });
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async readBinding(taskId: string): Promise<StoredTaskBinding | undefined> {
    const binding = await maybeReadJsonFile<StoredTaskBinding>(this.bindingPath(taskId));
    return binding ? normalizeBindingRecord(binding) : undefined;
  }

  async writeBinding(taskId: string, binding: StoredTaskBinding): Promise<void> {
    await writeJsonFileAtomically(this.bindingPath(taskId), binding);
  }

  async readSnapshot(taskId: string): Promise<Task | undefined> {
    const snapshot = await maybeReadJsonFile<Task>(this.snapshotPath(taskId));
    return snapshot ? cloneTask(snapshot) : undefined;
  }

  async writeSnapshot(taskId: string, task: Task): Promise<void> {
    await writeJsonFileAtomically(this.snapshotPath(taskId), task);
  }

  async readRuntime(taskId: string): Promise<StoredTaskRuntime | undefined> {
    const runtime = await maybeReadJsonFile<StoredTaskRuntime>(
      this.runtimePath(taskId),
    );
    return runtime ? normalizeRuntimeRecord(runtime) : undefined;
  }

  async writeRuntime(taskId: string, runtime: StoredTaskRuntime): Promise<void> {
    await writeJsonFileAtomically(this.runtimePath(taskId), runtime);
  }

  async readEventsAfter(
    taskId: string,
    afterSequence: number,
  ): Promise<StoredTaskJournalRecord[]> {
    const records = await readNdjsonFile<StoredTaskJournalRecord>(
      this.eventsPath(taskId),
    );
    return records
      .map((record) => this.normalizeJournalRecord(record))
      .filter((record) => record.sequence > afterSequence);
  }

  async appendEvent(
    taskId: string,
    record: StoredTaskJournalRecord,
  ): Promise<void> {
    await mkdir(this.taskDirectory(taskId), { recursive: true });
    await appendFile(this.eventsPath(taskId), `${JSON.stringify(record)}\n`);
  }

  async readTaskFileRegistry(taskId: string): Promise<TaskFileRegistrySnapshot> {
    const artifactRoots = await this.listArtifactDirectoryNames(taskId);
    const descriptors: StoredTaskFileDescriptor[] = [];
    const indexes: StoredTaskArtifactFileIndex[] = [];

    for (const encodedArtifactId of artifactRoots) {
      const artifactId = decodeTaskStorageId(encodedArtifactId);

      if (!artifactId) {
        continue;
      }

      const index = normalizeTaskArtifactFileIndex(
        await maybeReadJsonFile<StoredTaskArtifactFileIndex>(
          this.artifactFileIndexPath(taskId, artifactId),
        ),
      );

      if (index) {
        indexes.push(index);
      }

      const fileEntries = await this.listArtifactFileDirectoryNames(taskId, artifactId);

      for (const fileId of fileEntries) {
        const descriptor = normalizeTaskFileDescriptor(
          await maybeReadJsonFile<StoredTaskFileDescriptor>(
            this.fileDescriptorPath(taskId, artifactId, fileId),
          ),
        );

        if (descriptor) {
          descriptors.push(descriptor);
        }
      }
    }

    return { descriptors, indexes };
  }

  async readFileDescriptor(
    taskId: string,
    artifactId: string,
    fileId: string,
  ): Promise<StoredTaskFileDescriptor | undefined> {
    return normalizeTaskFileDescriptor(
      await maybeReadJsonFile<StoredTaskFileDescriptor>(
        this.fileDescriptorPath(taskId, artifactId, fileId),
      ),
    );
  }

  async writeFileDescriptor(
    taskId: string,
    artifactId: string,
    descriptor: StoredTaskFileDescriptor,
  ): Promise<void> {
    await writeJsonFileAtomically(
      this.fileDescriptorPath(taskId, artifactId, descriptor.fileId),
      descriptor,
    );
  }

  async readArtifactFileIndex(
    taskId: string,
    artifactId: string,
  ): Promise<StoredTaskArtifactFileIndex | undefined> {
    return normalizeTaskArtifactFileIndex(
      await maybeReadJsonFile<StoredTaskArtifactFileIndex>(
        this.artifactFileIndexPath(taskId, artifactId),
      ),
    );
  }

  async writeArtifactFileIndex(
    taskId: string,
    artifactId: string,
    index: StoredTaskArtifactFileIndex,
  ): Promise<void> {
    await writeJsonFileAtomically(this.artifactFileIndexPath(taskId, artifactId), index);
  }

  async readFileMeta(
    taskId: string,
    artifactId: string,
    fileId: string,
  ): Promise<StoredTaskFileMeta | undefined> {
    return normalizeTaskFileMeta(
      await maybeReadJsonFile<StoredTaskFileMeta>(
        this.fileMetaPath(taskId, artifactId, fileId),
      ),
    );
  }

  async writeFileMeta(
    taskId: string,
    artifactId: string,
    fileId: string,
    meta: StoredTaskFileMeta,
  ): Promise<void> {
    await writeJsonFileAtomically(this.fileMetaPath(taskId, artifactId, fileId), meta);
  }

  blobPath(taskId: string, artifactId: string, fileId: string): string {
    return this.fileBlobPath(taskId, artifactId, fileId);
  }

  async blobExists(taskId: string, artifactId: string, fileId: string): Promise<boolean> {
    try {
      await stat(this.fileBlobPath(taskId, artifactId, fileId));
      return true;
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  private ensureRootDirectory(): void {
    if (existsSync(this.rootPath)) {
      const rootStat = statSync(this.rootPath);

      if (!rootStat.isDirectory()) {
        throw new Error(
          `taskStore.path "${this.rootPath}" must point to a directory root for openclaw-a2a-inbound.`,
        );
      }
    }

    mkdirSync(this.rootPath, { recursive: true });
    mkdirSync(this.taskRootPath, { recursive: true });
  }

  private acquireWriterLock(): void {
    const lockPayload = {
      instanceId: this.instanceId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };

    try {
      const fd = openSync(this.lockFilePath, "wx");
      writeFileSync(fd, JSON.stringify(lockPayload, null, 2));
      closeSync(fd);
      return;
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code !== "EEXIST") {
        throw error;
      }
    }

    const existing = maybeReadJsonFileSync<{
      instanceId?: string;
      pid?: number;
    }>(this.lockFilePath);
    const pid =
      typeof existing?.pid === "number" && Number.isInteger(existing.pid)
        ? existing.pid
        : undefined;

    if (pid && this.isProcessAlive(pid)) {
      throw new Error(
        `taskStore.path "${this.rootPath}" is already owned by live process ${pid}.`,
      );
    }

    unlinkSync(this.lockFilePath);
    const fd = openSync(this.lockFilePath, "wx");
    writeFileSync(fd, JSON.stringify(lockPayload, null, 2));
    closeSync(fd);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      return code !== "ESRCH";
    }
  }

  private runStartupSweep(): void {
    const nowIso = new Date().toISOString();
    const nowMs = Date.parse(nowIso);

    for (const entry of this.listTaskDirectoryNamesSync()) {
      try {
        const taskId = decodeTaskStorageId(entry);

        if (!taskId) {
          continue;
        }

        const materialized = this.materializeTaskSync(taskId);

        if (
          !materialized ||
          !isActiveExecutionTaskState(materialized.task.status.state)
        ) {
          continue;
        }

        const runtime = normalizeRuntimeRecord(
          maybeReadJsonFileSync<StoredTaskRuntime>(this.runtimePath(taskId)),
        );
        const binding = normalizeBindingRecord(
          maybeReadJsonFileSync<StoredTaskBinding>(this.bindingPath(taskId)),
        );

        if (!hasExpiredOrMissingLease(runtime, nowMs)) {
          continue;
        }

        const nextSequence = materialized.currentSequence + 1;
        const runId =
          runtime.lease?.runId ?? readEventRunId(materialized.task);
        const failure = createInterruptedFailureRecord({
          task: materialized.task,
          sequence: nextSequence,
          committedAt: nowIso,
          runId,
          sessionKey: binding?.sessionKey,
        });
        const nextRuntime = releaseLease(
          {
            currentSequence: nextSequence,
            lease: runtime.lease,
          },
          {
            nowIso,
            ownerId: runtime.lease?.ownerId,
            runId,
          },
        );

        this.writeJournalRecordSync(taskId, failure.record);
        writeJsonFileAtomicallySync(this.snapshotPath(taskId), failure.snapshot);
        writeJsonFileAtomicallySync(this.runtimePath(taskId), nextRuntime);
      } catch (error) {
        console.warn("Failed to reconcile orphaned task during startup sweep.", error);
      }
    }
  }

  private listTaskDirectoryNamesSync(): string[] {
    try {
      return readdirSync(this.taskRootPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private normalizeJournalRecord(
    record: StoredTaskJournalRecord,
  ): StoredTaskJournalRecord {
    return {
      sequence: normalizeCurrentSequence(record.sequence),
      committedAt:
        typeof record.committedAt === "string"
          ? record.committedAt
          : new Date().toISOString(),
      event: cloneJournalEvent(record.event),
      provenance: {
        ...(typeof record.provenance?.runId === "string"
          ? { runId: record.provenance.runId }
          : {}),
        ...(typeof record.provenance?.sessionKey === "string"
          ? { sessionKey: record.provenance.sessionKey }
          : {}),
        ...(typeof record.provenance?.agentEventSeq === "number" &&
        Number.isInteger(record.provenance.agentEventSeq)
          ? { agentEventSeq: record.provenance.agentEventSeq }
          : {}),
        ...(typeof record.provenance?.agentEventTs === "number" &&
        Number.isFinite(record.provenance.agentEventTs)
          ? { agentEventTs: record.provenance.agentEventTs }
          : {}),
      },
    };
  }

  private materializeTaskSync(taskId: string): {
    task: Task;
    currentSequence: number;
  } | undefined {
    const snapshot = maybeReadJsonFileSync<Task>(this.snapshotPath(taskId));

    if (!snapshot) {
      return undefined;
    }

    const tail = readNdjsonFileSync<StoredTaskJournalRecord>(this.eventsPath(taskId))
      .map((record) => this.normalizeJournalRecord(record))
      .filter((record) => record.sequence > readTaskCurrentSequence(snapshot));

    return foldTaskJournalOntoSnapshot(snapshot, tail);
  }

  private writeJournalRecordSync(
    taskId: string,
    record: StoredTaskJournalRecord,
  ): void {
    mkdirSync(this.taskDirectory(taskId), { recursive: true });
    writeFileSync(this.eventsPath(taskId), `${JSON.stringify(record)}\n`, {
      flag: "a",
    });
  }

  private taskDirectory(taskId: string): string {
    return join(this.taskRootPath, encodeTaskStorageId(taskId));
  }

  private filesDirectory(taskId: string): string {
    return join(this.taskDirectory(taskId), "files");
  }

  private artifactFilesDirectory(taskId: string, artifactId: string): string {
    return join(this.filesDirectory(taskId), encodeTaskStorageId(artifactId));
  }

  private artifactFileIndexPath(taskId: string, artifactId: string): string {
    return join(this.artifactFilesDirectory(taskId, artifactId), "index.json");
  }

  private artifactFileDirectory(
    taskId: string,
    artifactId: string,
    fileId: string,
  ): string {
    return join(this.artifactFilesDirectory(taskId, artifactId), fileId);
  }

  private fileDescriptorPath(
    taskId: string,
    artifactId: string,
    fileId: string,
  ): string {
    return join(this.artifactFileDirectory(taskId, artifactId, fileId), "descriptor.json");
  }

  private fileMetaPath(taskId: string, artifactId: string, fileId: string): string {
    return join(this.artifactFileDirectory(taskId, artifactId, fileId), "meta.json");
  }

  private fileBlobPath(taskId: string, artifactId: string, fileId: string): string {
    return join(this.artifactFileDirectory(taskId, artifactId, fileId), "blob");
  }

  private bindingPath(taskId: string): string {
    return join(this.taskDirectory(taskId), "binding.json");
  }

  private snapshotPath(taskId: string): string {
    return join(this.taskDirectory(taskId), "snapshot.json");
  }

  private eventsPath(taskId: string): string {
    return join(this.taskDirectory(taskId), "events.ndjson");
  }

  private runtimePath(taskId: string): string {
    return join(this.taskDirectory(taskId), "runtime.json");
  }

  private async listArtifactDirectoryNames(taskId: string): Promise<string[]> {
    try {
      const entries = await readdir(this.filesDirectory(taskId), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private async listArtifactFileDirectoryNames(
    taskId: string,
    artifactId: string,
  ): Promise<string[]> {
    try {
      const entries = await readdir(this.artifactFilesDirectory(taskId, artifactId), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }
}

class TaskJournalSubscription implements TaskJournalSubscriptionHandle {
  private readonly records: StoredTaskJournalRecord[] = [];
  private readonly waiters = new Set<(record: StoredTaskJournalRecord | undefined) => void>();
  private closed = false;

  constructor(
    private readonly unsubscribe: () => void,
    private readonly afterSequence: number,
  ) {}

  push(record: StoredTaskJournalRecord): void {
    if (this.closed || record.sequence <= this.afterSequence) {
      return;
    }

    const waiter = this.waiters.values().next().value as
      | ((record: StoredTaskJournalRecord | undefined) => void)
      | undefined;

    if (waiter) {
      this.waiters.delete(waiter);
      waiter(cloneJournalRecord(record));
      return;
    }

    this.records.push(cloneJournalRecord(record));
  }

  async next(): Promise<StoredTaskJournalRecord | undefined> {
    if (this.records.length > 0) {
      return this.records.shift();
    }

    if (this.closed) {
      return undefined;
    }

    return new Promise((resolve) => {
      this.waiters.add(resolve);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.unsubscribe();

    for (const waiter of this.waiters) {
      waiter(undefined);
    }

    this.waiters.clear();
    this.records.length = 0;
  }
}

export class A2ATaskRuntimeStore implements TaskStore {
  readonly instanceId = randomUUID();
  readonly kind: A2AInboundTaskStoreConfig["kind"];

  private readonly storage: TaskRuntimeStorage;
  private readonly fetchImpl: TaskFileFetchLike;
  private readonly lookupFn: TaskFileLookupFn;
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly subscribers = new Map<string, Set<TaskRuntimeSubscriber>>();
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pendingBindings = new Map<string, StoredTaskBinding>();
  private readonly pendingRunIds = new Map<string, string>();
  private readonly taskFileDescriptors = new Map<
    string,
    Map<string, Map<string, LiveTaskFileDescriptor>>
  >();
  private readonly taskFileIndexes = new Map<
    string,
    Map<string, LiveTaskArtifactFileIndex>
  >();
  private readonly loadedFileRegistries = new Set<string>();
  private readonly fileMaterializations = new Map<string, Promise<TaskFileDownload>>();

  constructor(
    config: A2AInboundTaskStoreConfig,
    options: TaskStoreOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookupFn = options.lookupFn ?? dnsLookup;

    if (config.kind === "json-file") {
      if (!config.path) {
        throw new Error(
          "taskStore.kind=json-file requires taskStore.path for openclaw-a2a-inbound",
        );
      }

      this.storage = new JsonFileTaskRuntimeStorage(config.path, this.instanceId);
      this.kind = "json-file";
      return;
    }

    this.storage = new MemoryTaskRuntimeStorage();
    this.kind = "memory";
  }

  close(): void {
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }

    this.heartbeatTimers.clear();
    this.subscribers.clear();
    this.pendingBindings.clear();
    this.pendingRunIds.clear();
    this.taskFileDescriptors.clear();
    this.taskFileIndexes.clear();
    this.loadedFileRegistries.clear();
    this.fileMaterializations.clear();
    this.storage.close();
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    return this.enqueueByTask(taskId, async () => {
      return (await this.readMaterializedTask(taskId))?.task;
    });
  }

  async readBinding(taskId: string): Promise<StoredTaskBinding | undefined> {
    return this.enqueueByTask(taskId, async () => {
      return await this.storage.readBinding(taskId);
    });
  }

  async writeBinding(taskId: string, binding: StoredTaskBinding): Promise<void> {
    await this.enqueueByTask(taskId, async () => {
      await this.storage.writeBinding(taskId, binding);
      this.pendingBindings.delete(taskId);
    });
  }

  async loadBinding(taskId: string): Promise<StoredTaskBinding | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const pending = this.pendingBindings.get(taskId);

      if (pending) {
        return cloneTaskBinding(pending);
      }

      return await this.storage.readBinding(taskId);
    });
  }

  primeBinding(taskId: string, binding: StoredTaskBinding): void {
    this.pendingBindings.set(taskId, cloneTaskBinding(binding));
  }

  captureRunId(taskId: string, runId: string | undefined): void {
    if (!runId || runId.trim().length === 0) {
      return;
    }

    this.pendingRunIds.set(taskId, runId.trim());
  }

  discardPending(taskId: string): void {
    this.pendingBindings.delete(taskId);
    this.pendingRunIds.delete(taskId);
    this.taskFileDescriptors.delete(taskId);
    this.taskFileIndexes.delete(taskId);
    this.loadedFileRegistries.delete(taskId);
  }

  async primePersistedFileRegistry(taskId: string): Promise<void> {
    await this.enqueueByTask(taskId, async () => {
      if (this.loadedFileRegistries.has(taskId)) {
        return;
      }

      const registry = await this.storage.readTaskFileRegistry(taskId);

      for (const descriptor of registry.descriptors) {
        this.upsertLiveFileDescriptor(taskId, descriptor.artifactId, descriptor, true);
      }

      for (const index of registry.indexes) {
        this.replaceLiveArtifactFileIndex(taskId, index, true);
      }

      this.loadedFileRegistries.add(taskId);
    });
  }

  registerReplyContentFiles(params: {
    taskId: string;
    artifactId: string;
    publicBaseUrl: string;
    filesBasePath: string;
    content: BuiltReplyContent;
    referencedAt?: string;
  }): BuiltReplyContent {
    const referencedAt = params.referencedAt ?? new Date().toISOString();
    this.loadedFileRegistries.add(params.taskId);

    return mapBuiltReplyContentFiles({
      content: params.content,
      mapFile: (filePart) => {
        const logicalKey = buildTaskFileLogicalKey({
          sourceUri: filePart.sourceUri,
          originalName: filePart.originalName,
          originalMimeType: filePart.originalMimeType,
          occurrenceIndex: filePart.occurrenceIndex,
        });
        const artifactIndex = this.ensureLiveArtifactFileIndex(
          params.taskId,
          params.artifactId,
        );
        let fileId = artifactIndex.fileIdsByLogicalKey.get(logicalKey);

        if (!fileId) {
          fileId = randomUUID();
          artifactIndex.fileIdsByLogicalKey.set(logicalKey, fileId);
          artifactIndex.dirty = true;
        }

        const descriptor = this.upsertLiveFileDescriptor(
          params.taskId,
          params.artifactId,
          {
            fileId,
            artifactId: params.artifactId,
            sourceUri: filePart.sourceUri,
            ...(filePart.originalName ? { originalName: filePart.originalName } : {}),
            ...(filePart.originalMimeType
              ? { originalMimeType: filePart.originalMimeType }
              : {}),
            firstEmittedAt: referencedAt,
            lastReferencedAt: referencedAt,
          },
          false,
        );

        return {
          uri: buildTaskFileUrl({
            publicBaseUrl: params.publicBaseUrl,
            filesBasePath: params.filesBasePath,
            taskId: params.taskId,
            artifactId: params.artifactId,
            fileId: descriptor.fileId,
          }),
          ...(descriptor.originalName ? { name: descriptor.originalName } : {}),
          ...(descriptor.originalMimeType
            ? { mimeType: descriptor.originalMimeType }
            : {}),
        };
      },
    });
  }

  async materializeTaskFile(params: {
    taskId: string;
    artifactId: string;
    fileId: string;
  }): Promise<TaskFileDownload | undefined> {
    const descriptor = await this.readTaskFileDescriptor(params.taskId, params.artifactId, params.fileId);

    if (!descriptor) {
      return undefined;
    }

    const cached = await this.readCachedTaskFile(
      params.taskId,
      params.artifactId,
      params.fileId,
      descriptor,
    );

    if (cached) {
      return cached;
    }

    const flightKey = `${params.taskId}\u001f${params.artifactId}\u001f${params.fileId}`;
    const existingFlight = this.fileMaterializations.get(flightKey);

    if (existingFlight) {
      return await existingFlight;
    }

    const flight = this.fetchAndCacheTaskFile(params, descriptor).finally(() => {
      this.fileMaterializations.delete(flightKey);
    });
    this.fileMaterializations.set(flightKey, flight);

    return await flight;
  }

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    await this.enqueueByTask(task.id, async () => {
      const materialized = await this.readMaterializedTask(task.id);
      const runtime =
        materialized?.runtime ??
        normalizeRuntimeRecord(await this.storage.readRuntime(task.id));
      const pendingBinding = await this.flushPendingBinding(task.id);
      const currentSequence = Math.max(
        materialized?.currentSequence ?? 0,
        readTaskCurrentSequence(task),
      );
      const runId = this.resolveCurrentRunId(task.id, task, runtime);
      const nextTask = withTaskRunId(
        withCurrentSequence(task, currentSequence),
        runId,
      );
      const nextRuntime = withRuntimeRunId(
        {
          ...runtime,
          currentSequence,
        },
        runId,
      );

      if (pendingBinding) {
        await this.storage.writeBinding(task.id, pendingBinding);
        this.pendingBindings.delete(task.id);
      }

      await this.flushDirtyFileRegistry(task.id);
      await this.storage.writeSnapshot(task.id, nextTask);
      await this.storage.writeRuntime(task.id, nextRuntime);
      this.consumePendingRunId(task.id, runId);
    });
  }

  async listTaskIds(): Promise<string[]> {
    return this.storage.listTaskIds();
  }

  async persistIncomingMessage(taskId: string, message: Message): Promise<Task | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const materialized = await this.readMaterializedTask(taskId);

      if (!materialized) {
        return undefined;
      }

      const nextSnapshot = withCurrentSequence(
        ensureHistoryContainsMessage(materialized.task, message),
        materialized.currentSequence,
      );

      await this.storage.writeSnapshot(taskId, nextSnapshot);
      await this.storage.writeRuntime(taskId, {
        ...materialized.runtime,
        currentSequence: materialized.currentSequence,
      });
      return nextSnapshot;
    });
  }

  async commitEvent(
    event: Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
    latestUserMessage?: Message,
  ): Promise<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    if (event.kind === "task") {
      return this.commitTaskSnapshot(event, latestUserMessage);
    }

    return this.commitJournalEvent(event);
  }

  async reconcileOrphanedTask(
    taskId: string,
    hasLiveInProcessOwner: boolean,
  ): Promise<Task | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const materialized = await this.readMaterializedTask(taskId);

      if (
        !materialized ||
        !isActiveExecutionTaskState(materialized.task.status.state) ||
        hasLiveInProcessOwner
      ) {
        return materialized?.task;
      }

      const nowIso = new Date().toISOString();

      if (!hasExpiredOrMissingLease(materialized.runtime, Date.parse(nowIso))) {
        return materialized.task;
      }

      const nextSequence = materialized.currentSequence + 1;
      const binding = await this.storage.readBinding(taskId);
      const runId =
        materialized.runtime.lease?.runId ?? readEventRunId(materialized.task);
      const failure = createInterruptedFailureRecord({
        task: materialized.task,
        sequence: nextSequence,
        committedAt: nowIso,
        runId,
        sessionKey: binding?.sessionKey,
      });
      const nextRuntime = releaseLease(
        {
          currentSequence: nextSequence,
          lease: materialized.runtime.lease,
        },
        {
          nowIso,
          ownerId: materialized.runtime.lease?.ownerId,
          runId,
        },
      );

      await this.flushDirtyFileRegistry(taskId);
      await this.storage.appendEvent(taskId, failure.record);
      await this.storage.writeSnapshot(taskId, failure.snapshot);
      await this.storage.writeRuntime(taskId, nextRuntime);
      this.stopHeartbeat(taskId);
      this.notifySubscribers(taskId, failure.record);
      return failure.snapshot;
    });
  }

  async prepareLiveTail(taskId: string): Promise<PreparedLiveTail | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const materialized = await this.readMaterializedTask(taskId);

      if (!materialized) {
        return undefined;
      }

      const subscription = isActiveExecutionTaskState(materialized.task.status.state)
        ? this.createSubscription(taskId, materialized.currentSequence)
        : undefined;

      return {
        task: materialized.task,
        subscription,
      };
    });
  }

  async prepareReplayTail(
    taskId: string,
    afterSequence: number,
  ): Promise<PreparedReplayTail | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const materialized = await this.readMaterializedTask(taskId);

      if (!materialized) {
        return undefined;
      }

      const events = await this.storage.readEventsAfter(taskId, afterSequence);
      const lastSequence = Math.max(
        afterSequence,
        materialized.currentSequence,
        events.at(-1)?.sequence ?? 0,
      );
      const subscription = isActiveExecutionTaskState(materialized.task.status.state)
        ? this.createSubscription(taskId, lastSequence)
        : undefined;

      return {
        task: materialized.task,
        events,
        subscription,
      };
    });
  }

  async renewLease(taskId: string, runId?: string): Promise<void> {
    await this.enqueueByTask(taskId, async () => {
      const materialized = await this.readMaterializedTask(taskId);

      if (
        !materialized ||
        !isActiveExecutionTaskState(materialized.task.status.state)
      ) {
        this.stopHeartbeat(taskId);
        return;
      }

      const nowIso = new Date().toISOString();
      const nextRuntime = createLease(materialized.currentSequence, {
        ownerId: this.instanceId,
        nowIso,
        ...(runId ?? materialized.runtime.lease?.runId
          ? { runId: runId ?? materialized.runtime.lease?.runId }
          : {}),
      });

      await this.storage.writeRuntime(taskId, nextRuntime);
    });
  }

  replayRecord(record: StoredTaskJournalRecord): JournalEvent {
    return markEventAsReplayed(record.event);
  }

  private async commitTaskSnapshot(
    task: Task,
    latestUserMessage?: Message,
  ): Promise<Task> {
    return this.enqueueByTask(task.id, async () => {
      const materialized = await this.readMaterializedTask(task.id);
      const currentRuntime =
        materialized?.runtime ??
        normalizeRuntimeRecord(await this.storage.readRuntime(task.id));
      const pendingBinding = await this.flushPendingBinding(task.id);
      const binding = pendingBinding ?? (await this.storage.readBinding(task.id));
      const currentSequence = Math.max(
        materialized?.currentSequence ?? 0,
        readTaskCurrentSequence(task),
      );
      const runId = this.resolveCurrentRunId(
        task.id,
        materialized?.task ?? task,
        currentRuntime,
        task,
      );
      const nowIso = new Date().toISOString();
      let nextTask = cloneTask(task);

      if (latestUserMessage) {
        nextTask = ensureHistoryContainsMessage(nextTask, latestUserMessage);
      }

      nextTask = withCurrentSequence(nextTask, currentSequence);
      nextTask = withTaskRunId(nextTask, runId);

      if (pendingBinding) {
        await this.storage.writeBinding(task.id, pendingBinding);
        this.pendingBindings.delete(task.id);
      }

      await this.flushDirtyFileRegistry(task.id);
      await this.storage.writeSnapshot(task.id, nextTask);
      const nextRuntime =
        classifyTaskState(nextTask.status.state) === "active"
          ? createLease(currentSequence, {
              ownerId: this.instanceId,
              nowIso,
              ...(runId ? { runId } : {}),
            })
          : releaseLease(
              {
                currentSequence,
                lease: currentRuntime.lease,
              },
              {
                nowIso,
                ownerId: this.instanceId,
                ...(runId ? { runId } : {}),
              },
            );
      await this.storage.writeRuntime(
        task.id,
        nextRuntime,
      );
      this.consumePendingRunId(task.id, runId);
      this.syncHeartbeat(task.id, nextTask.status.state);
      return nextTask;
    });
  }

  private async commitJournalEvent(event: JournalEvent): Promise<JournalEvent> {
    return this.enqueueByTask(event.taskId, async () => {
      const materialized = await this.readMaterializedTask(event.taskId);

      if (!materialized) {
        throw new Error(`Cannot commit journal event for unknown task ${event.taskId}.`);
      }

      const currentRuntime = materialized.runtime;
      const pendingBinding = await this.flushPendingBinding(event.taskId);
      const binding = pendingBinding ?? (await this.storage.readBinding(event.taskId));
      const nextSequence = materialized.currentSequence + 1;
      const committedAt = new Date().toISOString();
      const decoratedEvent = decorateJournalEvent(event, nextSequence);
      const nextSnapshot =
        decoratedEvent.kind === "status-update"
          ? withCurrentSequence(
              mergeStatus(materialized.task, decoratedEvent),
              nextSequence,
            )
          : withCurrentSequence(
              mergeArtifact(materialized.task, decoratedEvent),
              nextSequence,
            );
      const currentRunId = this.resolveCurrentRunId(
        event.taskId,
        materialized.task,
        currentRuntime,
        event,
      );
      const provenance = buildJournalProvenance({
        event,
        binding,
        runId: currentRunId,
      });
      const snapshotRunId = currentRunId;
      const nextRuntime =
        classifyTaskState(nextSnapshot.status.state) === "active"
          ? createLease(nextSequence, {
              ownerId: this.instanceId,
              nowIso: committedAt,
              ...(currentRunId
                ? { runId: currentRunId }
                : {}),
            })
          : releaseLease(
              {
                currentSequence: nextSequence,
                lease: currentRuntime.lease,
              },
              {
                nowIso: committedAt,
                ownerId: this.instanceId,
                runId: currentRunId,
              },
            );
      const record: StoredTaskJournalRecord = {
        sequence: nextSequence,
        committedAt,
        event: decoratedEvent,
        provenance,
      };

      if (pendingBinding) {
        await this.storage.writeBinding(event.taskId, pendingBinding);
        this.pendingBindings.delete(event.taskId);
      }

      await this.flushDirtyFileRegistry(event.taskId);
      await this.storage.appendEvent(event.taskId, record);
      await this.storage.writeSnapshot(
        event.taskId,
        withTaskRunId(nextSnapshot, snapshotRunId),
      );
      await this.storage.writeRuntime(event.taskId, nextRuntime);

      this.consumePendingRunId(event.taskId, currentRunId);
      this.syncHeartbeat(event.taskId, nextSnapshot.status.state);
      this.notifySubscribers(event.taskId, record);
      return decoratedEvent;
    });
  }

  private async flushPendingBinding(
    taskId: string,
  ): Promise<StoredTaskBinding | undefined> {
    const binding = this.pendingBindings.get(taskId);

    if (!binding) {
      return undefined;
    }

    return cloneTaskBinding(binding);
  }

  private consumePendingRunId(taskId: string, appliedRunId: string | undefined): void {
    const pendingRunId = this.pendingRunIds.get(taskId);

    if (!pendingRunId) {
      return;
    }

    if (!appliedRunId || appliedRunId === pendingRunId) {
      this.pendingRunIds.delete(taskId);
    }
  }

  private resolveCurrentRunId(
    taskId: string,
    task: Task | undefined,
    runtime: StoredTaskRuntime | undefined,
    event?: Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
  ): string | undefined {
    return this.pendingRunIds.get(taskId) ??
      runtime?.lease?.runId ??
      (task ? readEventRunId(task) : undefined) ??
      (event ? readEventRunId(event) : undefined);
  }

  private async readMaterializedTask(
    taskId: string,
  ): Promise<MaterializedTaskState | undefined> {
    const snapshot = await this.storage.readSnapshot(taskId);

    if (!snapshot) {
      return undefined;
    }

    const runtime = normalizeRuntimeRecord(await this.storage.readRuntime(taskId));
    const { task, currentSequence } = foldTaskJournalOntoSnapshot(
      snapshot,
      await this.storage.readEventsAfter(taskId, readTaskCurrentSequence(snapshot)),
    );

    return {
      task: withTaskRunId(task, runtime.lease?.runId),
      currentSequence,
      runtime,
    };
  }

  private ensureLiveArtifactDescriptorMap(
    taskId: string,
    artifactId: string,
  ): Map<string, LiveTaskFileDescriptor> {
    const taskDescriptors = this.taskFileDescriptors.get(taskId) ?? new Map();
    const artifactDescriptors = taskDescriptors.get(artifactId) ?? new Map();

    taskDescriptors.set(artifactId, artifactDescriptors);
    this.taskFileDescriptors.set(taskId, taskDescriptors);

    return artifactDescriptors;
  }

  private ensureLiveArtifactFileIndex(
    taskId: string,
    artifactId: string,
  ): LiveTaskArtifactFileIndex {
    const taskIndexes = this.taskFileIndexes.get(taskId) ?? new Map();
    let artifactIndex = taskIndexes.get(artifactId);

    if (!artifactIndex) {
      artifactIndex = {
        artifactId,
        dirty: true,
        fileIdsByLogicalKey: new Map(),
      };
      taskIndexes.set(artifactId, artifactIndex);
      this.taskFileIndexes.set(taskId, taskIndexes);
    }

    return artifactIndex;
  }

  private replaceLiveArtifactFileIndex(
    taskId: string,
    index: StoredTaskArtifactFileIndex,
    persisted: boolean,
  ): void {
    const taskIndexes = this.taskFileIndexes.get(taskId) ?? new Map();
    taskIndexes.set(index.artifactId, {
      artifactId: index.artifactId,
      dirty: !persisted,
      fileIdsByLogicalKey: new Map(Object.entries(index.fileIdsByLogicalKey)),
    });
    this.taskFileIndexes.set(taskId, taskIndexes);
  }

  private upsertLiveFileDescriptor(
    taskId: string,
    artifactId: string,
    descriptor: StoredTaskFileDescriptor,
    persisted: boolean,
  ): StoredTaskFileDescriptor {
    const artifactDescriptors = this.ensureLiveArtifactDescriptorMap(taskId, artifactId);
    const existing = artifactDescriptors.get(descriptor.fileId);
    const nextDescriptor: LiveTaskFileDescriptor = existing
      ? {
          ...existing,
          sourceUri: descriptor.sourceUri,
          originalName: descriptor.originalName,
          originalMimeType: descriptor.originalMimeType,
          firstEmittedAt: existing.firstEmittedAt,
          lastReferencedAt: descriptor.lastReferencedAt,
          dirty: persisted ? existing.dirty : true,
        }
      : {
          ...descriptor,
          dirty: !persisted,
        };

    artifactDescriptors.set(nextDescriptor.fileId, nextDescriptor);
    return cloneTaskFileDescriptor(nextDescriptor);
  }

  private async flushDirtyFileRegistry(taskId: string): Promise<void> {
    const taskDescriptors = this.taskFileDescriptors.get(taskId);
    const taskIndexes = this.taskFileIndexes.get(taskId);

    if (taskDescriptors) {
      for (const [artifactId, artifactDescriptors] of taskDescriptors.entries()) {
        for (const descriptor of artifactDescriptors.values()) {
          if (!descriptor.dirty) {
            continue;
          }

          await this.storage.writeFileDescriptor(taskId, artifactId, descriptor);
          descriptor.dirty = false;
        }
      }
    }

    if (taskIndexes) {
      for (const artifactIndex of taskIndexes.values()) {
        if (!artifactIndex.dirty) {
          continue;
        }

        await this.storage.writeArtifactFileIndex(taskId, artifactIndex.artifactId, {
          schemaVersion: 1,
          artifactId: artifactIndex.artifactId,
          fileIdsByLogicalKey: Object.fromEntries(artifactIndex.fileIdsByLogicalKey.entries()),
          updatedAt: new Date().toISOString(),
        });
        artifactIndex.dirty = false;
      }
    }
  }

  private async readTaskFileDescriptor(
    taskId: string,
    artifactId: string,
    fileId: string,
  ): Promise<StoredTaskFileDescriptor | undefined> {
    const liveDescriptor = this.taskFileDescriptors.get(taskId)?.get(artifactId)?.get(fileId);

    if (liveDescriptor) {
      return cloneTaskFileDescriptor(liveDescriptor);
    }

    const storedDescriptor = await this.storage.readFileDescriptor(taskId, artifactId, fileId);

    if (!storedDescriptor) {
      return undefined;
    }

    this.upsertLiveFileDescriptor(taskId, artifactId, storedDescriptor, true);
    return storedDescriptor;
  }

  private async readCachedTaskFile(
    taskId: string,
    artifactId: string,
    fileId: string,
    descriptor: StoredTaskFileDescriptor,
  ): Promise<TaskFileDownload | undefined> {
    if (!(await this.storage.blobExists(taskId, artifactId, fileId))) {
      return undefined;
    }

    const meta = await this.storage.readFileMeta(taskId, artifactId, fileId);
    const blobPath = this.storage.blobPath(taskId, artifactId, fileId);
    const blobStats = await stat(blobPath);
    const fileName = meta?.fileName ?? descriptor.originalName;

    return {
      blobPath,
      descriptor,
      ...(meta ? { meta } : {}),
      ...(buildContentDispositionHeader(fileName)
        ? { contentDisposition: buildContentDispositionHeader(fileName) }
        : {}),
      contentLength: blobStats.size,
      contentType: meta?.contentType ?? "application/octet-stream",
    };
  }

  private async fetchAndCacheTaskFile(
    params: {
      taskId: string;
      artifactId: string;
      fileId: string;
    },
    descriptor: StoredTaskFileDescriptor,
  ): Promise<TaskFileDownload> {
    const sourceUrl = this.validateMaterializableSourceUri(descriptor.sourceUri);
    const blobPath = this.storage.blobPath(params.taskId, params.artifactId, params.fileId);
    const tempDirectory = dirname(blobPath);
    const tempPath = join(
      tempDirectory,
      `blob.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    let writer:
      | Awaited<ReturnType<typeof open>>
      | undefined;
    let releaseResponse: (() => Promise<void>) | undefined;
    let blobCommitted = false;

    try {
      await mkdir(tempDirectory, { recursive: true });
      const { response, release } = await this.fetchSourceFile(sourceUrl);
      releaseResponse = release;
      writer = await open(tempPath, "w");
      const reader = response.body?.getReader();
      let size = 0;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          size += value.byteLength;

          if (size > MAX_MATERIALIZED_FILE_BYTES) {
            throw new Error(
              `Upstream payload exceeded ${MAX_MATERIALIZED_FILE_BYTES} bytes.`,
            );
          }

          await writer.write(value);
        }
      }

      await release();
      releaseResponse = undefined;

      await writer.close();
      writer = undefined;
      await rename(tempPath, blobPath);
      blobCommitted = true;

      const meta: StoredTaskFileMeta = {
        schemaVersion: 1,
        size,
        materializedAt: new Date().toISOString(),
        finalUrl: response.url,
        ...(readTrimmedString(response.headers.get("content-type"))
          ? { contentType: readTrimmedString(response.headers.get("content-type")) }
          : {}),
        ...(parseContentDispositionFilename(response.headers.get("content-disposition")) ||
        descriptor.originalName
          ? {
              fileName:
                parseContentDispositionFilename(response.headers.get("content-disposition")) ??
                descriptor.originalName,
            }
          : {}),
      };

      await this.storage.writeFileMeta(
        params.taskId,
        params.artifactId,
        params.fileId,
        meta,
      );

      return {
        blobPath,
        descriptor,
        meta,
        ...(buildContentDispositionHeader(meta.fileName)
          ? { contentDisposition: buildContentDispositionHeader(meta.fileName) }
          : {}),
        contentLength: meta.size,
        contentType: meta.contentType ?? "application/octet-stream",
      };
    } catch (error) {
      await releaseResponse?.().catch(() => undefined);
      await writer?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      if (blobCommitted) {
        await rm(blobPath, { force: true }).catch(() => undefined);
      }
      throw new Error(`Failed to materialize task file: ${String(error)}`);
    }
  }

  private validateMaterializableSourceUri(sourceUri: string): URL {
    let parsed: URL;

    try {
      parsed = new URL(sourceUri);
    } catch {
      throw new Error(`Unsupported source URI "${sourceUri}".`);
    }

    if (parsed.protocol !== "https:") {
      throw new Error(`Unsupported source URI scheme "${parsed.protocol}".`);
    }

    return parsed;
  }

  private async fetchSourceFile(sourceUrl: URL): Promise<{
    response: Response;
    release: () => Promise<void>;
  }> {
    let currentUrl = new URL(sourceUrl);

    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      const guarded = await fetchWithSsrFGuard({
        url: currentUrl.toString(),
        fetchImpl: this.fetchImpl,
        lookupFn: this.lookupFn,
        maxRedirects: 0,
        pinDns: true,
        init: {
          method: "GET",
          redirect: "manual",
        },
      });
      const { response, release } = guarded;

      if (response.status >= 300 && response.status < 400) {
        const location = readTrimmedString(response.headers.get("location"));
        await release();

        if (!location) {
          throw new Error(`Redirect from ${currentUrl} did not include a location header.`);
        }

        if (redirectCount >= 3) {
          throw new Error(`Redirect limit exceeded while fetching ${sourceUrl}.`);
        }

        currentUrl = new URL(location, currentUrl);

        if (currentUrl.protocol !== "https:") {
          throw new Error(`Redirect target "${currentUrl}" did not use https.`);
        }

        continue;
      }

      if (!response.ok) {
        await release();
        throw new Error(`Upstream responded with HTTP ${response.status}.`);
      }

      return {
        response,
        release,
      };
    }

    throw new Error(`Redirect limit exceeded while fetching ${sourceUrl}.`);
  }

  private syncHeartbeat(taskId: string, state: Task["status"]["state"]): void {
    if (isActiveExecutionTaskState(state)) {
      this.startHeartbeat(taskId);
      return;
    }

    this.stopHeartbeat(taskId);
  }

  private enqueueByTask<T>(
    taskId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const guard = next.then(
      () => undefined,
      () => undefined,
    );

    this.taskQueues.set(taskId, guard);

    return next.finally(() => {
      if (this.taskQueues.get(taskId) === guard) {
        this.taskQueues.delete(taskId);
      }
    });
  }

  private createSubscription(
    taskId: string,
    afterSequence: number,
  ): TaskJournalSubscription {
    const listenerSet = this.subscribers.get(taskId) ?? new Set<TaskRuntimeSubscriber>();
    this.subscribers.set(taskId, listenerSet);

    const subscription = new TaskJournalSubscription(() => {
      listenerSet.delete(listener);

      if (listenerSet.size === 0) {
        this.subscribers.delete(taskId);
      }
    }, afterSequence);
    const listener: TaskRuntimeSubscriber = (record) => {
      subscription.push(record);
    };

    listenerSet.add(listener);
    return subscription;
  }

  private notifySubscribers(taskId: string, record: StoredTaskJournalRecord): void {
    const listeners = this.subscribers.get(taskId);

    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      listener(record);
    }
  }

  private startHeartbeat(taskId: string): void {
    if (this.heartbeatTimers.has(taskId)) {
      return;
    }

    const timer = setInterval(() => {
      void this.renewLease(taskId).catch(() => {
        // Lease renewal errors surface on later task access; avoid unhandled rejections.
      });
    }, TASK_HEARTBEAT_INTERVAL_MS);

    timer.unref?.();
    this.heartbeatTimers.set(taskId, timer);
  }

  private stopHeartbeat(taskId: string): void {
    const timer = this.heartbeatTimers.get(taskId);

    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.heartbeatTimers.delete(taskId);
  }
}

function readTaskCurrentSequence(task: Task): number {
  const openclaw = extractOpenClawMetadata(task.metadata);
  return normalizeCurrentSequence(openclaw.currentSequence);
}

export function createTaskStore(
  config: A2AInboundTaskStoreConfig,
  options?: TaskStoreOptions,
): A2ATaskRuntimeStore {
  return new A2ATaskRuntimeStore(config, options);
}
