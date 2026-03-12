import { basename, extname } from "node:path";
import type { SendActionInput } from "./schemas.js";
import type { TargetCardSnapshot } from "./target-catalog.js";

const UNKNOWN_INPUT_MODE = "unknown";
const FILE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

export interface CapabilityDiagnostics {
  requested_input_modes: string[];
  advertised_input_modes: string[];
  unsupported_input_modes: string[];
  requested_output_modes: string[];
  advertised_output_modes: string[];
  unsupported_output_modes: string[];
  unknown_file_attachments: number[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function normalizeMode(mode: string): string {
  return mode.trim().toLowerCase();
}

function normalizeModeList(modes: readonly string[] | undefined): string[] {
  if (!modes) {
    return [];
  }

  const normalized = new Set<string>();

  for (const mode of modes) {
    if (!isNonEmptyString(mode)) {
      continue;
    }

    normalized.add(normalizeMode(mode));
  }

  return [...normalized];
}

function readUriBasename(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    const name = basename(parsed.pathname);
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function inferMimeTypeFromName(name: string | undefined): string | undefined {
  if (!isNonEmptyString(name)) {
    return undefined;
  }

  const extension = extname(name.trim()).toLowerCase();
  return extension.length > 0 ? FILE_MIME_BY_EXTENSION[extension] : undefined;
}

function inferMimeTypeFromUri(uri: string | undefined): string | undefined {
  if (!isNonEmptyString(uri)) {
    return undefined;
  }

  return inferMimeTypeFromName(readUriBasename(uri));
}

function requestedInputModes(
  parts: SendActionInput["parts"],
): Pick<CapabilityDiagnostics, "requested_input_modes" | "unknown_file_attachments"> {
  const requested = new Set<string>();
  const unknownFileAttachments: number[] = [];

  parts.forEach((part, index) => {
    switch (part.kind) {
      case "text":
        requested.add("text/plain");
        return;
      case "data":
        requested.add("application/json");
        return;
      case "file": {
        const mode = isNonEmptyString(part.mime_type)
          ? normalizeMode(part.mime_type)
          : inferMimeTypeFromName(part.name) ?? inferMimeTypeFromUri(part.uri);

        if (mode) {
          requested.add(mode);
          return;
        }

        requested.add(UNKNOWN_INPUT_MODE);
        unknownFileAttachments.push(index);
        return;
      }
    }
  });

  return {
    requested_input_modes: [...requested],
    unknown_file_attachments: unknownFileAttachments,
  };
}

function advertisedInputModes(card: TargetCardSnapshot | undefined): string[] {
  if (!card) {
    return [];
  }

  return normalizeModeList([
    ...card.defaultInputModes,
    ...card.skills.flatMap((skill) => skill.inputModes ?? []),
  ]);
}

function advertisedOutputModes(card: TargetCardSnapshot | undefined): string[] {
  if (!card) {
    return [];
  }

  return normalizeModeList([
    ...card.defaultOutputModes,
    ...card.skills.flatMap((skill) => skill.outputModes ?? []),
  ]);
}

function unsupportedModes(
  requestedModes: readonly string[],
  advertisedModes: readonly string[],
): string[] {
  const supported = new Set(advertisedModes);

  return requestedModes.filter(
    (mode, index) =>
      mode !== UNKNOWN_INPUT_MODE &&
      !supported.has(mode) &&
      requestedModes.indexOf(mode) === index,
  );
}

export function evaluateSendCompatibility(
  input: SendActionInput,
  acceptedOutputModes: readonly string[],
  card: TargetCardSnapshot | undefined,
): CapabilityDiagnostics {
  const inputModes = requestedInputModes(input.parts);
  const requestedOutputModes = normalizeModeList(acceptedOutputModes);
  const advertisedInput = advertisedInputModes(card);
  const advertisedOutput = advertisedOutputModes(card);

  return {
    ...inputModes,
    advertised_input_modes: advertisedInput,
    unsupported_input_modes: unsupportedModes(
      inputModes.requested_input_modes,
      advertisedInput,
    ),
    requested_output_modes: requestedOutputModes,
    advertised_output_modes: advertisedOutput,
    unsupported_output_modes: unsupportedModes(
      requestedOutputModes,
      advertisedOutput,
    ),
  };
}
