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
  ExecutionEventQueue,
  ResultManager,
  DefaultRequestHandler,
  type AgentExecutor,
  type ExecutionEventBusManager,
  type ServerCallContext,
  type TaskStore,
} from "@a2a-js/sdk/server";
import { isTerminalTaskState } from "./response-mapping.js";
import type { A2ALiveExecutionRegistry } from "./live-execution-registry.js";

export class A2AInboundRequestHandler {
  constructor(
    private readonly base: DefaultRequestHandler,
    private readonly taskStore: TaskStore,
    private readonly liveExecutions: A2ALiveExecutionRegistry,
    private readonly streamingEnabled: boolean,
    private readonly eventBusManager: ExecutionEventBusManager,
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

  sendMessage(
    params: MessageSendParams,
    context?: ServerCallContext,
  ): Promise<Message | Task> {
    return this.withRequestMode(
      params,
      params.configuration?.blocking === false ? "non_blocking" : "blocking",
      (nextParams) => this.base.sendMessage(nextParams, context),
    );
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
    this.liveExecutions.setRequestMode(prepared.message.messageId, "streaming");

    try {
      yield* this.base.sendMessageStream(prepared, context);
    } finally {
      this.liveExecutions.clearRequestMode(prepared.message.messageId);
    }
  }

  getTask(params: TaskQueryParams, context?: ServerCallContext): Promise<Task> {
    return this.base.getTask(params, context);
  }

  async cancelTask(
    params: TaskIdParams,
    context?: ServerCallContext,
  ): Promise<Task> {
    const task = await this.taskStore.load(params.id, context);

    if (!task) {
      throw A2AError.taskNotFound(params.id);
    }

    if (isTerminalTaskState(task.status.state)) {
      return task;
    }

    if (!this.liveExecutions.has(params.id)) {
      throw A2AError.unsupportedOperation(
        "Task cancellation is only available for live in-process tasks in this milestone.",
      );
    }

    const eventBus = this.eventBusManager.getByTaskId(params.id);

    if (!eventBus) {
      throw A2AError.unsupportedOperation(
        "Task cancellation is only available while the task is live in this process.",
      );
    }

    const eventQueue = new ExecutionEventQueue(eventBus);

    try {
      await this.agentExecutor.cancelTask(params.id, eventBus);
      const resultManager = new ResultManager(this.taskStore, context);

      for await (const event of eventQueue.events()) {
        await resultManager.processEvent(event);
      }
    } finally {
      eventQueue.stop();
    }

    let latestTask = await this.taskStore.load(params.id, context);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (latestTask?.status.state === "canceled") {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      latestTask = await this.taskStore.load(params.id, context);
    }

    if (!latestTask) {
      throw A2AError.internalError(
        `Task ${params.id} not found after cancellation.`,
      );
    }

    if (latestTask.status.state !== "canceled") {
      throw A2AError.taskNotCancelable(params.id);
    }

    return latestTask;
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

    const task = await this.taskStore.load(params.id, context);

    if (!task) {
      throw A2AError.taskNotFound(params.id);
    }

    if (!isTerminalTaskState(task.status.state) && !this.liveExecutions.has(params.id)) {
      throw A2AError.unsupportedOperation(
        "Task resubscription is only available for live in-process tasks in this milestone.",
      );
    }

    yield* this.base.resubscribe(params, context);
  }

  private prepareParams(params: MessageSendParams): MessageSendParams {
    return params;
  }

  private async withRequestMode<T extends Message | Task>(
    params: MessageSendParams,
    mode: "blocking" | "non_blocking",
    run: (preparedParams: MessageSendParams) => Promise<T>,
  ): Promise<T> {
    const prepared = this.prepareParams(params);
    const requestId = prepared.message.messageId;
    this.liveExecutions.setRequestMode(requestId, mode);

    try {
      const result = await run(prepared);

      if (result.kind === "message") {
        this.liveExecutions.clearRequestMode(requestId);
      } else if (isTerminalTaskState(result.status.state)) {
        this.liveExecutions.clearRequestMode(requestId);
      }

      return result;
    } catch (error) {
      this.liveExecutions.clearRequestMode(requestId);
      throw error;
    }
  }
}
