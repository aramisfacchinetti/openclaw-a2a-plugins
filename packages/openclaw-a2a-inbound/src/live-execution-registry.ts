import {
  DefaultExecutionEventBusManager,
  type ExecutionEventBusManager,
} from "@a2a-js/sdk/server";

export type A2AInitialResponseMode = "blocking" | "non_blocking";

export interface A2ALiveExecutionRecord {
  taskId: string;
  contextId: string;
  abortController: AbortController;
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
    if (mode !== "blocking" && mode !== "non_blocking") {
      return;
    }

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
    cancel?: () => Promise<void>;
  }): A2ALiveExecutionRecord {
    const existing = this.executions.get(params.taskId);

    if (existing) {
      existing.contextId = params.contextId;
      existing.abortController = params.abortController;
      existing.cancel = params.cancel ?? existing.cancel;
      return existing;
    }

    const record: A2ALiveExecutionRecord = {
      taskId: params.taskId,
      contextId: params.contextId,
      abortController: params.abortController,
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
  }
}
