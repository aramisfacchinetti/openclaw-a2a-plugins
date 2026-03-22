import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import type { A2AInboundTaskStoreConfig } from "./config.js";
import { isActiveExecutionTaskState } from "./response-mapping.js";
import { decodeTaskStorageId, encodeTaskStorageId } from "./storage-id.js";

type JournalEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
type StoredTaskBindingMatchedBy =
  | "binding.peer"
  | "binding.peer.parent"
  | "binding.guild+roles"
  | "binding.guild"
  | "binding.team"
  | "binding.account"
  | "binding.channel"
  | "default";

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

interface StoredTaskRecord {
  schemaVersion: 2;
  task: Task;
  binding?: StoredTaskBinding;
  currentSequence: number;
  journal: StoredCommittedJournalRecord[];
}

interface StoredTaskRecordV1 {
  schemaVersion: 1;
  task: Task;
  binding?: StoredTaskBinding;
}

interface TaskRecordBackend {
  readonly kind: A2AInboundTaskStoreConfig["kind"];
  loadRecord(taskId: string): Promise<StoredTaskRecord | undefined>;
  saveRecord(taskId: string, record: StoredTaskRecord): Promise<void>;
  listTaskIds(): Promise<string[]>;
  close(): void;
}

export interface TaskJournalSubscriptionHandle {
  next(): Promise<JournalEvent | undefined>;
  close(): void;
}

export interface StoredCommittedJournalRecord {
  sequence: number;
  event: JournalEvent;
}

export type PreparedTaskResubscription =
  | {
      kind: "snapshot-only";
      snapshot: Task;
    }
  | {
      kind: "live-tail";
      snapshot: Task;
      subscription: TaskJournalSubscriptionHandle;
    };

type TaskRuntimeSubscriber = (event: JournalEvent) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function cloneStoredCommittedJournalRecord(
  record: StoredCommittedJournalRecord,
): StoredCommittedJournalRecord {
  return {
    sequence: record.sequence,
    event: cloneJournalEvent(record.event),
  };
}

