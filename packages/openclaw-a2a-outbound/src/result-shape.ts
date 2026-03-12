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
  TargetCardCapabilitiesSnapshot,
  TargetCardSnapshot,
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

export interface TargetListPeerCardCapabilitiesSummary {
  streaming?: boolean;
  push_notifications?: boolean;
  state_transition_history?: boolean;
  extensions?: NonNullable<TargetCardCapabilitiesSnapshot["extensions"]>;
}

export interface TargetListPeerCardSummary {
  preferred_transport?: string;
  additional_interfaces: TargetCardSnapshot["additionalInterfaces"];
  capabilities: TargetListPeerCardCapabilitiesSummary;
  default_input_modes: string[];
  default_output_modes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples: string[];
    input_modes?: string[];
    output_modes?: string[];
  }>;
}

export interface TargetListSummary {
  target_alias: string;
  target_url: string;
  default: boolean;
  tags: string[];
  examples: string[];
  target_name?: string;
  description?: string;
  peer_card: TargetListPeerCardSummary;
  last_refreshed_at?: string;
  last_refresh_error?: ToolError;
}

export interface RemoteAgentSummary {
  target_alias?: string;
  target_name?: string;
  target_url?: string;
  message_text?: string;
  artifacts?: Artifact[];
  continuation?: RemoteAgentContinuationSummary;
  streaming_supported?: boolean;
  targets?: TargetListSummary[];
}

export interface TaskContinuationSummary {
  task_handle?: string;
  task_id: string;
  status?: string;
  can_send: true;
  can_status: true;
  can_cancel: true;
  can_watch: boolean;
}

export interface ConversationContinuationSummary {
  context_id: string;
  can_send: true;
}

export interface RemoteAgentContinuationSummary {
  task?: TaskContinuationSummary;
  conversation?: ConversationContinuationSummary;
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

export interface SummaryTaskContext {
  taskId?: string;
  contextId?: string;
  taskHandle?: string;
}

function continuationSummary(
  target: ResolvedTarget,
  context: SummaryTaskContext & { status?: string },
): RemoteAgentContinuationSummary | undefined {
  const task: TaskContinuationSummary | undefined =
    context.taskId !== undefined
      ? {
          task_id: context.taskId,
          ...(context.taskHandle !== undefined
            ? { task_handle: context.taskHandle }
            : {}),
          ...(context.status !== undefined ? { status: context.status } : {}),
          can_send: true,
          can_status: true,
          can_cancel: true,
          can_watch: target.streamingSupported === true,
        }
      : undefined;
  const conversation: ConversationContinuationSummary | undefined =
    context.contextId !== undefined
      ? {
          context_id: context.contextId,
          can_send: true,
        }
      : undefined;

  if (task === undefined && conversation === undefined) {
    return undefined;
  }

  return {
    ...(task !== undefined ? { task } : {}),
    ...(conversation !== undefined ? { conversation } : {}),
  };
}

function withContinuationContext(
  target: ResolvedTarget,
  summary: RemoteAgentSummary,
  context: SummaryTaskContext & { status?: string },
): RemoteAgentSummary {
  const continuation = continuationSummary(target, context);

  return {
    ...summary,
    ...(continuation !== undefined ? { continuation } : {}),
  };
}

function messageSummary(
  target: ResolvedTarget,
  raw: Message,
  context: SummaryTaskContext = {},
): RemoteAgentSummary {
  const messageText = extractMessageText(raw);

  return withContinuationContext(
    target,
    {
      ...baseSummary(target),
      ...(messageText !== undefined ? { message_text: messageText } : {}),
    },
    {
      ...(raw.taskId !== undefined ? { taskId: raw.taskId } : {}),
      contextId: raw.contextId ?? context.contextId,
      ...(raw.taskId !== undefined && context.taskHandle !== undefined
        ? { taskHandle: context.taskHandle }
        : {}),
    },
  );
}

function taskSummary(
  target: ResolvedTarget,
  raw: Task,
  context: SummaryTaskContext = {},
): RemoteAgentSummary {
  const messageText = extractTaskText(raw);
  const artifacts = extractArtifacts(raw);

  return withContinuationContext(
    target,
    {
      ...baseSummary(target),
      ...(messageText !== undefined ? { message_text: messageText } : {}),
      ...(artifacts !== undefined ? { artifacts } : {}),
    },
    {
      taskId: raw.id,
      contextId: raw.contextId ?? context.contextId,
      taskHandle: context.taskHandle,
      status: raw.status.state,
    },
  );
}

function artifactUpdateSummary(
  target: ResolvedTarget,
  raw: TaskArtifactUpdateEvent,
  context: SummaryTaskContext = {},
): RemoteAgentSummary {
  return withContinuationContext(
    target,
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
    {
      taskId: raw.taskId ?? context.taskId,
      contextId: raw.contextId ?? context.contextId,
      taskHandle: context.taskHandle,
    },
  );
}

export function summarizeStreamEvent(
  target: ResolvedTarget,
  event: A2AStreamEventData,
  context: SummaryTaskContext = {},
): RemoteAgentSummary {
  switch (event.kind) {
    case "message":
      return messageSummary(target, event, context);
    case "task":
      return taskSummary(target, event, context);
    case "status-update":
      return withContinuationContext(
        target,
        {
          ...baseSummary(target),
        },
        {
          taskId: event.taskId ?? context.taskId,
          contextId: event.contextId ?? context.contextId,
          taskHandle: context.taskHandle,
          status: event.status.state,
        },
      );
    case "artifact-update":
      return artifactUpdateSummary(target, event, context);
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
  const peerCard: TargetListPeerCardSummary = {
    ...(entry.card.preferredTransport !== undefined
      ? { preferred_transport: entry.card.preferredTransport }
      : {}),
    additional_interfaces: entry.card.additionalInterfaces.map((cardInterface) => ({
      transport: cardInterface.transport,
      url: cardInterface.url,
    })),
    capabilities: {
      ...(typeof entry.card.capabilities.streaming === "boolean"
        ? { streaming: entry.card.capabilities.streaming }
        : {}),
      ...(typeof entry.card.capabilities.pushNotifications === "boolean"
        ? { push_notifications: entry.card.capabilities.pushNotifications }
        : {}),
      ...(typeof entry.card.capabilities.stateTransitionHistory === "boolean"
        ? {
            state_transition_history:
              entry.card.capabilities.stateTransitionHistory,
          }
        : {}),
      ...(entry.card.capabilities.extensions !== undefined
        ? {
            extensions: entry.card.capabilities.extensions.map((extension) =>
              structuredClone(extension),
            ),
          }
        : {}),
    },
    default_input_modes: [...entry.card.defaultInputModes],
    default_output_modes: [...entry.card.defaultOutputModes],
    skills: entry.card.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [...skill.tags],
      examples: [...skill.examples],
      ...(skill.inputModes !== undefined
        ? { input_modes: [...skill.inputModes] }
        : {}),
      ...(skill.outputModes !== undefined
        ? { output_modes: [...skill.outputModes] }
        : {}),
    })),
  };

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
    peer_card: peerCard,
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
  context: SummaryTaskContext = {},
): SuccessEnvelope<"send"> {
  return successEnvelope(
    "send",
    raw.kind === "task"
      ? taskSummary(target, raw, context)
      : messageSummary(target, raw, context),
    raw,
  );
}

