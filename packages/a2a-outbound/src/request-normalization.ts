import { randomUUID } from "node:crypto";
import type { DataPart, FilePart, MessageSendParams } from "@a2a-js/sdk";
import type { RequestOptions } from "@a2a-js/sdk/client";
import type {
  DelegateRequestInput,
  DelegateStreamRequestInput,
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

export type PlainIntentAttachmentInput = FilePart | DataPart;

export interface PlainIntentRequestInput {
  input: string;
  attachments?: PlainIntentAttachmentInput[];
  timeoutMs?: number;
  serviceParameters?: Record<string, string>;
  metadata?: MessageSendParams["metadata"];
  configuration?: MessageSendParams["configuration"];
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

function cloneAttachmentPart(part: PlainIntentAttachmentInput): FilePart | DataPart {
  switch (part.kind) {
    case "file":
      return {
        kind: "file",
        file: {
          ...part.file,
        },
        ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
      };
    case "data":
      return {
        kind: "data",
        data: {
          ...part.data,
        },
        ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
      };
  }

  throw new TypeError("unsupported attachment kind");
}

function withOptionalSendFields(
  sendParams: MessageSendParams,
  metadata: MessageSendParams["metadata"] | undefined,
  configuration: MessageSendParams["configuration"] | undefined,
): MessageSendParams {
  return {
    ...sendParams,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(configuration !== undefined ? { configuration } : {}),
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
  input: PlainIntentRequestInput,
  options: SendRequestNormalizationOptions,
): NormalizedSendRequest {
  return {
    sendParams: withOptionalSendFields(
      {
        message: {
          kind: "message",
          messageId: randomUUID(),
          role: "user",
          parts: [
            {
              kind: "text",
              text: input.input,
            },
            ...(input.attachments?.map(cloneAttachmentPart) ?? []),
          ],
        },
      },
      input.metadata,
      input.configuration,
    ),
    requestOptions: buildRequestOptions(
      input.timeoutMs,
      options.defaultTimeoutMs,
      options.defaultServiceParameters,
      input.serviceParameters,
      options.signal,
    ),
  };
}

export function normalizeLegacyDelegateRequest(
  input: DelegateRequestInput | DelegateStreamRequestInput,
  options: SendRequestNormalizationOptions,
): NormalizedSendRequest {
  return {
    sendParams: withOptionalSendFields(
      {
        message: input.message,
      },
      input.metadata,
      input.configuration,
    ),
    requestOptions: buildRequestOptions(
      input.timeoutMs,
      options.defaultTimeoutMs,
      options.defaultServiceParameters,
      input.serviceParameters,
      options.signal,
    ),
  };
}