function cloneTaskRecord(record: StoredTaskRecord): StoredTaskRecord {
  return {
    schemaVersion: 2,
    task: cloneTask(record.task),
    ...(record.binding ? { binding: cloneTaskBinding(record.binding) } : {}),
    currentSequence: record.currentSequence,
    journal: record.journal.map(cloneStoredCommittedJournalRecord),
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

function mergeArtifact(task: Task, event: TaskArtifactUpdateEvent): Task {
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

function createStoredTaskRecord(params: {
  task: Task;
  binding?: StoredTaskBinding;
  currentSequence?: number;
  journal?: readonly StoredCommittedJournalRecord[];
}): StoredTaskRecord {
  return {
    schemaVersion: 2,
    task: cloneTask(params.task),
    ...(params.binding ? { binding: cloneTaskBinding(params.binding) } : {}),
    currentSequence: params.currentSequence ?? 0,
    journal: (params.journal ?? []).map(cloneStoredCommittedJournalRecord),
  };
}

function parseStoredTaskRecord(
  raw: string,
  source: string,
): StoredTaskRecord {
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    throw new Error(`Task record ${source} is missing an object payload.`);
  }

  if (!isRecord(parsed.task) || parsed.task.kind !== "task") {
    throw new Error(`Task record ${source} is missing a valid task snapshot.`);
  }

  if (
    "binding" in parsed &&
    typeof parsed.binding !== "undefined" &&
    !isRecord(parsed.binding)
  ) {
    throw new Error(`Task record ${source} contains an invalid binding.`);
  }

  if (parsed.schemaVersion === 1) {
    return createStoredTaskRecord({
      task: parsed.task as unknown as Task,
      binding:
        typeof parsed.binding === "undefined"
          ? undefined
          : (parsed.binding as StoredTaskBinding),
    });
  }

  if (parsed.schemaVersion !== 2) {
    throw new Error(`Task record ${source} is missing schemaVersion 1 or 2.`);
  }

  if (
    typeof parsed.currentSequence !== "number" ||
    !Number.isInteger(parsed.currentSequence) ||
    parsed.currentSequence < 0
  ) {
    throw new Error(`Task record ${source} contains an invalid currentSequence.`);
  }

  if (!Array.isArray(parsed.journal)) {
    throw new Error(`Task record ${source} contains an invalid journal.`);
  }

  const journal: StoredCommittedJournalRecord[] = [];
  let previousSequence = 0;

  for (const entry of parsed.journal) {
    if (!isRecord(entry)) {
      throw new Error(`Task record ${source} contains an invalid journal entry.`);
    }

    if (
      typeof entry.sequence !== "number" ||
      !Number.isInteger(entry.sequence) ||
      entry.sequence <= 0
    ) {
      throw new Error(`Task record ${source} contains an invalid journal sequence.`);
    }

    if (entry.sequence <= previousSequence) {
      throw new Error(`Task record ${source} contains out-of-order journal entries.`);
    }

    if (!isRecord(entry.event)) {
      throw new Error(`Task record ${source} contains an invalid journal event.`);
    }

    const eventKind = entry.event.kind;

    if (
      eventKind !== "status-update" &&
      eventKind !== "artifact-update"
    ) {
      throw new Error(`Task record ${source} contains an invalid journal event kind.`);
    }

    journal.push({
      sequence: entry.sequence,
      event: cloneJournalEvent(entry.event as unknown as JournalEvent),
    });
    previousSequence = entry.sequence;
  }

  if (
    journal.length > 0 &&
    parsed.currentSequence < journal[journal.length - 1]!.sequence
  ) {
    throw new Error(`Task record ${source} currentSequence trails the journal.`);
  }

  return createStoredTaskRecord({
    task: parsed.task as unknown as Task,
    binding:
      typeof parsed.binding === "undefined"
        ? undefined
        : (parsed.binding as StoredTaskBinding),
    currentSequence: parsed.currentSequence,
    journal,
  });
}

class InMemoryTaskRecordBackend implements TaskRecordBackend {
  readonly kind = "memory" as const;

  private readonly records = new Map<string, StoredTaskRecord>();

  async loadRecord(taskId: string): Promise<StoredTaskRecord | undefined> {
    const record = this.records.get(taskId);
    return record ? cloneTaskRecord(record) : undefined;
  }

  async saveRecord(taskId: string, record: StoredTaskRecord): Promise<void> {
    this.records.set(taskId, cloneTaskRecord(record));
  }

  async listTaskIds(): Promise<string[]> {
    return [...this.records.keys()].sort();
  }

  close(): void {
    this.records.clear();
  }
}

class JsonFileTaskRecordBackend implements TaskRecordBackend {
  readonly kind = "json-file" as const;

  private readonly writerLockPath: string;
  private readonly writerLockFd: number;

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.writerLockPath = join(root, ".writer.lock");

    try {
      this.writerLockFd = openSync(this.writerLockPath, "wx");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "EEXIST"
      ) {
        throw new Error(
          `Task store path "${root}" is already locked by another writer.`,
        );
      }

      throw error;
    }

    writeFileSync(
      this.writerLockFd,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    );
  }

  async loadRecord(taskId: string): Promise<StoredTaskRecord | undefined> {
    const path = this.recordPath(taskId);

    try {
      const raw = await readFile(path, "utf8");
      return parseStoredTaskRecord(raw, path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return undefined;
      }

      throw error;
    }
  }

  async saveRecord(taskId: string, record: StoredTaskRecord): Promise<void> {
    const path = this.recordPath(taskId);
    const tempPath = join(
      this.root,
      `.${basename(path)}.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(
        tempPath,
        `${JSON.stringify(cloneTaskRecord(record), null, 2)}\n`,
        "utf8",
      );
      await rename(tempPath, path);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async listTaskIds(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const taskIds: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const taskId = decodeTaskStorageId(entry.name.slice(0, -".json".length));

      if (taskId) {
        taskIds.push(taskId);
      }
    }

    taskIds.sort();
    return taskIds;
  }

  close(): void {
    try {
      closeSync(this.writerLockFd);
    } catch {
      // Ignore close failures during shutdown.
    }

    try {
      unlinkSync(this.writerLockPath);
    } catch {
      // Ignore unlink failures during shutdown.
    }
  }

  private recordPath(taskId: string): string {
    return join(this.root, `${encodeTaskStorageId(taskId)}.json`);
  }
}

function createTaskRecordBackend(
  config: A2AInboundTaskStoreConfig,
): TaskRecordBackend {
  if (config.kind === "json-file") {
    return new JsonFileTaskRecordBackend(config.path);
  }

  return new InMemoryTaskRecordBackend();
}

class TaskJournalSubscription implements TaskJournalSubscriptionHandle {
  private readonly events: JournalEvent[] = [];
  private readonly waiters = new Set<(event: JournalEvent | undefined) => void>();
  private closed = false;

  constructor(private readonly unsubscribe: () => void) {}

  push(event: JournalEvent): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.values().next().value as
      | ((event: JournalEvent | undefined) => void)
      | undefined;

    if (waiter) {
      this.waiters.delete(waiter);
      waiter(cloneJournalEvent(event));
      return;
    }

    this.events.push(cloneJournalEvent(event));
  }

  async next(): Promise<JournalEvent | undefined> {
    if (this.events.length > 0) {
      return this.events.shift();
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
    this.events.length = 0;
  }
}

export class A2ATaskRuntimeStore implements TaskStore {
  readonly kind: A2AInboundTaskStoreConfig["kind"];

  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly subscribers = new Map<string, Set<TaskRuntimeSubscriber>>();
  private readonly subscriptions = new Set<TaskJournalSubscription>();
  private readonly pendingBindings = new Map<string, StoredTaskBinding>();

  constructor(private readonly backend: TaskRecordBackend) {
    this.kind = backend.kind;
  }

  close(): void {
    for (const subscription of this.subscriptions) {
      subscription.close();
    }

    this.subscriptions.clear();
    this.subscribers.clear();
    this.pendingBindings.clear();
    this.backend.close();
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const record = await this.backend.loadRecord(taskId);
      return record ? cloneTask(record.task) : undefined;
    });
  }

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    await this.enqueueByTask(task.id, async () => {
      const currentRecord = await this.backend.loadRecord(task.id);
      const binding =
        this.flushPendingBinding(task.id) ?? currentRecord?.binding;

      await this.backend.saveRecord(
        task.id,
        createStoredTaskRecord({
          task,
          binding,
          currentSequence: currentRecord?.currentSequence,
          journal: currentRecord?.journal,
        }),
      );
      this.pendingBindings.delete(task.id);
    });
  }

  async listTaskIds(): Promise<string[]> {
    await Promise.all(this.taskQueues.values());
    return this.backend.listTaskIds();
  }

  async readBinding(taskId: string): Promise<StoredTaskBinding | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const binding = (await this.backend.loadRecord(taskId))?.binding;
      return binding ? cloneTaskBinding(binding) : undefined;
    });
  }

  async writeBinding(taskId: string, binding: StoredTaskBinding): Promise<void> {
    await this.enqueueByTask(taskId, async () => {
      const taskRecord = await this.backend.loadRecord(taskId);

      if (!taskRecord) {
        this.pendingBindings.set(taskId, cloneTaskBinding(binding));
        return;
      }

      await this.backend.saveRecord(
        taskId,
        createStoredTaskRecord({
          task: taskRecord.task,
          binding,
          currentSequence: taskRecord.currentSequence,
          journal: taskRecord.journal,
        }),
      );
      this.pendingBindings.delete(taskId);
    });
  }

  async loadBinding(taskId: string): Promise<StoredTaskBinding | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const pending = this.pendingBindings.get(taskId);

      if (pending) {
        return cloneTaskBinding(pending);
      }

      const binding = (await this.backend.loadRecord(taskId))?.binding;
      return binding ? cloneTaskBinding(binding) : undefined;
    });
  }

  primeBinding(taskId: string, binding: StoredTaskBinding): void {
    this.pendingBindings.set(taskId, cloneTaskBinding(binding));
  }

  discardPending(taskId: string): void {
    this.pendingBindings.delete(taskId);
  }

  async persistIncomingMessage(taskId: string, message: Message): Promise<Task | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const taskRecord = await this.backend.loadRecord(taskId);

      if (!taskRecord) {
        return undefined;
      }

      const nextTask = ensureHistoryContainsMessage(taskRecord.task, message);

      await this.backend.saveRecord(
        taskId,
        createStoredTaskRecord({
          task: nextTask,
          binding: taskRecord.binding,
          currentSequence: taskRecord.currentSequence,
          journal: taskRecord.journal,
        }),
      );

      return cloneTask(nextTask);
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

  async subscribeToCommittedTail(
    taskId: string,
  ): Promise<TaskJournalSubscriptionHandle | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const taskRecord = await this.backend.loadRecord(taskId);

      if (!taskRecord || !isActiveExecutionTaskState(taskRecord.task.status.state)) {
        return undefined;
      }

      return this.createSubscription(taskId);
    });
  }

  async prepareResubscribe(
    taskId: string,
    options: {
      allowLiveTail: boolean;
    },
  ): Promise<PreparedTaskResubscription | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const taskRecord = await this.backend.loadRecord(taskId);

      if (!taskRecord) {
        return undefined;
      }

      if (
        !isActiveExecutionTaskState(taskRecord.task.status.state) ||
        !options.allowLiveTail
      ) {
        return {
          kind: "snapshot-only",
          snapshot: cloneTask(taskRecord.task),
        };
      }

      return {
        kind: "live-tail",
        snapshot: cloneTask(taskRecord.task),
        subscription: this.createSubscription(taskId),
      };
    });
  }

  private async commitTaskSnapshot(
    task: Task,
    latestUserMessage?: Message,
  ): Promise<Task> {
    return this.enqueueByTask(task.id, async () => {
      const currentRecord = await this.backend.loadRecord(task.id);
      const binding =
        this.flushPendingBinding(task.id) ?? currentRecord?.binding;
      let nextTask = cloneTask(task);

      if (latestUserMessage) {
        nextTask = ensureHistoryContainsMessage(nextTask, latestUserMessage);
      }

      await this.backend.saveRecord(
        task.id,
        createStoredTaskRecord({
          task: nextTask,
          binding,
          currentSequence: currentRecord?.currentSequence,
          journal: currentRecord?.journal,
        }),
      );
      this.pendingBindings.delete(task.id);
      return cloneTask(nextTask);
    });
  }

  private async commitJournalEvent(event: JournalEvent): Promise<JournalEvent> {
    return this.enqueueByTask(event.taskId, async () => {
      const taskRecord = await this.backend.loadRecord(event.taskId);

      if (!taskRecord) {
        throw new Error(`Cannot commit journal event for unknown task ${event.taskId}.`);
      }

      const binding =
        this.flushPendingBinding(event.taskId) ?? taskRecord.binding;
      const committedEvent = cloneJournalEvent(event);
      const nextSequence = taskRecord.currentSequence + 1;
      const journalRecord: StoredCommittedJournalRecord = {
        sequence: nextSequence,
        event: committedEvent,
      };
      const nextTask =
        committedEvent.kind === "status-update"
          ? mergeStatus(taskRecord.task, committedEvent)
          : mergeArtifact(taskRecord.task, committedEvent);

      await this.backend.saveRecord(
        event.taskId,
        createStoredTaskRecord({
          task: nextTask,
          binding,
          currentSequence: nextSequence,
          journal: [...taskRecord.journal, journalRecord],
        }),
      );
      this.pendingBindings.delete(event.taskId);
      this.notifySubscribers(event.taskId, committedEvent);
      return cloneJournalEvent(committedEvent);
    });
  }

  private flushPendingBinding(
    taskId: string,
  ): StoredTaskBinding | undefined {
    const binding = this.pendingBindings.get(taskId);
    return binding ? cloneTaskBinding(binding) : undefined;
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

  private createSubscription(taskId: string): TaskJournalSubscription {
    const listenerSet = this.subscribers.get(taskId) ?? new Set<TaskRuntimeSubscriber>();
    this.subscribers.set(taskId, listenerSet);

    let subscription: TaskJournalSubscription;
    const listener: TaskRuntimeSubscriber = (event) => {
      subscription.push(event);
    };

    subscription = new TaskJournalSubscription(() => {
      listenerSet.delete(listener);

      if (listenerSet.size === 0) {
        this.subscribers.delete(taskId);
      }

      this.subscriptions.delete(subscription);
    });

    listenerSet.add(listener);
    this.subscriptions.add(subscription);
    return subscription;
  }

  private notifySubscribers(taskId: string, event: JournalEvent): void {
    const listeners = this.subscribers.get(taskId);

    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }
}

export function createTaskStore(
  config: A2AInboundTaskStoreConfig = { kind: "memory" },
): A2ATaskRuntimeStore {
  return new A2ATaskRuntimeStore(createTaskRecordBackend(config));
}
