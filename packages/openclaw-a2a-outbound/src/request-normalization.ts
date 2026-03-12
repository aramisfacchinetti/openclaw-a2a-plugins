import { randomUUID } from "node:crypto";
import type {
  DataPart,
  FilePart,
  MessageSendParams,
  Part,
  PushNotificationConfig,
  TextPart,
} from "@a2a-js/sdk";
import type { RequestOptions } from "@a2a-js/sdk/client";
import type {
  RemoteAgentPartInput,
  RemoteAgentPushNotificationConfigInput,
  SendActionInput,
} from "./schemas.js";

export interface SendRequestNormalizationOptions {
  defaultTimeoutMs: number;
  defaultServiceParameters: Record<string, string>;
  defaultAcceptedOutputModes: readonly string[];
  signal?: AbortSignal;
}

export interface NormalizedSendRequest {
  sendParams: MessageSendParams;
  requestOptions: RequestOptions;
}

function mergeServiceParameters(
  base: Record<string, string>,
  override: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged = {
    ...base,
    ...(override ?? {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const availableSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );

  if (availableSignals.length === 0) {
    throw new TypeError("expected at least one signal");
  }

  if (availableSignals.length === 1) {
    return availableSignals[0];
  }

  return AbortSignal.any(availableSignals);
}

function clonePart(part: RemoteAgentPartInput): Part {
  switch (part.kind) {
    case "text":
      return {
        kind: "text",
        text: part.text,
        ...(part.metadata !== undefined
          ? { metadata: { ...part.metadata } }
          : {}),
      } satisfies TextPart;
    case "file":
      return {
        kind: "file",
        file:
          part.uri !== undefined
            ? {
                uri: part.uri,
                ...(part.name !== undefined ? { name: part.name } : {}),
                ...(part.mime_type !== undefined
                  ? { mimeType: part.mime_type }
                  : {}),
              }
            : {
                bytes: part.bytes!,
                ...(part.name !== undefined ? { name: part.name } : {}),
                ...(part.mime_type !== undefined
                  ? { mimeType: part.mime_type }
                  : {}),
              },
        ...(part.metadata !== undefined
          ? { metadata: { ...part.metadata } }
          : {}),
      } satisfies FilePart;
    case "data":
      return {
        kind: "data",
        data: {
          ...part.data,
        },
        ...(part.metadata !== undefined
          ? { metadata: { ...part.metadata } }
          : {}),
      } satisfies DataPart;
  }
}

function clonePushNotificationConfig(
  input: RemoteAgentPushNotificationConfigInput,
): PushNotificationConfig {
  return {
    url: input.url,
    ...(input.id !== undefined ? { id: input.id } : {}),
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.authentication !== undefined
      ? {
          authentication: {
            schemes: [...input.authentication.schemes],
            ...(input.authentication.credentials !== undefined
              ? { credentials: input.authentication.credentials }
              : {}),
          },
        }
      : {}),
  };
}

function buildSendConfiguration(
  input: SendActionInput,
  defaultAcceptedOutputModes: readonly string[],
): NonNullable<MessageSendParams["configuration"]> {
  const acceptedOutputModes =
    input.accepted_output_modes !== undefined
      ? [...input.accepted_output_modes]
      : [...defaultAcceptedOutputModes];

  return {
    acceptedOutputModes,
    ...(input.blocking !== undefined ? { blocking: input.blocking } : {}),
    ...(input.history_length !== undefined
      ? { historyLength: input.history_length }
      : {}),
    ...(input.push_notification_config !== undefined
      ? {
          pushNotificationConfig: clonePushNotificationConfig(
            input.push_notification_config,
          ),
        }
      : {}),
  };
}

export function buildRequestOptions(
  timeoutMs: number | undefined,
  defaultTimeoutMs: number,
  defaultServiceParameters: Record<string, string>,
  serviceParameters: Record<string, string> | undefined,
  signal?: AbortSignal,
): RequestOptions {
  const effectiveTimeoutMs = timeoutMs ?? defaultTimeoutMs;
  const mergedServiceParameters = mergeServiceParameters(
    defaultServiceParameters,
    serviceParameters,
  );

  return {
    signal: mergeSignals([AbortSignal.timeout(effectiveTimeoutMs), signal]),
    ...(mergedServiceParameters
      ? { serviceParameters: mergedServiceParameters }
      : {}),
  };
}

export function normalizeSendRequest(
  input: SendActionInput,
  options: SendRequestNormalizationOptions,
): NormalizedSendRequest {
  const configuration = buildSendConfiguration(
    input,
    options.defaultAcceptedOutputModes,
  );

  return {
    sendParams: {
      message: {
        kind: "message",
        messageId: input.message_id ?? randomUUID(),
        role: "user",
        parts: input.parts.map(clonePart),
        ...(input.task_id !== undefined ? { taskId: input.task_id } : {}),
        ...(input.context_id !== undefined
          ? { contextId: input.context_id }
          : {}),
      },
      ...(input.metadata !== undefined
        ? { metadata: { ...input.metadata } }
        : {}),
      configuration,
    },
    requestOptions: buildRequestOptions(
      input.timeout_ms,
      options.defaultTimeoutMs,
      options.defaultServiceParameters,
      input.service_parameters,
      options.signal,
    ),
  };
}
