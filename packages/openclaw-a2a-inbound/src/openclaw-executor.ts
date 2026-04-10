import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";
import { A2AError } from "@a2a-js/sdk/server";
import {
  createInboundEnvelopeBuilder,
  type ChannelGatewayContext,
  type ChannelLogSink,
  type PluginRuntime,
} from "openclaw/plugin-sdk";
import type { A2AInboundAccountConfig } from "./config.js";
import { CHANNEL_ID } from "./constants.js";
import type { A2ALiveExecutionRegistry } from "./live-execution-registry.js";
import { log } from "./logging.js";
import { createAgentTextMessage } from "./response-mapping.js";
import {
  buildInboundRouteContext,
  resolveInboundPeerIdentity,
  validateInboundMessageParts,
} from "./session-routing.js";
import type { A2ATaskRuntimeStore, StoredTaskBinding } from "./task-store.js";
import {
  A2ATaskExecutionCoordinator,
  type OpenClawExecutionEvent,
} from "./task-execution-coordinator.js";

type OpenClawConfig = ChannelGatewayContext["cfg"];
type ChannelRuntime = NonNullable<ChannelGatewayContext["channelRuntime"]>;
type OpenClawRuntimeEvent = Parameters<
  Parameters<PluginRuntime["events"]["onAgentEvent"]>[0]
>[0];

export interface OpenClawA2AExecutorOptions {
  accountId: string;
  account: A2AInboundAccountConfig;
  cfg: OpenClawConfig;
  channelRuntime: ChannelRuntime;
  pluginRuntime: PluginRuntime;
  taskRuntime: A2ATaskRuntimeStore;
  liveExecutions: A2ALiveExecutionRegistry;
  log?: ChannelLogSink;
}

function createPinnedEnvelopeBuilder(params: {
  cfg: OpenClawConfig;
  binding: StoredTaskBinding;
  channelRuntime: ChannelRuntime;
  sessionStore: string | undefined;
}) {
  return createInboundEnvelopeBuilder({
    cfg: params.cfg,
    route: {
      agentId: params.binding.agentId,
      sessionKey: params.binding.sessionKey,
    },
    sessionStore: params.sessionStore,
    resolveStorePath: () => params.binding.storePath,
    readSessionUpdatedAt: params.channelRuntime.session.readSessionUpdatedAt,
    resolveEnvelopeFormatOptions: params.channelRuntime.reply.resolveEnvelopeFormatOptions,
    formatAgentEnvelope: params.channelRuntime.reply.formatAgentEnvelope,
  });
}

export class OpenClawA2AExecutor implements AgentExecutor {
  constructor(private readonly options: OpenClawA2AExecutorOptions) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    validateInboundMessageParts(requestContext.userMessage);

    const boundPeer = requestContext.task
      ? undefined
      : resolveInboundPeerIdentity(requestContext);
    let binding: StoredTaskBinding | undefined;
    const coordinator = new A2ATaskExecutionCoordinator(
      requestContext,
      eventBus,
      this.options.liveExecutions,
      this.options.account.agentStyle,
      undefined,
    );
    let unsubscribeAgentEvents: (() => boolean) | undefined;

