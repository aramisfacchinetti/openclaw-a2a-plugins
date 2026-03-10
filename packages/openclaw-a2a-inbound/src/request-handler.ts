import { randomUUID } from "node:crypto";
import type {
  AgentCard,
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
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
import {
  createTaskSnapshot,
  createTaskStatusUpdate,
  isQuiescentTaskState,
  isTerminalTaskState,
  normalizeOutputModes,
} from "./response-mapping.js";
import {
  attachAcceptedOutputModes,
  attachOriginalUserMessage,
  readOriginalUserMessage,
} from "./request-context.js";
import { validateInboundMessageParts } from "./session-routing.js";
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
    private readonly agentExecutor: AgentExecutor,
    private readonly defaultOutputModes: readonly string[],
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
    const resolvedOutputModes = this.resolveAcceptedOutputModes(prepared);
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
      const requestContext = await this.createRequestContext(
        prepared.message,
        context,
        resolvedOutputModes,
      );
      const eventBus = new DefaultExecutionEventBus();
      const eventQueue = new ExecutionEventQueue(eventBus);
      const executionPromise = this.executeWithFallback(requestContext, eventBus);

      if (blocking) {
        return await this.processBlockingExecution({
          eventQueue,
          latestUserMessage: prepared.message,
          taskId: requestContext.taskId,
          executionPromise,
          context,
        });
      }

      return await this.processNonBlockingExecution({
        eventQueue,
        latestUserMessage: prepared.message,
        taskId: requestContext.taskId,
        executionPromise,
        context,
      });
    } finally {
      this.liveExecutions.clearRequestMode(requestId);
    }
  }

  async getTask(
    params: TaskQueryParams,
    context?: ServerCallContext,
  ): Promise<Task> {
    const task = await this.loadTaskForRead(params.id, context);

    if (!task) {
      throw A2AError.taskNotFound(params.id);
    }

    return trimTaskHistory(task, params.historyLength);
  }

  async cancelTask(
    params: TaskIdParams,
    context?: ServerCallContext,
  ): Promise<Task> {
    const task = await this.loadTaskForRead(params.id, context);

    if (!task) {
      throw A2AError.taskNotFound(params.id);
    }

    if (isTerminalTaskState(task.status.state)) {
      return task;
    }

    if (isQuiescentTaskState(task.status.state)) {
      return this.cancelQuiescentTask(task, context);
    }

    if (!this.liveExecutions.has(params.id)) {
      const latestTask = await this.loadTaskForRead(params.id, context);

      if (!latestTask) {
        throw A2AError.taskNotFound(params.id);
      }

      if (isTerminalTaskState(latestTask.status.state)) {
        return latestTask;
      }

      if (isQuiescentTaskState(latestTask.status.state)) {
        return this.cancelQuiescentTask(latestTask, context);
      }

      throw A2AError.unsupportedOperation(
        "Task cancellation is only available while the task is live in this process.",
      );
    }

    const prepared = await this.taskRuntime.prepareLiveTail(params.id);

    if (!prepared) {
      throw A2AError.taskNotFound(params.id);
    }

    if (isTerminalTaskState(prepared.task.status.state)) {
      return prepared.task;
    }

    if (isQuiescentTaskState(prepared.task.status.state)) {
      return this.cancelQuiescentTask(prepared.task, context);
    }

    if (!prepared.subscription) {
      throw A2AError.taskNotCancelable(params.id);
    }

    await this.agentExecutor.cancelTask(params.id, new DefaultExecutionEventBus());

    return this.waitForCommittedTerminalTask(
      params.id,
      prepared.subscription,
      context,
    );
  }

  private prepareParams(params: MessageSendParams): MessageSendParams {
    validateInboundMessageParts(params.message);
    return params;
  }

  private resolveAcceptedOutputModes(params: MessageSendParams): string[] {
    if (
      params.configuration &&
      "acceptedOutputModes" in params.configuration
    ) {
      return normalizeOutputModes(params.configuration.acceptedOutputModes);
    }

    return [...this.defaultOutputModes];
  }

  private async processBlockingExecution(params: {
    eventQueue: ExecutionEventQueue;
    latestUserMessage: Message;
    taskId: string;
    executionPromise: Promise<void>;
    context?: ServerCallContext;
  }): Promise<Message | Task> {
    let finalMessage: Message | undefined;
    let sawDurableEvent = false;

    try {
      for await (const event of params.eventQueue.events()) {
        const committed = await this.commitExecutionEvent(
          event,
          params.latestUserMessage,
        );

        if (committed.kind === "message") {
          finalMessage = committed;
        } else {
          sawDurableEvent = true;
        }
      }

      await params.executionPromise;

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
    } finally {
      if (!sawDurableEvent) {
        this.taskRuntime.discardPending(params.taskId);
      }
    }
  }

  private async processNonBlockingExecution(params: {
    eventQueue: ExecutionEventQueue;
    latestUserMessage: Message;
    taskId: string;
    executionPromise: Promise<void>;
    context?: ServerCallContext;
  }): Promise<Message | Task> {
    return new Promise<Message | Task>((resolve, reject) => {
      let settled = false;
      let sawDurableEvent = false;

      const settle = (result: Message | Task): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(result);
      };

      void (async () => {
        try {
          for await (const event of params.eventQueue.events()) {
            const committed = await this.commitExecutionEvent(
              event,
              params.latestUserMessage,
            );

            if (committed.kind !== "message") {
              sawDurableEvent = true;
            }

            if (shouldResolveFirstResult(committed)) {
              settle(committed);
            }
          }

          await params.executionPromise;

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
        } finally {
          if (!sawDurableEvent) {
            this.taskRuntime.discardPending(params.taskId);
          }
        }
      })().catch((error) => {
        if (!settled) {
          reject(error);
          return;
        }

        if (error instanceof A2AError && error.code === -32005) {
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
  ): Promise<void> {
    return this.agentExecutor.execute(requestContext, eventBus).catch((error) => {
      if (error instanceof A2AError && error.code === -32005) {
        throw error;
      }

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
            history: [readOriginalUserMessage(requestContext)],
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
      throw error;
    });
  }

  private async createRequestContext(
    incomingMessage: Message,
    context?: ServerCallContext,
    acceptedOutputModes: readonly string[] = [],
  ): Promise<RequestContext> {
    let task: Task | undefined;
    let referenceTasks: Task[] | undefined;

    if (incomingMessage.taskId) {
      const loadedTask = await this.loadTaskForRead(incomingMessage.taskId, context);

      if (!loadedTask) {
        throw A2AError.taskNotFound(incomingMessage.taskId);
      }

      task = loadedTask;

      if (
        typeof incomingMessage.contextId === "string" &&
        incomingMessage.contextId !== task.contextId
      ) {
        throw A2AError.invalidRequest(
          `Task ${task.id} is bound to contextId ${task.contextId}, not ${incomingMessage.contextId}.`,
        );
      }

      const binding = await this.taskRuntime.loadBinding(incomingMessage.taskId);

      if (!binding) {
        throw A2AError.unsupportedOperation(
          `Task ${task.id} was created before OpenClaw bindings were recorded and cannot be resumed.`,
        );
      }

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

    return attachAcceptedOutputModes(
      attachOriginalUserMessage(
        new RequestContext(
          messageForContext,
          taskId,
          contextId,
          task,
          referenceTasks,
          filteredContext,
        ),
        incomingMessage,
      ),
      acceptedOutputModes,
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
        const event = await subscription.next();

        if (!event) {
          return;
        }

        yield event;

        if (isFinalTaskEvent(event)) {
          return;
        }
      }
    } finally {
      subscription.close();
    }
  }

  private async cancelQuiescentTask(
    task: Task,
    context?: ServerCallContext,
  ): Promise<Task> {
    await this.taskRuntime.commitEvent(
      createTaskStatusUpdate({
        taskId: task.id,
        contextId: task.contextId,
        state: "canceled",
        final: true,
        messageText: "Task cancellation requested by the client.",
      }),
    );
    this.liveExecutions.cleanup(task.id);

    const canceled = await this.taskRuntime.load(task.id, context);

    if (!canceled) {
      throw A2AError.internalError(
        `Task ${task.id} not found after cancellation.`,
      );
    }

    return canceled;
  }

  private async waitForCommittedTerminalTask(
    taskId: string,
    subscription: TaskJournalSubscriptionHandle,
    context?: ServerCallContext,
  ): Promise<Task> {
    for await (const _event of this.consumeCommittedTail(subscription)) {
      // Wait until the committed tail reaches a final status update.
    }

    const terminalTask = await this.taskRuntime.load(taskId, context);

    if (!terminalTask) {
      throw A2AError.internalError(
        `Task ${taskId} not found after cancellation.`,
      );
    }

    if (isTerminalTaskState(terminalTask.status.state)) {
      return terminalTask;
    }

    throw A2AError.taskNotCancelable(taskId);
  }

  private async loadTaskForRead(
    taskId: string,
    context?: ServerCallContext,
  ): Promise<Task | undefined> {
    return this.taskRuntime.load(taskId, context);
  }
}
