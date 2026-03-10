import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { isActiveExecutionTaskState } from "./response-mapping.js";

type JsonRecord = Record<string, unknown>;
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

type InMemoryTaskRecord = {
  task: Task;
  binding?: StoredTaskBinding;
  currentSequence: number;
  committedEvents: StoredTaskJournalRecord[];
};

function isRecord(value: unknown): value is JsonRecord {
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

function cloneJournalRecord(record: StoredTaskJournalRecord): StoredTaskJournalRecord {
  return structuredClone(record);
}

function normalizeCurrentSequence(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : 0;
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

function readTaskCurrentSequence(task: Task): number {
  const openclaw = extractOpenClawMetadata(task.metadata);
  return normalizeCurrentSequence(openclaw.currentSequence);
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

function buildJournalProvenance(params: {
  event: Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
  binding?: StoredTaskBinding;
  runId?: string;
}): TaskEventProvenance {
  return {
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.binding?.sessionKey ? { sessionKey: params.binding.sessionKey } : {}),
    ...readEventProvenanceMetadata(params.event),
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
  readonly kind = "memory" as const;

  private readonly tasks = new Map<string, InMemoryTaskRecord>();
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly subscribers = new Map<string, Set<TaskRuntimeSubscriber>>();
  private readonly subscriptions = new Set<TaskJournalSubscription>();
  private readonly pendingBindings = new Map<string, StoredTaskBinding>();
  private readonly pendingRunIds = new Map<string, string>();

  close(): void {
    for (const subscription of this.subscriptions) {
      subscription.close();
    }

    this.subscriptions.clear();
    this.subscribers.clear();
    this.pendingBindings.clear();
    this.pendingRunIds.clear();
    this.tasks.clear();
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const record = this.tasks.get(taskId);
      return record ? cloneTask(record.task) : undefined;
    });
  }

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    await this.enqueueByTask(task.id, async () => {
      const currentRecord = this.tasks.get(task.id);
      const binding = await this.flushPendingBinding(task.id) ?? currentRecord?.binding;
      const currentSequence = Math.max(
        currentRecord?.currentSequence ?? 0,
        readTaskCurrentSequence(task),
      );
      const runId = this.resolveCurrentRunId(task.id, currentRecord?.task ?? task, task);
      const nextTask = withTaskRunId(
        withCurrentSequence(task, currentSequence),
        runId,
      );

      this.tasks.set(task.id, {
        task: cloneTask(nextTask),
        ...(binding ? { binding: cloneTaskBinding(binding) } : {}),
        currentSequence,
        committedEvents: currentRecord
          ? currentRecord.committedEvents.map((record) => cloneJournalRecord(record))
          : [],
      });
      this.pendingBindings.delete(task.id);
      this.consumePendingRunId(task.id, runId);
    });
  }

  async listTaskIds(): Promise<string[]> {
    return [...this.tasks.keys()];
  }

  async readBinding(taskId: string): Promise<StoredTaskBinding | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const binding = this.tasks.get(taskId)?.binding;
      return binding ? cloneTaskBinding(binding) : undefined;
    });
  }

  async writeBinding(taskId: string, binding: StoredTaskBinding): Promise<void> {
    await this.enqueueByTask(taskId, async () => {
      const taskRecord = this.tasks.get(taskId);

      if (!taskRecord) {
        this.pendingBindings.set(taskId, cloneTaskBinding(binding));
        return;
      }

      this.tasks.set(taskId, {
        task: cloneTask(taskRecord.task),
        binding: cloneTaskBinding(binding),
        currentSequence: taskRecord.currentSequence,
        committedEvents: taskRecord.committedEvents.map((record) => cloneJournalRecord(record)),
      });
      this.pendingBindings.delete(taskId);
    });
  }

  async loadBinding(taskId: string): Promise<StoredTaskBinding | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const pending = this.pendingBindings.get(taskId);

      if (pending) {
        return cloneTaskBinding(pending);
      }

      const binding = this.tasks.get(taskId)?.binding;
      return binding ? cloneTaskBinding(binding) : undefined;
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
  }

  async persistIncomingMessage(taskId: string, message: Message): Promise<Task | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const taskRecord = this.tasks.get(taskId);

      if (!taskRecord) {
        return undefined;
      }

      const nextTask = withCurrentSequence(
        ensureHistoryContainsMessage(taskRecord.task, message),
        taskRecord.currentSequence,
      );

      this.tasks.set(taskId, {
        task: cloneTask(nextTask),
        ...(taskRecord.binding ? { binding: cloneTaskBinding(taskRecord.binding) } : {}),
        currentSequence: taskRecord.currentSequence,
        committedEvents: taskRecord.committedEvents.map((record) => cloneJournalRecord(record)),
      });

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

  async prepareLiveTail(taskId: string): Promise<PreparedLiveTail | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const taskRecord = this.tasks.get(taskId);

      if (!taskRecord) {
        return undefined;
      }

      const subscription = isActiveExecutionTaskState(taskRecord.task.status.state)
        ? this.createSubscription(taskId, taskRecord.currentSequence)
        : undefined;

      return {
        task: cloneTask(taskRecord.task),
        subscription,
      };
    });
  }

  async prepareReplayTail(
    taskId: string,
    afterSequence: number,
  ): Promise<PreparedReplayTail | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const taskRecord = this.tasks.get(taskId);

      if (!taskRecord) {
        return undefined;
      }

      const events = taskRecord.committedEvents
        .filter((record) => record.sequence > afterSequence)
        .map((record) => cloneJournalRecord(record));
      const lastSequence = Math.max(
        afterSequence,
        taskRecord.currentSequence,
        events.at(-1)?.sequence ?? 0,
      );
      const subscription = isActiveExecutionTaskState(taskRecord.task.status.state)
        ? this.createSubscription(taskId, lastSequence)
        : undefined;

      return {
        task: cloneTask(taskRecord.task),
        events,
        subscription,
      };
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
      const currentRecord = this.tasks.get(task.id);
      const binding = await this.flushPendingBinding(task.id) ?? currentRecord?.binding;
      const currentSequence = Math.max(
        currentRecord?.currentSequence ?? 0,
        readTaskCurrentSequence(task),
      );
      const runId = this.resolveCurrentRunId(
        task.id,
        currentRecord?.task ?? task,
        task,
      );
      let nextTask = cloneTask(task);

      if (latestUserMessage) {
        nextTask = ensureHistoryContainsMessage(nextTask, latestUserMessage);
      }

      nextTask = withTaskRunId(
        withCurrentSequence(nextTask, currentSequence),
        runId,
      );

      this.tasks.set(task.id, {
        task: cloneTask(nextTask),
        ...(binding ? { binding: cloneTaskBinding(binding) } : {}),
        currentSequence,
        committedEvents: currentRecord
          ? currentRecord.committedEvents.map((record) => cloneJournalRecord(record))
          : [],
      });
      this.pendingBindings.delete(task.id);
      this.consumePendingRunId(task.id, runId);
      return cloneTask(nextTask);
    });
  }

  private async commitJournalEvent(event: JournalEvent): Promise<JournalEvent> {
    return this.enqueueByTask(event.taskId, async () => {
      const taskRecord = this.tasks.get(event.taskId);

      if (!taskRecord) {
        throw new Error(`Cannot commit journal event for unknown task ${event.taskId}.`);
      }

      const binding = await this.flushPendingBinding(event.taskId) ?? taskRecord.binding;
      const nextSequence = taskRecord.currentSequence + 1;
      const committedAt = new Date().toISOString();
      const decoratedEvent = decorateJournalEvent(event, nextSequence);
      const nextTask = withTaskRunId(
        withCurrentSequence(
          decoratedEvent.kind === "status-update"
            ? mergeStatus(taskRecord.task, decoratedEvent)
            : mergeArtifact(taskRecord.task, decoratedEvent),
          nextSequence,
        ),
        this.resolveCurrentRunId(event.taskId, taskRecord.task, event),
      );
      const record: StoredTaskJournalRecord = {
        sequence: nextSequence,
        committedAt,
        event: decoratedEvent,
        provenance: buildJournalProvenance({
          event,
          binding,
          runId: readEventRunId(nextTask),
        }),
      };

      this.tasks.set(event.taskId, {
        task: cloneTask(nextTask),
        ...(binding ? { binding: cloneTaskBinding(binding) } : {}),
        currentSequence: nextSequence,
        committedEvents: [
          ...taskRecord.committedEvents.map((entry) => cloneJournalRecord(entry)),
          cloneJournalRecord(record),
        ],
      });
      this.pendingBindings.delete(event.taskId);
      this.consumePendingRunId(event.taskId, readEventRunId(nextTask));
      this.notifySubscribers(event.taskId, record);
      return cloneJournalEvent(decoratedEvent);
    });
  }

  private async flushPendingBinding(
    taskId: string,
  ): Promise<StoredTaskBinding | undefined> {
    const binding = this.pendingBindings.get(taskId);
    return binding ? cloneTaskBinding(binding) : undefined;
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
    event?: Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
  ): string | undefined {
    return this.pendingRunIds.get(taskId) ??
      (task ? readEventRunId(task) : undefined) ??
      (event ? readEventRunId(event) : undefined);
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

    let subscription: TaskJournalSubscription;
    const listener: TaskRuntimeSubscriber = (record) => {
      subscription.push(record);
    };

    subscription = new TaskJournalSubscription(() => {
      listenerSet.delete(listener);

      if (listenerSet.size === 0) {
        this.subscribers.delete(taskId);
      }

      this.subscriptions.delete(subscription);
    }, afterSequence);

    listenerSet.add(listener);
    this.subscriptions.add(subscription);
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
}

export function createTaskStore(): A2ATaskRuntimeStore {
  return new A2ATaskRuntimeStore();
}
