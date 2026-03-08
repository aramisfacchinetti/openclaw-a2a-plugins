import { randomUUID } from "node:crypto";
import type {
  AgentCard,
  DeleteTaskPushNotificationConfigParams,
  GetTaskPushNotificationConfigParams,
  ListTaskPushNotificationConfigParams,
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import {
  A2AError,
  DefaultExecutionEventBus,
  DefaultRequestHandler,
  ExecutionEventQueue,
  RequestContext,
  ServerCallContext,
  type AgentExecutionEvent,
  type AgentExecutor,
} from "@a2a-js/sdk/server";
import { isTerminalTaskState, createTaskSnapshot, createTaskStatusUpdate } from "./response-mapping.js";
import type { A2ALiveExecutionRegistry } from "./live-execution-registry.js";
import {
  A2ATaskRuntimeStore,
  type TaskJournalSubscriptionHandle,
} from "./task-store.js";

type StreamEvent = Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | Message;

function trimTaskHistory(task: Task, historyLength: number | undefined): Task {
  const nextTask = structuredClone(task) as Task;

  if (typeof historyLength === "number" && historyLength >= 0) {
    nextTask.history = nextTask.history?.slice(-historyLength);
    return nextTask;
  }

  nextTask.history = [];
  return nextTask;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAfterSequence(metadata: unknown): number | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  const openclaw = metadata.openclaw;

  if (!isRecord(openclaw) || !("afterSequence" in openclaw)) {
    return undefined;
  }

  const afterSequence = openclaw.afterSequence;

  if (
    typeof afterSequence !== "number" ||
    !Number.isFinite(afterSequence) ||
    !Number.isInteger(afterSequence) ||
    afterSequence < 0
  ) {
    throw A2AError.invalidParams(
      "params.metadata.openclaw.afterSequence must be a non-negative integer.",
    );
  }

  return afterSequence;
}

function shouldResolveFirstResult(event: StreamEvent): event is Message | Task {
  return event.kind === "message" || event.kind === "task";
}

function isFinalTaskEvent(event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent): boolean {
  return event.kind === "status-update" && event.final === true;
}

export class A2AInboundRequestHandler {
  constructor(
    private readonly base: DefaultRequestHandler,
    private readonly taskRuntime: A2ATaskRuntimeStore,
    private readonly liveExecutions: A2ALiveExecutionRegistry,
    private readonly streamingEnabled: boolean,
    private readonly agentExecutor: AgentExecutor,
  ) {}

  getAgentCard(): Promise<AgentCard> {
    return this.base.getAgentCard();
  }

  getAuthenticatedExtendedAgentCard(
    context?: ServerCallContext,
  ): Promise<AgentCard> {
    return this.base.getAuthenticatedExtendedAgentCard(context);
  }

  async sendMessage(
    params: MessageSendParams,
    context?: ServerCallContext,
  ): Promise<Message | Task> {
    const prepared = this.prepareParams(params);
    const requestId = prepared.message.messageId;

    if (!requestId) {
      throw A2AError.invalidParams("message.messageId is required.");
    }

    const blocking = prepared.configuration?.blocking !== false;
    this.liveExecutions.setRequestMode(
      requestId,
      blocking ? "blocking" : "non_blocking",
    );

    try {
      const requestContext = await this.createRequestContext(prepared.message, context);
      const eventBus = new DefaultExecutionEventBus();
      const eventQueue = new ExecutionEventQueue(eventBus);

      this.executeWithFallback(requestContext, eventBus);

      if (blocking) {
        const result = await this.processBlockingExecution({
          eventQueue,
          latestUserMessage: prepared.message,
          taskId: requestContext.taskId,
          context,
        });

        return result;
      }

      return await this.processNonBlockingExecution({
        eventQueue,
        latestUserMessage: prepared.message,
        taskId: requestContext.taskId,
        context,
      });
    } finally {
      this.liveExecutions.clearRequestMode(requestId);
    }
  }

  async *sendMessageStream(
    params: MessageSendParams,
    context?: ServerCallContext,
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
    void,
    undefined
  > {
    if (!this.streamingEnabled) {
      throw A2AError.unsupportedOperation(
        "Streaming is not enabled for this A2A inbound account.",
      );
    }

    const prepared = this.prepareParams(params);
    const requestId = prepared.message.messageId;

    if (!requestId) {
      throw A2AError.invalidParams("message.messageId is required for streaming.");
    }

    this.liveExecutions.setRequestMode(requestId, "streaming");

    try {
      const requestContext = await this.createRequestContext(prepared.message, context);
      const eventBus = new DefaultExecutionEventBus();
      const eventQueue = new ExecutionEventQueue(eventBus);

      this.executeWithFallback(requestContext, eventBus);

      for await (const event of eventQueue.events()) {
        yield await this.commitExecutionEvent(event, prepared.message);
      }
    } finally {
      this.liveExecutions.clearRequestMode(requestId);
    }
  }

  async getTask(
    params: TaskQueryParams,
    context?: ServerCallContext,
  ): Promise<Task> {
    const task = await this.taskRuntime.load(params.id, context);

    if (!task) {
      throw A2AError.taskNotFound(params.id);
    }

    const reconciled =
      (await this.taskRuntime.reconcileOrphanedTask(
        params.id,
        this.liveExecutions.has(params.id),
      )) ?? task;

    return trimTaskHistory(reconciled, params.historyLength);
  }

  async cancelTask(
    params: TaskIdParams,
    context?: ServerCallContext,
  ): Promise<Task> {
    const task = await this.taskRuntime.load(params.id, context);

    if (!task) {
      throw A2AError.taskNotFound(params.id);
    }

    const reconciled =
      (await this.taskRuntime.reconcileOrphanedTask(
        params.id,
        this.liveExecutions.has(params.id),
      )) ?? task;

    if (isTerminalTaskState(reconciled.status.state)) {
      return reconciled;
    }

    if (!this.liveExecutions.has(params.id)) {
      throw A2AError.unsupportedOperation(
        "Task cancellation is only available while the task is live in this process.",
      );
    }

    await this.agentExecutor.cancelTask(params.id, new DefaultExecutionEventBus());

    let latestTask = await this.taskRuntime.load(params.id, context);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (latestTask && isTerminalTaskState(latestTask.status.state)) {
        return latestTask;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
      latestTask = await this.taskRuntime.load(params.id, context);
    }

    if (!latestTask) {
      throw A2AError.internalError(
        `Task ${params.id} not found after cancellation.`,
      );
    }

    if (isTerminalTaskState(latestTask.status.state)) {
      return latestTask;
    }

    throw A2AError.taskNotCancelable(params.id);
  }

  setTaskPushNotificationConfig(
    params: TaskPushNotificationConfig,
    context?: ServerCallContext,
  ): Promise<TaskPushNotificationConfig> {
    return this.base.setTaskPushNotificationConfig(params, context);
  }

  getTaskPushNotificationConfig(
    params: TaskIdParams | GetTaskPushNotificationConfigParams,
    context?: ServerCallContext,
  ): Promise<TaskPushNotificationConfig> {
    return this.base.getTaskPushNotificationConfig(params, context);
  }

  listTaskPushNotificationConfigs(
    params: ListTaskPushNotificationConfigParams,
    context?: ServerCallContext,
  ): Promise<TaskPushNotificationConfig[]> {
    return this.base.listTaskPushNotificationConfigs(params, context);
  }

  deleteTaskPushNotificationConfig(
    params: DeleteTaskPushNotificationConfigParams,
    context?: ServerCallContext,
  ): Promise<void> {
    return this.base.deleteTaskPushNotificationConfig(params, context);
  }

  async *resubscribe(
    params: TaskIdParams,
    context?: ServerCallContext,
  ): AsyncGenerator<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent, void, undefined> {
    if (!this.streamingEnabled) {
      throw A2AError.unsupportedOperation(
        "Streaming is not enabled for this A2A inbound account.",
      );
    }

    const initialTask = await this.taskRuntime.load(params.id, context);

    if (!initialTask) {
      throw A2AError.taskNotFound(params.id);
    }

    const afterSequence = parseAfterSequence(params.metadata);
    await this.taskRuntime.reconcileOrphanedTask(
      params.id,
      this.liveExecutions.has(params.id),
    );

    if (typeof afterSequence === "number") {
      const prepared = await this.taskRuntime.prepareReplayTail(
        params.id,
        afterSequence,
      );

      if (!prepared) {
        throw A2AError.taskNotFound(params.id);
      }

      for (const record of prepared.events.filter(
        (entry) => entry.sequence > afterSequence,
      )) {
        yield this.taskRuntime.replayRecord(record);
      }

      if (isTerminalTaskState(prepared.task.status.state)) {
        return;
      }

      if (!prepared.subscription) {
        return;
      }

      yield* this.consumeCommittedTail(prepared.subscription);
      return;
    }

    const prepared = await this.taskRuntime.prepareLiveTail(params.id);

    if (!prepared) {
      throw A2AError.taskNotFound(params.id);
    }

    yield prepared.task;

    if (isTerminalTaskState(prepared.task.status.state) || !prepared.subscription) {
      return;
    }

    yield* this.consumeCommittedTail(prepared.subscription);
  }

  private prepareParams(params: MessageSendParams): MessageSendParams {
    return params;
  }

  private async processBlockingExecution(params: {
    eventQueue: ExecutionEventQueue;
    latestUserMessage: Message;
    taskId: string;
    context?: ServerCallContext;
  }): Promise<Message | Task> {
    let finalMessage: Message | undefined;

    for await (const event of params.eventQueue.events()) {
      const committed = await this.commitExecutionEvent(
        event,
        params.latestUserMessage,
      );

      if (committed.kind === "message") {
        finalMessage = committed;
      }
    }

    if (finalMessage) {
      return finalMessage;
    }

    const latestTask = await this.taskRuntime.load(params.taskId, params.context);

    if (!latestTask) {
      throw A2AError.internalError(
        `Task ${params.taskId} not found after execution.`,
      );
    }

    return latestTask;
  }

  private async processNonBlockingExecution(params: {
    eventQueue: ExecutionEventQueue;
    latestUserMessage: Message;
    taskId: string;
    context?: ServerCallContext;
  }): Promise<Message | Task> {
    return new Promise<Message | Task>((resolve, reject) => {
      let settled = false;

      const settle = (result: Message | Task): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(result);
      };

      void (async () => {
        for await (const event of params.eventQueue.events()) {
          const committed = await this.commitExecutionEvent(
            event,
            params.latestUserMessage,
          );

          if (shouldResolveFirstResult(committed)) {
            settle(committed);
          }
        }

        if (settled) {
          return;
        }

        const latestTask = await this.taskRuntime.load(params.taskId, params.context);

        if (latestTask) {
          settle(latestTask);
          return;
        }

        reject(
          A2AError.internalError(
            "Execution finished before a message or task result was produced.",
          ),
        );
      })().catch((error) => {
        if (!settled) {
          reject(error);
          return;
        }

        console.error(`Task ${params.taskId} background processing failed.`, error);
      });
    });
  }

  private async commitExecutionEvent(
    event: AgentExecutionEvent,
    latestUserMessage: Message,
  ): Promise<StreamEvent> {
    if (event.kind === "message") {
      return event;
    }

    return this.taskRuntime.commitEvent(event, latestUserMessage);
  }

  private executeWithFallback(
    requestContext: RequestContext,
    eventBus: DefaultExecutionEventBus,
  ): void {
    this.agentExecutor.execute(requestContext, eventBus).catch((error) => {
      const errorText =
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : String(error);

      if (!requestContext.task) {
        eventBus.publish(
          createTaskSnapshot({
            taskId: requestContext.taskId,
            contextId: requestContext.contextId,
            state: "failed",
            history: [structuredClone(requestContext.userMessage)],
            messageText: `Agent execution error: ${errorText}`,
          }),
        );
      }

      eventBus.publish(
        createTaskStatusUpdate({
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          state: "failed",
          final: true,
          messageText: `Agent execution error: ${errorText}`,
        }),
      );
      eventBus.finished();
    });
  }

  private async createRequestContext(
    incomingMessage: Message,
    context?: ServerCallContext,
  ): Promise<RequestContext> {
    let task: Task | undefined;
    let referenceTasks: Task[] | undefined;

    if (incomingMessage.taskId) {
      const loadedTask = await this.taskRuntime.load(incomingMessage.taskId, context);

      if (!loadedTask) {
        throw A2AError.taskNotFound(incomingMessage.taskId);
      }

      task =
        (await this.taskRuntime.reconcileOrphanedTask(
          incomingMessage.taskId,
          this.liveExecutions.has(incomingMessage.taskId),
        )) ?? loadedTask;

      if (isTerminalTaskState(task.status.state)) {
        throw A2AError.invalidRequest(
          `Task ${task.id} is in a terminal state (${task.status.state}) and cannot be modified.`,
        );
      }

      task = await this.taskRuntime.persistIncomingMessage(
        incomingMessage.taskId,
        incomingMessage,
      );

      if (!task) {
        throw A2AError.taskNotFound(incomingMessage.taskId);
      }
    }

    const taskId = incomingMessage.taskId ?? randomUUID();

    if (incomingMessage.referenceTaskIds && incomingMessage.referenceTaskIds.length > 0) {
      referenceTasks = [];

      for (const referenceTaskId of incomingMessage.referenceTaskIds) {
        const referenceTask = await this.taskRuntime.load(referenceTaskId, context);

        if (referenceTask) {
          referenceTasks.push(referenceTask);
        }
      }
    }

    const contextId = incomingMessage.contextId ?? task?.contextId ?? randomUUID();
    const filteredContext = await this.filterRequestedExtensions(context);
    const messageForContext: Message = {
      ...incomingMessage,
      contextId,
      taskId,
    };

    return new RequestContext(
      messageForContext,
      taskId,
      contextId,
      task,
      referenceTasks,
      filteredContext,
    );
  }

  private async filterRequestedExtensions(
    context?: ServerCallContext,
  ): Promise<ServerCallContext | undefined> {
    if (!context?.requestedExtensions) {
      return context;
    }

    const agentCard = await this.getAgentCard();
    const exposedExtensions = new Set(
      agentCard.capabilities.extensions?.map((extension) => extension.uri) ?? [],
    );
    const validExtensions = context.requestedExtensions.filter((extension) =>
      exposedExtensions.has(extension),
    );

    return new ServerCallContext(validExtensions, context.user);
  }

  private async *consumeCommittedTail(
    subscription: TaskJournalSubscriptionHandle,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent, void, undefined> {
    try {
      while (true) {
        const record = await subscription.next();

        if (!record) {
          return;
        }

        yield record.event;

        if (isFinalTaskEvent(record.event)) {
          return;
        }
      }
    } finally {
      subscription.close();
    }
  }
}
