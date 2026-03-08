import { randomUUID } from "node:crypto";
import type { Message } from "@a2a-js/sdk";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectReplyText(
  chunks: string[],
  payload: unknown,
): void {
  if (!isRecord(payload)) {
    return;
  }

  const text =
    typeof payload.text === "string"
      ? payload.text
      : typeof payload.body === "string"
        ? payload.body
        : undefined;

  if (!text || text.trim().length === 0) {
    return;
  }

  chunks.push(text.trim());
}

export function summarizeBufferedReplies(
  chunks: readonly string[],
): string | undefined {
  const filtered = chunks.filter((chunk) => chunk.trim().length > 0);

  if (filtered.length === 0) {
    return undefined;
  }

  return filtered.join("\n\n");
}

export function createAgentTextMessage(params: {
  contextId: string;
  text: string;
}): Message {
  return {
    kind: "message",
    messageId: randomUUID(),
    role: "agent",
    parts: [{ kind: "text", text: params.text }],
    contextId: params.contextId,
  };
}
