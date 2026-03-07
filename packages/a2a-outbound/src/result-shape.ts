import type {
  Artifact,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type { ToolError } from "./errors.js";
import type { RemoteAgentAction } from "./schemas.js";
import type { ResolvedTarget } from "./sdk-client-pool.js";
import type {
  TargetCatalogEntry,
  TargetCatalogSkillSummary,
} from "./target-catalog.js";

export const REMOTE_AGENT_OPERATION = "remote_agent" as const;

export type A2AStreamEventData =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

export type StreamingAction = Extract<RemoteAgentAction, "send" | "watch">;

export type StreamRawResult = {
  events: A2AStreamEventData[];
  finalEvent: A2AStreamEventData;
};

type ActionRawMap = {
  list_targets: TargetCatalogEntry[];
  send: Message | Task | StreamRawResult;
  watch: StreamRawResult;
  status: Task;
  cancel: Task;
};

export interface TargetListSummary {
  target_alias: string;
  target_url: string;
  default: boolean;
  tags: string[];
  examples: string[];
  target_name?: string;
  description?: string;
  streaming_supported?: boolean;
  preferred_transport?: string;
  skills?: TargetCatalogSkillSummary[];
  last_refreshed_at?: string;
  last_refresh_error?: ToolError;
}

export interface RemoteAgentSummary {
  target_alias?: string;
  target_name?: string;
  target_url?: string;
  task_handle?: string;
  task_id?: string;
  status?: string;
  message_text?: string;
  artifacts?: Artifact[];
  can_watch?: boolean;
  streaming_supported?: boolean;
  targets?: TargetListSummary[];
}

export type SuccessEnvelope<TAction extends RemoteAgentAction = RemoteAgentAction> =
  {
    ok: true;
    operation: typeof REMOTE_AGENT_OPERATION;
    action: TAction;
    summary: RemoteAgentSummary;
    raw: ActionRawMap[TAction];
  };

export type FailureEnvelope<TAction extends string = string> = {
  ok: false;
  operation: typeof REMOTE_AGENT_OPERATION;
  action: TAction;
  error: ToolError;
};

export type StreamUpdateEnvelope<TAction extends StreamingAction = StreamingAction> =
  {
    ok: true;
    operation: typeof REMOTE_AGENT_OPERATION;
    action: TAction;
    phase: "update";
    summary: RemoteAgentSummary;
    raw: A2AStreamEventData;
  };

export type A2AToolResult = SuccessEnvelope | FailureEnvelope;

function textParts(parts: Array<{ kind: string; text?: string }>): string[] {
  return parts.flatMap((part) =>
    part.kind === "text" && typeof part.text === "string" ? [part.text] : [],
  );
}

function extractMessageText(message: Message): string | undefined {
  const texts = textParts(message.parts);
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function cloneArtifact(artifact: Artifact): Artifact {
  return {
    artifactId: artifact.artifactId,
    parts: [...artifact.parts],
    ...(artifact.description !== undefined
      ? { description: artifact.description }
      : {}),
    ...(artifact.extensions !== undefined
      ? { extensions: [...artifact.extensions] }
      : {}),
    ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
    ...(artifact.name !== undefined ? { name: artifact.name } : {}),
  };
}

function extractArtifacts(task: Task): Artifact[] | undefined {
  if (!Array.isArray(task.artifacts) || task.artifacts.length === 0) {
    return undefined;
  }

  return task.artifacts.map(cloneArtifact);
}

function extractTaskText(task: Task): string | undefined {
  const historyText = task.history?.flatMap((message) => {
    const text = extractMessageText(message);
    return text !== undefined ? [text] : [];
  });
  const artifactText = extractArtifacts(task)?.flatMap((artifact) =>
    textParts(artifact.parts),
  );
  const texts = [...(historyText ?? []), ...(artifactText ?? [])];

  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function baseSummary(target: ResolvedTarget): RemoteAgentSummary {
  return {
    ...(target.alias !== undefined ? { target_alias: target.alias } : {}),
    ...(target.displayName !== undefined
      ? { target_name: target.displayName }
      : {}),
    target_url: target.baseUrl,
    ...(target.streamingSupported !== undefined
      ? { streaming_supported: target.streamingSupported }
      : {}),
  };
}

function withTaskContext(
  summary: RemoteAgentSummary,
  taskId: string | undefined,
  taskHandle: string | undefined,
): RemoteAgentSummary {
  return {
    ...summary,
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    ...(taskHandle !== undefined ? { task_handle: taskHandle } : {}),
    ...(taskId !== undefined || taskHandle !== undefined
      ? { can_watch: true }
      : {}),
  };
}

function messageSummary(
  target: ResolvedTarget,
  raw: Message,
  taskHandle?: string,
): RemoteAgentSummary {
  return withTaskContext(
    {
      ...baseSummary(target),
      ...(extractMessageText(raw) !== undefined
        ? { message_text: extractMessageText(raw) }
        : {}),
    },
    raw.taskId,
    taskHandle,
  );
}

function taskSummary(
  target: ResolvedTarget,
  raw: Task,
  taskHandle?: string,
): RemoteAgentSummary {
  return withTaskContext(
    {
      ...baseSummary(target),
      task_id: raw.id,
      status: raw.status.state,
      ...(extractTaskText(raw) !== undefined
        ? { message_text: extractTaskText(raw) }
        : {}),
      ...(extractArtifacts(raw) !== undefined
        ? { artifacts: extractArtifacts(raw) }
        : {}),
    },
    raw.id,
    taskHandle,
  );
}

function artifactUpdateSummary(
  target: ResolvedTarget,
  raw: TaskArtifactUpdateEvent,
  taskHandle?: string,
): RemoteAgentSummary {
  return withTaskContext(
    {
      ...baseSummary(target),
      artifacts: [
        cloneArtifact({
          artifactId: raw.artifact.artifactId,
          parts: [...raw.artifact.parts],
          ...(raw.artifact.description !== undefined
            ? { description: raw.artifact.description }
            : {}),
          ...(raw.artifact.extensions !== undefined
            ? { extensions: [...raw.artifact.extensions] }
            : {}),
          ...(raw.artifact.metadata !== undefined
            ? { metadata: raw.artifact.metadata }
            : {}),
          ...(raw.artifact.name !== undefined ? { name: raw.artifact.name } : {}),
        }),
      ],
    },
    raw.taskId,
    taskHandle,
  );
}

export function summarizeStreamEvent(
  target: ResolvedTarget,
  event: A2AStreamEventData,
  taskHandle?: string,
): RemoteAgentSummary {
  switch (event.kind) {
    case "message":
      return messageSummary(target, event, taskHandle);
    case "task":
      return taskSummary(target, event, taskHandle);
    case "status-update":
      return withTaskContext(
        {
          ...baseSummary(target),
          status: event.status.state,
        },
        event.taskId,
        taskHandle,
      );
    case "artifact-update":
      return artifactUpdateSummary(target, event, taskHandle);
  }
}

function successEnvelope<TAction extends RemoteAgentAction>(
  action: TAction,
  summary: RemoteAgentSummary,
  raw: SuccessEnvelope<TAction>["raw"],
): SuccessEnvelope<TAction> {
  return {
    ok: true,
    operation: REMOTE_AGENT_OPERATION,
    action,
    summary,
    raw,
  };
}

export function remoteAgentFailure<TAction extends string>(
  action: TAction,
  error: ToolError,
): FailureEnvelope<TAction> {
  return {
    ok: false,
    operation: REMOTE_AGENT_OPERATION,
    action,
    error,
  };
}

function listTargetSummary(entry: TargetCatalogEntry): TargetListSummary {
  return {
    target_alias: entry.target.alias ?? "",
    target_url: entry.target.baseUrl,
    default: entry.default,
    tags: [...entry.tags],
    examples: [...entry.examples],
    ...(entry.target.displayName !== undefined
      ? { target_name: entry.target.displayName }
      : {}),
    ...(entry.target.description !== undefined
      ? { description: entry.target.description }
      : {}),
    ...(entry.card.streamingSupported !== undefined
      ? { streaming_supported: entry.card.streamingSupported }
      : entry.target.streamingSupported !== undefined
        ? { streaming_supported: entry.target.streamingSupported }
        : {}),
    ...(entry.card.preferredTransport !== undefined
      ? { preferred_transport: entry.card.preferredTransport }
      : {}),
    ...(entry.card.skillSummaries.length > 0
      ? {
          skills: entry.card.skillSummaries.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            tags: [...skill.tags],
            examples: [...skill.examples],
          })),
        }
      : {}),
    ...(entry.card.lastRefreshedAt !== undefined
      ? { last_refreshed_at: entry.card.lastRefreshedAt }
      : {}),
    ...(entry.card.lastRefreshError !== undefined
      ? { last_refresh_error: entry.card.lastRefreshError }
      : {}),
  };
}

