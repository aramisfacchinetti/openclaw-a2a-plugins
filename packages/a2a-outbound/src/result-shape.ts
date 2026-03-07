import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type { ToolError } from "./errors.js";
import type { ResolvedTarget } from "./sdk-client-pool.js";

export type A2AStreamEventData =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

export const OPERATIONS = {
  DELEGATE: "a2a_delegate",
  DELEGATE_STREAM: "a2a_delegate_stream",
  TASK_STATUS: "a2a_task_status",
  TASK_WAIT: "a2a_task_wait",
  TASK_RESUBSCRIBE: "a2a_task_resubscribe",
  TASK_CANCEL: "a2a_task_cancel",
} as const;

export type A2AOperation = (typeof OPERATIONS)[keyof typeof OPERATIONS];
export type SendMessageResult = Message | Task;
export type StreamOperation =
  | typeof OPERATIONS.DELEGATE_STREAM
  | typeof OPERATIONS.TASK_RESUBSCRIBE;
export type StreamRawResult = {
  events: A2AStreamEventData[];
  finalEvent: A2AStreamEventData;
};
export type StreamEventSummary = {
  kind: A2AStreamEventData["kind"];
  taskId?: string;
  status?: string;
  messageId?: string;
  artifactId?: string;
  role?: Message["role"];
};
export type StreamSuccessSummary = {
  kind: "stream";
  eventCount: number;
  finalEventKind: StreamEventSummary["kind"];
  taskId?: string;
  status?: string;
  messageId?: string;
  artifactId?: string;
};
export type OperationRawMap = {
  [OPERATIONS.DELEGATE]: SendMessageResult;
  [OPERATIONS.DELEGATE_STREAM]: StreamRawResult;
  [OPERATIONS.TASK_STATUS]: Task;
  [OPERATIONS.TASK_WAIT]: Task;
  [OPERATIONS.TASK_RESUBSCRIBE]: StreamRawResult;
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

export type StreamUpdateEnvelope<T extends StreamOperation = StreamOperation> = {
  ok: true;
  operation: T;
  phase: "update";
  target: ResolvedTarget;
  summary: StreamEventSummary;
  raw: A2AStreamEventData;
};

export type A2AToolResult = SuccessEnvelope | FailureEnvelope;

function taskState(task: Task): string {
  return task.status.state;
}

function terminalSummaryFields(summary: StreamEventSummary): Omit<
  StreamSuccessSummary,
  "kind" | "eventCount" | "finalEventKind"
> {
  return {
    ...(summary.taskId !== undefined ? { taskId: summary.taskId } : {}),
    ...(summary.status !== undefined ? { status: summary.status } : {}),
    ...(summary.messageId !== undefined ? { messageId: summary.messageId } : {}),
    ...(summary.artifactId !== undefined
      ? { artifactId: summary.artifactId }
      : {}),
  };
}

function failureEnvelope(
  operation: A2AOperation,
  target: ResolvedTarget | undefined,
  error: ToolError,
): FailureEnvelope {
  return {
    ok: false,
    operation,
    ...(target ? { target } : {}),
    error,
  };
}

function streamSuccess<T extends StreamOperation>(
  operation: T,
  target: ResolvedTarget,
  events: A2AStreamEventData[],
): SuccessEnvelope<T> {
  const finalEvent = events.at(-1);

  if (!finalEvent) {
    throw new TypeError("stream success requires at least one event");
  }

  const finalSummary = summarizeStreamEvent(finalEvent);

  return {
    ok: true,
    operation,
    target,
    summary: {
      kind: "stream",
      eventCount: events.length,
      finalEventKind: finalSummary.kind,
      ...terminalSummaryFields(finalSummary),
    },
    raw: {
      events,
      finalEvent,
    } as OperationRawMap[T],
  };
}

export function summarizeStreamEvent(
  event: A2AStreamEventData,
): StreamEventSummary {
  switch (event.kind) {
    case "message":
      return {
        kind: "message",
        ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
        messageId: event.messageId,
        role: event.role,
      };
    case "task":
      return {
        kind: "task",
        taskId: event.id,
        status: taskState(event),
      };
    case "status-update":
      return {
        kind: "status-update",
        taskId: event.taskId,
        status: event.status.state,
      };
    case "artifact-update":
      return {
        kind: "artifact-update",
        taskId: event.taskId,
        artifactId: event.artifact.artifactId,
      };
  }

  throw new TypeError("unsupported A2A stream event kind");
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
  return failureEnvelope(OPERATIONS.DELEGATE, target, error);
}

export function delegateStreamSuccess(
  target: ResolvedTarget,
  events: A2AStreamEventData[],
): SuccessEnvelope<typeof OPERATIONS.DELEGATE_STREAM> {
  return streamSuccess(OPERATIONS.DELEGATE_STREAM, target, events);
}

export function delegateStreamFailure(
  target: ResolvedTarget | undefined,
  error: ToolError,
): FailureEnvelope {
  return failureEnvelope(OPERATIONS.DELEGATE_STREAM, target, error);
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
  return failureEnvelope(OPERATIONS.TASK_STATUS, target, error);
}

export function taskWaitSuccess(
  target: ResolvedTarget,
  taskId: string,
  raw: Task,
  attempts: number,
  elapsedMs: number,
): SuccessEnvelope<typeof OPERATIONS.TASK_WAIT> {
  return {
    ok: true,
    operation: OPERATIONS.TASK_WAIT,
    target,
    summary: {
      taskId,
      status: taskState(raw),
      attempts,
      elapsedMs,
    },
    raw,
  };
}

export function taskWaitFailure(
  target: ResolvedTarget | undefined,
  error: ToolError,
): FailureEnvelope {
  return failureEnvelope(OPERATIONS.TASK_WAIT, target, error);
}

export function taskResubscribeSuccess(
  target: ResolvedTarget,
  events: A2AStreamEventData[],
): SuccessEnvelope<typeof OPERATIONS.TASK_RESUBSCRIBE> {
  return streamSuccess(OPERATIONS.TASK_RESUBSCRIBE, target, events);
}

export function taskResubscribeFailure(
  target: ResolvedTarget | undefined,
  error: ToolError,
): FailureEnvelope {
  return failureEnvelope(OPERATIONS.TASK_RESUBSCRIBE, target, error);
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
  return failureEnvelope(OPERATIONS.TASK_CANCEL, target, error);
}

export function streamUpdate<T extends StreamOperation>(
  operation: T,
  target: ResolvedTarget,
  raw: A2AStreamEventData,
): StreamUpdateEnvelope<T> {
  return {
    ok: true,
    operation,
    phase: "update",
    target,
    summary: summarizeStreamEvent(raw),
    raw,
  };
}
