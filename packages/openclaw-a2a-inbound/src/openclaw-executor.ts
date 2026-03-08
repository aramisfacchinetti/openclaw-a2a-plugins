import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";
import {
  resolveInboundRouteEnvelopeBuilderWithRuntime,
  type ChannelGatewayContext,
  type ChannelLogSink,
} from "openclaw/plugin-sdk";
import type { A2AInboundAccountConfig } from "./config.js";
import { CHANNEL_ID } from "./constants.js";
import { log } from "./logging.js";
import {
  collectReplyText,
  createAgentTextMessage,
  summarizeBufferedReplies,
} from "./response-mapping.js";
import { buildInboundRouteContext } from "./session-routing.js";

type OpenClawConfig = ChannelGatewayContext["cfg"];
type ChannelRuntime = NonNullable<ChannelGatewayContext["channelRuntime"]>;

export interface OpenClawA2AExecutorOptions {
  accountId: string;
  account: A2AInboundAccountConfig;
  cfg: OpenClawConfig;
  runtime: ChannelRuntime;
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
          runtime: this.options.runtime as never,
          sessionStore: this.options.account.sessionStore,
        },
      );

      const { storePath, body } = buildEnvelope({
        channel: "A2A",
        from: inbound.conversationLabel,
        body: inbound.body,
        timestamp: inbound.timestamp,
      });

      const ctxPayload = this.options.runtime.reply.finalizeInboundContext({
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

      await this.options.runtime.session.recordInboundSession({
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

      const chunks: string[] = [];

      await this.options.runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: this.options.cfg,
        dispatcherOptions: {
          deliver: async (payload) => {
            collectReplyText(chunks, payload);
          },
        },
      });

      eventBus.publish(
        createAgentTextMessage({
          contextId: requestContext.contextId,
          text:
            summarizeBufferedReplies(chunks) ??
            "OpenClaw completed the request without a text reply.",
        }),
      );
      eventBus.finished();
    } catch (error) {
      log(this.options.log, "error", "a2a.inbound.execute.error", {
        accountId: this.options.accountId,
        error: String(error),
      });
      throw error;
    }
  }

  async cancelTask(): Promise<void> {}
}

export function createOpenClawA2AExecutor(
  options: OpenClawA2AExecutorOptions,
): AgentExecutor {
  return new OpenClawA2AExecutor(options);
}