export function listTargetsSuccess(
  entries: TargetCatalogEntry[],
): SuccessEnvelope<"list_targets"> {
  return successEnvelope(
    "list_targets",
    {
      targets: entries.map(listTargetSummary),
    },
    entries,
  );
}

export function sendSuccess(
  target: ResolvedTarget,
  raw: Message | Task,
  taskHandle?: string,
): SuccessEnvelope<"send"> {
  return successEnvelope(
    "send",
    raw.kind === "task"
      ? taskSummary(target, raw, taskHandle)
      : messageSummary(target, raw, taskHandle),
    raw,
  );
}

function streamSuccess<TAction extends StreamingAction>(
  action: TAction,
  target: ResolvedTarget,
  events: A2AStreamEventData[],
  taskHandle?: string,
): SuccessEnvelope<TAction> {
  const finalEvent = events.at(-1);

  if (!finalEvent) {
    throw new TypeError("stream success requires at least one event");
  }

  return successEnvelope(
    action,
    summarizeStreamEvent(target, finalEvent, taskHandle),
    {
      events,
      finalEvent,
    } as SuccessEnvelope<TAction>["raw"],
  );
}

export function sendStreamSuccess(
  target: ResolvedTarget,
  events: A2AStreamEventData[],
  taskHandle?: string,
): SuccessEnvelope<"send"> {
  return streamSuccess("send", target, events, taskHandle);
}

export function watchSuccess(
  target: ResolvedTarget,
  events: A2AStreamEventData[],
  taskHandle?: string,
): SuccessEnvelope<"watch"> {
  return streamSuccess("watch", target, events, taskHandle);
}

export function statusSuccess(
  target: ResolvedTarget,
  raw: Task,
  taskHandle?: string,
): SuccessEnvelope<"status"> {
  return successEnvelope("status", taskSummary(target, raw, taskHandle), raw);
}

export function cancelSuccess(
  target: ResolvedTarget,
  raw: Task,
  taskHandle?: string,
): SuccessEnvelope<"cancel"> {
  return successEnvelope("cancel", taskSummary(target, raw, taskHandle), raw);
}

export function streamUpdate<TAction extends StreamingAction>(
  action: TAction,
  target: ResolvedTarget,
  raw: A2AStreamEventData,
): StreamUpdateEnvelope<TAction> {
  return {
    ok: true,
    operation: REMOTE_AGENT_OPERATION,
    action,
    phase: "update",
    summary: summarizeStreamEvent(target, raw),
    raw,
  };
}
