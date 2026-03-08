import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";
import {
  resolveInboundRouteEnvelopeBuilderWithRuntime,
  type ChannelGatewayContext,
  type ChannelLogSink,
  type PluginRuntime,
} from "openclaw/plugin-sdk";
import type { A2AInboundAccountConfig } from "./config.js";
import { CHANNEL_ID } from "./constants.js";
import type { A2ALiveExecutionRegistry } from "./live-execution-registry.js";
import { log } from "./logging.js";
import { createAgentTextMessage } from "./response-mapping.js";
import { buildInboundRouteContext } from "./session-routing.js";
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
  liveExecutions: A2ALiveExecutionRegistry;
  log?: ChannelLogSink;
}

export class OpenClawA2AExecutor implements AgentExecutor {
  constructor(private readonly options: OpenClawA2AExecutorOptions) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const inbound = buildInboundRouteContext(
      requestContext,
      this.options.accountId,
    );

    if (inbound.body.length === 0) {
      eventBus.publish(
        createAgentTextMessage({
          contextId: requestContext.contextId,
          text: "The inbound A2A request did not contain any text parts.",
        }),
      );
      eventBus.finished();
      return;
    }

    const coordinator = new A2ATaskExecutionCoordinator(
      requestContext,
      eventBus,
      this.options.liveExecutions,
    );

    let unsubscribeAgentEvents: (() => boolean) | undefined;

    try {
      const peer = {
        kind: "direct" as const,
        id: inbound.peerId,
      };

      // The external plugin runtime exposes the same inbound-envelope helpers as
      // built-in channels, but the generic type surface is stricter than the
      // public ChannelGatewayContext contract.
      const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime(
        {
          cfg: this.options.cfg,
          channel: CHANNEL_ID,
          accountId: this.options.accountId,
          peer,
          runtime: this.options.channelRuntime as never,
          sessionStore: this.options.account.sessionStore,
        },
      );

      const { storePath, body } = buildEnvelope({
        channel: "A2A",
        from: inbound.conversationLabel,
        body: inbound.body,
        timestamp: inbound.timestamp,
      });

      const ctxPayload = this.options.channelRuntime.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: inbound.body,
        RawBody: inbound.body,
        CommandBody: inbound.body,
        From: inbound.from,
        To: inbound.to,
        SessionKey: route.sessionKey,
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
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: inbound.to,
        Timestamp: inbound.timestamp,
      });

      await this.options.channelRuntime.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
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
