import { basename, extname, posix as pathPosix } from "node:path";
import type { BuiltReplyContent, JsonRecord } from "./response-mapping.js";

const OCTET_STREAM_OUTPUT_MODE = "application/octet-stream";
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

export const MAX_MATERIALIZED_FILE_BYTES = 32 * 1024 * 1024;

export interface StoredTaskFileDescriptor {
  fileId: string;
  artifactId: string;
  sourceUri: string;
  originalName?: string;
  originalMimeType?: string;
  firstEmittedAt: string;
  lastReferencedAt: string;
}

export interface StoredTaskArtifactFileIndex {
  schemaVersion: 1;
  artifactId: string;
  fileIdsByLogicalKey: Record<string, string>;
  updatedAt: string;
}

export interface StoredTaskFileMeta {
  schemaVersion: 1;
  size: number;
  materializedAt: string;
  finalUrl: string;
  contentType?: string;
  fileName?: string;
}

export interface ReplyFilePartMappingInput {
  sourceUri: string;
  originalName?: string;
  originalMimeType?: string;
  occurrenceIndex: number;
  metadata?: JsonRecord;
}

export interface ReplyFilePartMappingOutput {
  uri: string;
  name?: string;
  mimeType?: string;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function encodeTaskStorageId(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function decodeTaskStorageId(encodedValue: string): string | undefined {
  try {
    return Buffer.from(encodedValue, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

export function deriveFilesBasePath(jsonRpcPath: string): string {
  const parent = pathPosix.dirname(jsonRpcPath);
  return parent === "/" ? "/files" : `${parent}/files`;
}

export function buildTaskFileUrl(params: {
  publicBaseUrl: string;
  filesBasePath: string;
  taskId: string;
  artifactId: string;
  fileId: string;
}): string {
  const encodedTaskId = encodeTaskStorageId(params.taskId);
  const encodedArtifactId = encodeTaskStorageId(params.artifactId);
  const normalizedBasePath =
    params.filesBasePath === "/" ? "" : params.filesBasePath.replace(/\/+$/, "");
  const pathname =
    normalizedBasePath.length > 0
      ? `${normalizedBasePath}/${encodedTaskId}/${encodedArtifactId}/${params.fileId}`
      : `/${encodedTaskId}/${encodedArtifactId}/${params.fileId}`;

  return new URL(pathname, params.publicBaseUrl).toString();
}

export function buildTaskFileLogicalKey(params: {
  sourceUri: string;
  originalName?: string;
  originalMimeType?: string;
  occurrenceIndex: number;
}): string {
  return [
    params.sourceUri,
    params.originalName ?? "",
    params.originalMimeType ?? "",
    String(params.occurrenceIndex),
  ].join("\u001f");
}

export function readUriBasename(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    const name = basename(parsed.pathname);
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

export function inferMimeTypeFromUri(uri: string): string | undefined {
  const name = readUriBasename(uri);

  if (!name) {
    return undefined;
  }

  const extension = extname(name).toLowerCase();
  return FILE_MIME_BY_EXTENSION[extension];
}

export function hasFileParts(content: BuiltReplyContent): boolean {
  return content.parts.some((part) => part.kind === "file");
}

export function mapBuiltReplyContentFiles(params: {
  content: BuiltReplyContent;
  mapFile: (input: ReplyFilePartMappingInput) => ReplyFilePartMappingOutput;
}): BuiltReplyContent {
  let occurrenceIndex = 0;

  return {
    ...params.content,
    parts: params.content.parts.map((part) => {
      if (part.kind !== "file" || !("uri" in part.file)) {
        return structuredClone(part);
      }

      const originalName = readTrimmedString(part.file.name);
      const originalMimeType = readTrimmedString(part.file.mimeType);
      const mapped = params.mapFile({
        sourceUri: part.file.uri,
        originalName,
        originalMimeType,
        occurrenceIndex,
        metadata:
          typeof part.metadata === "object" &&
          part.metadata !== null &&
          !Array.isArray(part.metadata)
            ? (structuredClone(part.metadata) as JsonRecord)
            : undefined,
      });
      occurrenceIndex += 1;

      return {
        ...structuredClone(part),
        file: {
          uri: mapped.uri,
          ...(mapped.name ? { name: mapped.name } : {}),
          ...(mapped.mimeType ? { mimeType: mapped.mimeType } : {}),
        },
      };
    }),
  };
}

export function parseTaskFileRequestPath(params: {
  filesBasePath: string;
  requestPath: string;
}): {
  taskId: string;
  artifactId: string;
  fileId: string;
} | undefined {
  const normalizedBasePath =
    params.filesBasePath === "/" ? "" : params.filesBasePath.replace(/\/+$/, "");
  const expectedPrefix =
    normalizedBasePath.length > 0 ? `${normalizedBasePath}/` : "/";

  if (!params.requestPath.startsWith(expectedPrefix)) {
    return undefined;
  }

  const relativePath = params.requestPath.slice(expectedPrefix.length);
  const parts = relativePath.split("/").filter((part) => part.length > 0);

  if (parts.length !== 3) {
    return undefined;
  }

  const [encodedTaskId, encodedArtifactId, fileId] = parts;
  const taskId = decodeTaskStorageId(encodedTaskId);
  const artifactId = decodeTaskStorageId(encodedArtifactId);

  if (!taskId || !artifactId || fileId.trim().length === 0) {
    return undefined;
  }

  return {
    taskId,
    artifactId,
    fileId,
  };
}

export function parseContentDispositionFilename(
  headerValue: string | null,
): string | undefined {
  if (!headerValue) {
    return undefined;
  }

  const extendedMatch = headerValue.match(/filename\*\s*=\s*([^;]+)/i);

  if (extendedMatch) {
    const value = extendedMatch[1]?.trim();
    const encoded = value?.replace(/^utf-8''/i, "").replace(/^"(.*)"$/, "$1");

    if (encoded) {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    }
  }

  const plainMatch = headerValue.match(/filename\s*=\s*([^;]+)/i);
  const plainValue = plainMatch?.[1]?.trim().replace(/^"(.*)"$/, "$1");
  return plainValue && plainValue.length > 0 ? plainValue : undefined;
}

export function buildContentDispositionHeader(
  fileName: string | undefined,
): string | undefined {
  if (!fileName || fileName.trim().length === 0) {
    return undefined;
  }

  const trimmed = fileName.trim();
  const asciiFallback = trimmed.replace(/[^\x20-\x7E]+/g, "_").replace(/"/g, "'");

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(trimmed)}`;
}

export function resolveReplyFileName(uri: string): string | undefined {
  return readUriBasename(uri);
}

export function resolveReplyFileMimeType(uri: string): string | undefined {
  return inferMimeTypeFromUri(uri) ?? OCTET_STREAM_OUTPUT_MODE;
}
