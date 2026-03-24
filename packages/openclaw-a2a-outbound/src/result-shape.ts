import type {
  Artifact,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type { ToolError } from "./errors.js";
import type { A2ATransport } from "./constants.js";
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
export type ResponseKind = "message" | "task";

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
  streaming_supported?: boolean;
  peer_card: TargetListPeerCardSummary;
  last_refreshed_at?: string;
  last_refresh_error?: ToolError;
}

export interface RemoteAgentSummary {
  target_alias?: string;
  target_name?: string;
  target_url?: string;
  response_kind?: ResponseKind;
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
  can_resume_send: boolean;
  can_send: boolean;
  can_status: boolean;
  can_cancel: boolean;
  can_watch: boolean;
}

export interface ConversationContinuationSummary {
  context_id: string;
  can_send: true;
}

export interface ContinuationTargetSummary {
  target_url: string;
  card_path: string;
  preferred_transports: A2ATransport[];
  target_alias?: string;
}

export interface RemoteAgentContinuationSummary {
  target: ContinuationTargetSummary;
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

function extractTaskHistoryText(task: Task | undefined): string[] {
  return task?.history?.flatMap((message) => {
    const text = extractMessageText(message);
    return text !== undefined ? [text] : [];
  }) ?? [];
}

function extractArtifactText(artifacts: readonly Artifact[] | undefined): string[] {
  return (
    artifacts?.flatMap((artifact) => textParts(artifact.parts)) ??
    []
  );
}

function extractTaskText(task: Task): string | undefined {
  const artifacts = extractArtifacts(task);
  const texts = [
    ...extractTaskHistoryText(task),
    ...extractArtifactText(artifacts),
  ];

  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function isTerminalTaskStatus(status: string | undefined): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "canceled" ||
    status === "rejected"
  );
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
  const streamingAvailabilityKnown = target.streamingSupported !== undefined;
  const canWatch =
    context.taskId !== undefined &&
    (streamingAvailabilityKnown ? target.streamingSupported !== false : true);
  const task: TaskContinuationSummary | undefined =
    context.taskId !== undefined
      ? {
          task_id: context.taskId,
          ...(context.taskHandle !== undefined
            ? { task_handle: context.taskHandle }
            : {}),
          ...(context.status !== undefined ? { status: context.status } : {}),
          can_resume_send: !isTerminalTaskStatus(context.status),
          can_send: !isTerminalTaskStatus(context.status),
          can_status: true,
          can_cancel: !isTerminalTaskStatus(context.status),
          can_watch: canWatch,
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
    target: {
      target_url: target.baseUrl,
      card_path: target.cardPath,
      preferred_transports: [...target.preferredTransports],
      ...(target.alias !== undefined ? { target_alias: target.alias } : {}),
    },
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
  const taskId = raw.taskId ?? context.taskId;

  return withContinuationContext(
    target,
    {
      ...baseSummary(target),
      response_kind: "message",
      ...(messageText !== undefined ? { message_text: messageText } : {}),
    },
    {
      ...(taskId !== undefined ? { taskId } : {}),
      contextId: raw.contextId ?? context.contextId,
      ...(taskId !== undefined && context.taskHandle !== undefined
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
      response_kind: "task",
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

function artifactFromUpdate(raw: TaskArtifactUpdateEvent): Artifact {
  return cloneArtifact({
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
  });
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
      response_kind: "task",
      artifacts: [artifactFromUpdate(raw)],
    },
    {
      taskId: raw.taskId ?? context.taskId,
      contextId: raw.contextId ?? context.contextId,
      taskHandle: context.taskHandle,
    },
  );
}

function isTaskBearingEvent(event: A2AStreamEventData): boolean {
  return (
    event.kind === "task" ||
    event.kind === "status-update" ||
    event.kind === "artifact-update"
  );
}

type AccumulatedTaskState = {
  latestMessage?: Message;
  latestTask?: Task;
  latestTaskId?: string;
  latestContextId?: string;
  latestStatus?: string;
  artifacts: Map<string, Artifact>;
};

function replaceArtifacts(
  artifacts: readonly Artifact[] | undefined,
): Map<string, Artifact> {
  const next = new Map<string, Artifact>();

  for (const artifact of artifacts ?? []) {
    next.set(artifact.artifactId, cloneArtifact(artifact));
  }

  return next;
}

function applyArtifactUpdate(
  artifacts: Map<string, Artifact>,
  update: TaskArtifactUpdateEvent,
): void {
  const next = artifactFromUpdate(update);
  const previous = artifacts.get(next.artifactId);

  if (!previous || update.append !== true) {
    artifacts.set(next.artifactId, next);
    return;
  }

  artifacts.set(next.artifactId, {
    artifactId: previous.artifactId,
    parts: [...previous.parts, ...next.parts],
    ...(next.description !== undefined
      ? { description: next.description }
      : previous.description !== undefined
        ? { description: previous.description }
        : {}),
    ...(next.extensions !== undefined
      ? { extensions: [...next.extensions] }
      : previous.extensions !== undefined
        ? { extensions: [...previous.extensions] }
        : {}),
    ...(next.metadata !== undefined
      ? { metadata: next.metadata }
      : previous.metadata !== undefined
        ? { metadata: previous.metadata }
        : {}),
    ...(next.name !== undefined
      ? { name: next.name }
      : previous.name !== undefined
        ? { name: previous.name }
        : {}),
  });
}

function extractArtifactsFromState(
  state: AccumulatedTaskState,
): Artifact[] | undefined {
  if (state.artifacts.size === 0) {
    return undefined;
  }

  return [...state.artifacts.values()].map(cloneArtifact);
}

function extractTaskTextFromState(
  state: AccumulatedTaskState,
  artifacts: readonly Artifact[] | undefined,
): string | undefined {
  const texts = [
    ...extractTaskHistoryText(state.latestTask),
    ...extractArtifactText(artifacts),
  ];

  if (texts.length === 0 && state.latestMessage !== undefined) {
    const latestMessageText = extractMessageText(state.latestMessage);

    if (latestMessageText !== undefined) {
      texts.push(latestMessageText);
    }
  }

  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function accumulateTaskState(
  events: readonly A2AStreamEventData[],
): AccumulatedTaskState {
  const state: AccumulatedTaskState = {
    artifacts: new Map<string, Artifact>(),
  };

  for (const event of events) {
    switch (event.kind) {
      case "message":
        state.latestMessage = event;
        if (event.taskId !== undefined) {
          state.latestTaskId = event.taskId;
        }
        if (event.contextId !== undefined) {
          state.latestContextId = event.contextId;
        }
        break;
      case "task":
        state.latestTask = structuredClone(event) as Task;
        state.latestTaskId = event.id;
        state.latestContextId = event.contextId;
        state.latestStatus = event.status.state;
        state.artifacts = replaceArtifacts(event.artifacts);
        break;
      case "status-update":
        if (event.taskId !== undefined) {
          state.latestTaskId = event.taskId;
        }
        if (event.contextId !== undefined) {
          state.latestContextId = event.contextId;
        }
        state.latestStatus = event.status.state;
        break;
      case "artifact-update":
        if (event.taskId !== undefined) {
          state.latestTaskId = event.taskId;
        }
        if (event.contextId !== undefined) {
          state.latestContextId = event.contextId;
        }
        applyArtifactUpdate(state.artifacts, event);
        break;
    }
  }

  return state;
}

export function summarizeStreamEvents(
  target: ResolvedTarget,
  events: readonly A2AStreamEventData[],
  context: SummaryTaskContext = {},
): RemoteAgentSummary {
  if (events.length === 0) {
    throw new TypeError("stream summary requires at least one event");
  }

  const taskBearingEvents = events.filter(isTaskBearingEvent);

  if (taskBearingEvents.length === 0) {
    const latestEvent = events.at(-1);

    if (!latestEvent || latestEvent.kind !== "message") {
      throw new TypeError("message-only stream summary requires message events");
    }

    const messageText = extractMessageText(latestEvent);
    const responseKind =
      events.length === 1 && latestEvent.kind === "message"
        ? "message"
        : undefined;
    const taskId = latestEvent.taskId ?? context.taskId;

    return withContinuationContext(
      target,
      {
        ...baseSummary(target),
        ...(responseKind !== undefined ? { response_kind: responseKind } : {}),
        ...(messageText !== undefined ? { message_text: messageText } : {}),
      },
      {
        ...(taskId !== undefined ? { taskId } : {}),
        contextId: latestEvent.contextId ?? context.contextId,
        ...(taskId !== undefined && context.taskHandle !== undefined
          ? { taskHandle: context.taskHandle }
          : {}),
      },
    );
  }

  const accumulated = accumulateTaskState(events);
  const artifacts = extractArtifactsFromState(accumulated);
  const messageText = extractTaskTextFromState(accumulated, artifacts);

  return withContinuationContext(
    target,
    {
      ...baseSummary(target),
      response_kind: "task",
      ...(messageText !== undefined ? { message_text: messageText } : {}),
      ...(artifacts !== undefined ? { artifacts } : {}),
    },
    {
      taskId: accumulated.latestTaskId ?? context.taskId,
      contextId: accumulated.latestContextId ?? context.contextId,
      taskHandle: context.taskHandle,
      status: accumulated.latestStatus,
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
          response_kind: "task",
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
    ...(entry.target.streamingSupported !== undefined
      ? { streaming_supported: entry.target.streamingSupported }
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
    summarizeStreamEvents(target, events, context),
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
  raw: A2AStreamEventData | readonly A2AStreamEventData[],
  context: SummaryTaskContext = {},
): StreamUpdateEnvelope<TAction> {
  const events = Array.isArray(raw) ? [...raw] : [raw];
  const finalEvent = events.at(-1);

  if (!finalEvent) {
    throw new TypeError("stream update requires at least one event");
  }

  return {
    ok: true,
    operation: REMOTE_AGENT_OPERATION,
    action,
    phase: "update",
    summary: summarizeStreamEvents(target, events, context),
    raw: finalEvent,
  };
}
