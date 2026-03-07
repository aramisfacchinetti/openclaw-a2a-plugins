import type { Message, Task } from "@a2a-js/sdk";
import type { ToolError } from "./errors.js";
import type { ResolvedTarget } from "./sdk-client-pool.js";

export const OPERATIONS = {
  DELEGATE: "a2a_delegate",
  TASK_STATUS: "a2a_task_status",
  TASK_CANCEL: "a2a_task_cancel",
} as const;

export type A2AOperation = (typeof OPERATIONS)[keyof typeof OPERATIONS];
export type SendMessageResult = Message | Task;
export type OperationRawMap = {
  [OPERATIONS.DELEGATE]: SendMessageResult;
  [OPERATIONS.TASK_STATUS]: Task;
  [OPERATIONS.TASK_CANCEL]: Task;
};

export type SuccessEnvelope<T extends A2AOperation = A2AOperation> = {
  ok: true;
  operation: T;
  target: ResolvedTarget;
  summary: Record<string, unknown>;
  raw: OperationRawMap[T];
};

export type FailureEnvelope = {
  ok: false;
  operation: A2AOperation;
  target?: ResolvedTarget;
  error: ToolError;
};

export type A2AToolResult = SuccessEnvelope | FailureEnvelope;

function taskState(task: Task): string {
  return task.status.state;
}

export function delegateSuccess(
  target: ResolvedTarget,
  raw: SendMessageResult,
): SuccessEnvelope<typeof OPERATIONS.DELEGATE> {
  if (raw.kind === "task") {
    return {
      ok: true,
      operation: OPERATIONS.DELEGATE,
      target,
      summary: {
        kind: "task",
        taskId: raw.id,
        status: taskState(raw),
      },
      raw,
    };
  }

  return {
    ok: true,
    operation: OPERATIONS.DELEGATE,
    target,
    summary: {
      kind: "message",
      messageId: raw.messageId,
      role: raw.role,
    },
    raw,
  };
}

export function delegateFailure(
  target: ResolvedTarget | undefined,
  error: ToolError,
): FailureEnvelope {
  return {
    ok: false,
    operation: OPERATIONS.DELEGATE,
    ...(target ? { target } : {}),
    error,
  };
}

export function taskStatusSuccess(
  target: ResolvedTarget,
  taskId: string,
  raw: Task,
): SuccessEnvelope<typeof OPERATIONS.TASK_STATUS> {
  return {
    ok: true,
    operation: OPERATIONS.TASK_STATUS,
    target,
    summary: {
      taskId,
      status: taskState(raw),
    },
    raw,
  };
}

export function taskStatusFailure(
  target: ResolvedTarget | undefined,
  error: ToolError,
): FailureEnvelope {
  return {
    ok: false,
    operation: OPERATIONS.TASK_STATUS,
    ...(target ? { target } : {}),
    error,
  };
}

export function taskCancelSuccess(
  target: ResolvedTarget,
  taskId: string,
  raw: Task,
): SuccessEnvelope<typeof OPERATIONS.TASK_CANCEL> {
  return {
    ok: true,
    operation: OPERATIONS.TASK_CANCEL,
    target,
    summary: {
      taskId,
      status: taskState(raw),
    },
    raw,
  };
}

export function taskCancelFailure(
  target: ResolvedTarget | undefined,
  error: ToolError,
): FailureEnvelope {
  return {
    ok: false,
    operation: OPERATIONS.TASK_CANCEL,
    ...(target ? { target } : {}),
    error,
  };
}
