import assert from "node:assert/strict";
import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";

export type StreamEvent =
  | Message
  | Task
  | TaskArtifactUpdateEvent
  | TaskStatusUpdateEvent;

export type StreamParts =
  | Message["parts"]
  | NonNullable<Task["artifacts"]>[number]["parts"];

export function isMessage(event: unknown): event is Message {
  return typeof event === "object" && event !== null && (event as Message).kind === "message";
}

export function isTask(event: unknown): event is Task {
  return typeof event === "object" && event !== null && (event as Task).kind === "task";
}

export function isStatusUpdate(event: unknown): event is TaskStatusUpdateEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as TaskStatusUpdateEvent).kind === "status-update"
  );
}

export function isArtifactUpdate(event: unknown): event is TaskArtifactUpdateEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as TaskArtifactUpdateEvent).kind === "artifact-update"
  );
}

export function getArtifactText(event: TaskArtifactUpdateEvent): string | undefined {
  const textPart = event.artifact.parts.find((part) => part.kind === "text");
  return textPart?.kind === "text" ? textPart.text : undefined;
}

export function getArtifactData(
  event: TaskArtifactUpdateEvent,
): Record<string, unknown> | undefined {
  const dataPart = event.artifact.parts.find((part) => part.kind === "data");
  return dataPart?.kind === "data"
    ? (dataPart.data as Record<string, unknown>)
    : undefined;
}

export function getArtifactUpdates(
  events: readonly StreamEvent[],
  artifactId: string,
): TaskArtifactUpdateEvent[] {
  return events.filter(
    (event): event is TaskArtifactUpdateEvent =>
      isArtifactUpdate(event) &&
      (event.artifact.artifactId === artifactId ||
        (artifactId === "assistant-output" &&
          event.artifact.artifactId.startsWith("assistant-output-"))),
  );
}

export function getPartFileUris(parts: StreamParts): string[] {
  return parts.flatMap((part) =>
    part.kind === "file" && "uri" in part.file ? [part.file.uri] : []);
}

export function getPartData(
  parts: StreamParts,
): Record<string, unknown> | undefined {
  const dataPart = parts.find((part) => part.kind === "data");
  return dataPart?.kind === "data"
    ? (dataPart.data as Record<string, unknown>)
    : undefined;
}

export function getPersistedArtifactText(
  task: Task,
  artifactId: string,
): string | undefined {
  const artifact = task.artifacts?.find(
    (entry) =>
      entry.artifactId === artifactId ||
      (artifactId === "assistant-output" &&
        entry.artifactId.startsWith("assistant-output-")),
  );

  if (!artifact) {
    return undefined;
  }

  return artifact.parts
    .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

export function getPersistedArtifactData(
  task: Task,
  artifactId: string,
): Record<string, unknown> | undefined {
  const artifact = task.artifacts?.find(
    (entry) =>
      entry.artifactId === artifactId ||
      (artifactId === "assistant-output" &&
        entry.artifactId.startsWith("assistant-output-")),
  );

  if (!artifact) {
    return undefined;
  }

  const dataPart = artifact.parts.find((part) => part.kind === "data");
  return dataPart?.kind === "data"
    ? (dataPart.data as Record<string, unknown>)
    : undefined;
}

export function getStatusMessageText(
  value: Task | TaskStatusUpdateEvent,
): string | undefined {
  const part = value.status.message?.parts[0];
  return part?.kind === "text" ? part.text : undefined;
}

export function getStatusSequence(
  events: readonly StreamEvent[],
): Array<[TaskStatusUpdateEvent["status"]["state"], boolean]> {
  return events
    .filter(isStatusUpdate)
    .map((event) => [event.status.state, event.final]);
}

export function assertNoOpenClawMetadata(value: unknown, path = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoOpenClawMetadata(entry, `${path}[${index}]`));
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  const record = value as Record<string, unknown>;
  const metadata = record.metadata;

  if (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
  ) {
    assert.equal(
      "openclaw" in metadata,
      false,
      `unexpected metadata.openclaw at ${path}.metadata`,
    );
  }

  for (const [key, entry] of Object.entries(record)) {
    assertNoOpenClawMetadata(entry, `${path}.${key}`);
  }
}

export function assertNoA2AFilePartsOrTransportUrls(
  value: unknown,
  path = "root",
): void {
  if (typeof value === "string") {
    assert.doesNotMatch(
      value,
      /\/a2a\/files\//,
      `unexpected generated /a2a/files URL at ${path}`,
    );
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoA2AFilePartsOrTransportUrls(entry, `${path}[${index}]`));
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  const record = value as Record<string, unknown>;

  if (record.kind === "file") {
    assert.fail(`unexpected A2A file part at ${path}`);
  }

  for (const [key, entry] of Object.entries(record)) {
    assertNoA2AFilePartsOrTransportUrls(entry, `${path}.${key}`);
  }
}
