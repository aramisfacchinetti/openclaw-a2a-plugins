import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { isActiveExecutionTaskState } from "./response-mapping.js";

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

export interface TaskJournalSubscriptionHandle {
  next(): Promise<JournalEvent | undefined>;
  close(): void;
}

type TaskRuntimeSubscriber = (event: JournalEvent) => void;

type PreparedLiveTail = {
  subscription?: TaskJournalSubscriptionHandle;
  task: Task;
};

type InMemoryTaskRecord = {
  task: Task;
  binding?: StoredTaskBinding;
};

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
  readonly kind = "memory" as const;

  private readonly tasks = new Map<string, InMemoryTaskRecord>();
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly subscribers = new Map<string, Set<TaskRuntimeSubscriber>>();
  private readonly subscriptions = new Set<TaskJournalSubscription>();
  private readonly pendingBindings = new Map<string, StoredTaskBinding>();

  close(): void {
    for (const subscription of this.subscriptions) {
      subscription.close();
    }

    this.subscriptions.clear();
    this.subscribers.clear();
    this.pendingBindings.clear();
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

      this.tasks.set(task.id, {
        task: cloneTask(task),
        ...(binding ? { binding: cloneTaskBinding(binding) } : {}),
      });
      this.pendingBindings.delete(task.id);
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

  discardPending(taskId: string): void {
    this.pendingBindings.delete(taskId);
  }

  async persistIncomingMessage(taskId: string, message: Message): Promise<Task | undefined> {
    return this.enqueueByTask(taskId, async () => {
      const taskRecord = this.tasks.get(taskId);

      if (!taskRecord) {
        return undefined;
      }

      const nextTask = ensureHistoryContainsMessage(taskRecord.task, message);

      this.tasks.set(taskId, {
        task: cloneTask(nextTask),
        ...(taskRecord.binding ? { binding: cloneTaskBinding(taskRecord.binding) } : {}),
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
        ? this.createSubscription(taskId)
        : undefined;

      return {
        task: cloneTask(taskRecord.task),
        subscription,
      };
    });
  }

  private async commitTaskSnapshot(
    task: Task,
    latestUserMessage?: Message,
  ): Promise<Task> {
    return this.enqueueByTask(task.id, async () => {
      const currentRecord = this.tasks.get(task.id);
      const binding = await this.flushPendingBinding(task.id) ?? currentRecord?.binding;
      let nextTask = cloneTask(task);

      if (latestUserMessage) {
        nextTask = ensureHistoryContainsMessage(nextTask, latestUserMessage);
      }

      this.tasks.set(task.id, {
        task: cloneTask(nextTask),
        ...(binding ? { binding: cloneTaskBinding(binding) } : {}),
      });
      this.pendingBindings.delete(task.id);
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
      const committedEvent = cloneJournalEvent(event);
      const nextTask =
        committedEvent.kind === "status-update"
          ? mergeStatus(taskRecord.task, committedEvent)
          : mergeArtifact(taskRecord.task, committedEvent);

      this.tasks.set(event.taskId, {
        task: cloneTask(nextTask),
        ...(binding ? { binding: cloneTaskBinding(binding) } : {}),
      });
      this.pendingBindings.delete(event.taskId);
      this.notifySubscribers(event.taskId, committedEvent);
      return cloneJournalEvent(committedEvent);
    });
  }

  private async flushPendingBinding(
    taskId: string,
  ): Promise<StoredTaskBinding | undefined> {
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

export function createTaskStore(): A2ATaskRuntimeStore {
  return new A2ATaskRuntimeStore();
}