    try {
      if (requestContext.task) {
        binding = await this.options.taskRuntime.loadBinding(requestContext.taskId);
      } else if (boundPeer) {
        const route = this.options.channelRuntime.routing.resolveAgentRoute({
          cfg: this.options.cfg,
          channel: CHANNEL_ID,
          accountId: this.options.accountId,
          peer: {
            kind: boundPeer.kind,
            id: boundPeer.id,
          },
        });
        const createdAt = new Date().toISOString();

        binding = {
          schemaVersion: 1,
          agentId: route.agentId,
          channel: route.channel,
          accountId: route.accountId,
          matchedBy: route.matchedBy,
          sessionKey: route.sessionKey,
          mainSessionKey: route.mainSessionKey,
          storePath: this.options.channelRuntime.session.resolveStorePath(
            this.options.account.sessionStore,
            {
              agentId: route.agentId,
            },
          ),
          peer: boundPeer,
          createdAt,
          updatedAt: createdAt,
        };
        this.options.taskRuntime.primeBinding(requestContext.taskId, binding);
      }

      if (!binding) {
        throw new Error(
          `Task ${requestContext.taskId} cannot continue without a persisted OpenClaw binding.`,
        );
      }

      const inbound = await buildInboundRouteContext({
        requestContext,
        accountId: this.options.accountId,
        peerId: binding.peer.id,
      });

      if (!inbound.hasUsableParts) {
        eventBus.publish(
          createAgentTextMessage({
            contextId: requestContext.contextId,
            text: "The inbound A2A request did not contain any supported text or data parts.",
          }),
        );
        eventBus.finished();
        return;
      }

      coordinator.setExpectedSessionKey(binding.sessionKey);
      const buildEnvelope = createPinnedEnvelopeBuilder({
        cfg: this.options.cfg,
        binding,
        channelRuntime: this.options.channelRuntime,
        sessionStore: this.options.account.sessionStore,
      });

      const { body } = buildEnvelope({
        channel: "A2A",
        from: inbound.conversationLabel,
        body: inbound.bodyForAgent,
        timestamp: inbound.timestamp,
      });
      const shouldEmitGenericOriginRouting =
        this.options.account.originRoutingPolicy === "legacy-origin-routing";

      const ctxPayload = this.options.channelRuntime.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: inbound.bodyForAgent,
        RawBody: inbound.rawBody,
        CommandBody: inbound.commandBody,
        BodyForCommands: inbound.bodyForCommands,
        UntrustedContext: inbound.untrustedContext,
        From: inbound.from,
        To: inbound.to,
        SessionKey: binding.sessionKey,
        AccountId: this.options.accountId,
        ChatType: "direct",
        ConversationLabel: inbound.conversationLabel,
        SenderName: requestContext.context?.user?.userName ?? undefined,
        SenderId: inbound.peerId,
        CommandAuthorized: true,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        MessageSid: requestContext.userMessage.messageId,
        MessageSidFull: requestContext.userMessage.messageId,
        ...(shouldEmitGenericOriginRouting
          ? {
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: inbound.to,
            }
          : {}),
        Timestamp: inbound.timestamp,
      });
      ctxPayload.SessionKey = binding.sessionKey;

      await this.options.channelRuntime.session.recordInboundSession({
        storePath: binding.storePath,
        sessionKey: binding.sessionKey,
        ctx: ctxPayload,
        onRecordError: (error) => {
          log(this.options.log, "warn", "a2a.inbound.session.record_error", {
            accountId: this.options.accountId,
            error: String(error),
          });
        },
      });

      unsubscribeAgentEvents = this.options.pluginRuntime.events.onAgentEvent(
        (event: OpenClawRuntimeEvent) => {
          coordinator.handleAgentEvent(event as OpenClawExecutionEvent);
        },
      );

      coordinator.prepareForExecution();

      await this.options.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: this.options.cfg,
        dispatcherOptions: {
          deliver: async (payload, info) => {
            coordinator.handleReplyPayload(payload, info.kind);
          },
        },
        replyOptions: {
          abortSignal: coordinator.signal,
          onAgentRunStart: (runId) => coordinator.handleAgentRunStart(runId),
          onAssistantMessageStart: () => coordinator.handleAssistantMessageStart(),
        },
      });

      await coordinator.finalizeSuccess();
    } catch (error) {
      if (error instanceof A2AError && error.code === -32005) {
        if (coordinator.isPromoted()) {
          await coordinator.finalizeError(error);
        }

        throw error;
      }

      log(this.options.log, "error", "a2a.inbound.execute.error", {
        accountId: this.options.accountId,
        error: String(error),
      });
      await coordinator.finalizeError(error);
    } finally {
      unsubscribeAgentEvents?.();
      eventBus.finished();
    }
  }

  async cancelTask(
    taskId: string,
    _eventBus: ExecutionEventBus,
  ): Promise<void> {
    const record = this.options.liveExecutions.requestCancellation(taskId);

    if (!record) {
      return;
    }

    if (record.cancel) {
      await record.cancel();
      return;
    }

    record.abortController.abort(
      new DOMException("A2A task canceled.", "AbortError"),
    );
  }
}

export function createOpenClawA2AExecutor(
  options: OpenClawA2AExecutorOptions,
): AgentExecutor {
  return new OpenClawA2AExecutor(options);
}
