import {
  DefaultExecutionEventBusManager,
  type ExecutionEventBusManager,
} from "@a2a-js/sdk/server";

export type A2AInitialResponseMode = "blocking" | "non_blocking" | "streaming";

export type A2ALiveExecutionState =
  | "pending_message"
  | "active_task"
  | "completed"
  | "failed"
  | "canceled";

export interface A2ALiveExecutionRecord {
  taskId: string;
  contextId: string;
  abortController: AbortController;
  state: A2ALiveExecutionState;
  runId?: string;
  taskPublished: boolean;
  cancelRequested: boolean;
  cancel?: () => Promise<void>;
}

export class A2ALiveExecutionRegistry {
  private readonly executions = new Map<string, A2ALiveExecutionRecord>();
  private readonly requestModes = new Map<string, A2AInitialResponseMode>();

  constructor(
    readonly eventBusManager: ExecutionEventBusManager = new DefaultExecutionEventBusManager(),
  ) {}

  setRequestMode(requestId: string, mode: A2AInitialResponseMode): void {
    this.requestModes.set(requestId, mode);
  }

  getRequestMode(requestId: string): A2AInitialResponseMode | undefined {
    return this.requestModes.get(requestId);
  }

  clearRequestMode(requestId: string): void {
    this.requestModes.delete(requestId);
  }

  activate(params: {
    taskId: string;
    contextId: string;
    abortController: AbortController;
    runId?: string;
    cancel?: () => Promise<void>;
  }): A2ALiveExecutionRecord {
    const existing = this.executions.get(params.taskId);

    if (existing) {
      existing.contextId = params.contextId;
      existing.abortController = params.abortController;
      existing.runId = params.runId ?? existing.runId;
      existing.state = "active_task";
      existing.taskPublished = true;
      existing.cancel = params.cancel ?? existing.cancel;
      return existing;
    }

    const record: A2ALiveExecutionRecord = {
      taskId: params.taskId,
      contextId: params.contextId,
      abortController: params.abortController,
      runId: params.runId,
      state: "active_task",
      taskPublished: true,
      cancelRequested: false,
      cancel: params.cancel,
    };

    this.executions.set(params.taskId, record);
    return record;
  }

  get(taskId: string): A2ALiveExecutionRecord | undefined {
    return this.executions.get(taskId);
  }

  has(taskId: string): boolean {
    return this.executions.has(taskId);
  }

  update(taskId: string, update: Partial<A2ALiveExecutionRecord>): void {
    const record = this.executions.get(taskId);

    if (!record) {
      return;
    }

    Object.assign(record, update);
  }

  markTerminal(
    taskId: string,
    state: Extract<A2ALiveExecutionState, "completed" | "failed" | "canceled">,
  ): void {
    const record = this.executions.get(taskId);

    if (!record) {
      return;
    }

    record.state = state;
  }

  requestCancellation(taskId: string): A2ALiveExecutionRecord | undefined {
    const record = this.executions.get(taskId);

    if (!record) {
      return undefined;
    }

    record.cancelRequested = true;
    return record;
  }

  cleanup(taskId: string): void {
    this.executions.delete(taskId);
    this.requestModes.delete(taskId);
  }
}
