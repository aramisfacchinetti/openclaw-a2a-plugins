import { randomUUID } from "node:crypto";
import type { DataPart, FilePart, MessageSendParams } from "@a2a-js/sdk";
import type { RequestOptions } from "@a2a-js/sdk/client";
import type {
  RemoteAgentAttachmentInput,
  SendActionInput,
} from "./schemas.js";

export interface SendRequestNormalizationOptions {
  defaultTimeoutMs: number;
  defaultServiceParameters: Record<string, string>;
  signal?: AbortSignal;
}

export interface NormalizedSendRequest {
  sendParams: MessageSendParams;
  requestOptions: RequestOptions;
}

export interface PlainIntentRequestInput {
  input: string;
  attachments?: RemoteAgentAttachmentInput[];
  history_length?: number;
  timeout_ms?: number;
  service_parameters?: Record<string, string>;
  metadata?: MessageSendParams["metadata"];
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

function cloneAttachmentPart(
  attachment: RemoteAgentAttachmentInput,
): FilePart | DataPart {
  switch (attachment.kind) {
    case "file":
      return {
        kind: "file",
        file:
          attachment.uri !== undefined
            ? {
                uri: attachment.uri,
                ...(attachment.name !== undefined ? { name: attachment.name } : {}),
                ...(attachment.mime_type !== undefined
                  ? { mimeType: attachment.mime_type }
                  : {}),
              }
            : {
                bytes: attachment.bytes!,
                ...(attachment.name !== undefined ? { name: attachment.name } : {}),
                ...(attachment.mime_type !== undefined
                  ? { mimeType: attachment.mime_type }
                  : {}),
              },
        ...(attachment.metadata !== undefined
          ? { metadata: attachment.metadata }
          : {}),
      };
    case "data":
      return {
        kind: "data",
        data: {
          ...attachment.data,
        },
        ...(attachment.metadata !== undefined
          ? { metadata: attachment.metadata }
          : {}),
      };
  }
}

function buildSendConfiguration(
  input: PlainIntentRequestInput,
): MessageSendParams["configuration"] | undefined {
  if (input.history_length === undefined) {
    return undefined;
  }

  return {
    historyLength: input.history_length,
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

export function normalizePlainIntentRequest(
  input: PlainIntentRequestInput | SendActionInput,
  options: SendRequestNormalizationOptions,
): NormalizedSendRequest {
  const normalizedInput: PlainIntentRequestInput = {
    input: input.input,
    ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
    ...(input.history_length !== undefined
      ? { history_length: input.history_length }
      : {}),
    ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
    ...(input.service_parameters !== undefined
      ? { service_parameters: input.service_parameters }
      : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };

  const configuration = buildSendConfiguration(normalizedInput);

  return {
    sendParams: {
      message: {
        kind: "message",
        messageId: randomUUID(),
        role: "user",
        parts: [
          {
            kind: "text",
            text: normalizedInput.input,
          },
          ...(normalizedInput.attachments?.map(cloneAttachmentPart) ?? []),
        ],
      },
      ...(normalizedInput.metadata !== undefined
        ? { metadata: normalizedInput.metadata }
        : {}),
      ...(configuration !== undefined ? { configuration } : {}),
    },
    requestOptions: buildRequestOptions(
      normalizedInput.timeout_ms,
      options.defaultTimeoutMs,
      options.defaultServiceParameters,
      normalizedInput.service_parameters,
      options.signal,
    ),
  };
}