function streamSuccess<TAction extends StreamingAction>(
  action: TAction,
  target: ResolvedTarget,
  events: A2AStreamEventData[],
  context: SummaryTaskContext = {},
): SuccessEnvelope<TAction> {
  const finalEvent = events.at(-1);

  if (!finalEvent) {
    throw new TypeError("stream success requires at least one event");
  }

  return successEnvelope(
    action,
    summarizeStreamEvent(target, finalEvent, context),
    {
      events,
      finalEvent,
    } as SuccessEnvelope<TAction>["raw"],
  );
}

export function sendStreamSuccess(
  target: ResolvedTarget,
  events: A2AStreamEventData[],
  context: SummaryTaskContext = {},
): SuccessEnvelope<"send"> {
  return streamSuccess("send", target, events, context);
}

export function watchSuccess(
  target: ResolvedTarget,
  events: A2AStreamEventData[],
  context: SummaryTaskContext = {},
): SuccessEnvelope<"watch"> {
  return streamSuccess("watch", target, events, context);
}

export function statusSuccess(
  target: ResolvedTarget,
  raw: Task,
  context: SummaryTaskContext = {},
): SuccessEnvelope<"status"> {
  return successEnvelope("status", taskSummary(target, raw, context), raw);
}

export function cancelSuccess(
  target: ResolvedTarget,
  raw: Task,
  context: SummaryTaskContext = {},
): SuccessEnvelope<"cancel"> {
  return successEnvelope("cancel", taskSummary(target, raw, context), raw);
}

export function streamUpdate<TAction extends StreamingAction>(
  action: TAction,
  target: ResolvedTarget,
  raw: A2AStreamEventData,
  context: SummaryTaskContext = {},
): StreamUpdateEnvelope<TAction> {
  return {
    ok: true,
    operation: REMOTE_AGENT_OPERATION,
    action,
    phase: "update",
    summary: summarizeStreamEvent(target, raw, context),
    raw,
  };
}
