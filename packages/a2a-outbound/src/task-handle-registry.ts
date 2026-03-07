import { randomUUID } from "node:crypto";
import {
  A2AOutboundError,
  ERROR_CODES,
} from "./errors.js";
import type { ResolvedTarget } from "./sdk-client-pool.js";

export interface TaskHandleRecord {
  taskHandle: string;
  target: ResolvedTarget;
  taskId: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
}

export interface TaskHandleRegistryOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

function cloneTarget(target: ResolvedTarget): ResolvedTarget {
  return {
    baseUrl: target.baseUrl,
    cardPath: target.cardPath,
    preferredTransports: [...target.preferredTransports],
    ...(target.alias !== undefined ? { alias: target.alias } : {}),
    ...(target.displayName !== undefined
      ? { displayName: target.displayName }
      : {}),
    ...(target.description !== undefined
      ? { description: target.description }
      : {}),
    ...(target.streamingSupported !== undefined
      ? { streamingSupported: target.streamingSupported }
      : {}),
  };
}

function cloneRecord(record: TaskHandleRecord): TaskHandleRecord {
  return {
    taskHandle: record.taskHandle,
    target: cloneTarget(record.target),
    taskId: record.taskId,
    createdAt: record.createdAt,
    lastAccessedAt: record.lastAccessedAt,
    expiresAt: record.expiresAt,
  };
}

function recoveryDetails(
  taskHandle: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    taskHandle,
    retryHint:
      "Retry with explicit target plus taskId, or resend the original request after a restart to obtain a new handle.",
    restartInvalidatesHandles: true,
    ...details,
  };
}

function unknownTaskHandleError(taskHandle: string): A2AOutboundError {
  return new A2AOutboundError(
    ERROR_CODES.UNKNOWN_TASK_HANDLE,
    `unknown task handle "${taskHandle}"`,
    recoveryDetails(taskHandle),
  );
}

function expiredTaskHandleError(
  taskHandle: string,
  expiresAt: number,
): A2AOutboundError {
  return new A2AOutboundError(
    ERROR_CODES.EXPIRED_TASK_HANDLE,
    `task handle "${taskHandle}" has expired`,
    recoveryDetails(taskHandle, {
      expiresAt,
    }),
  );
}

export class TaskHandleRegistry {
  private readonly ttlMs: number;

  private readonly maxEntries: number;

  private readonly now: () => number;

  private readonly entries = new Map<string, TaskHandleRecord>();

  constructor(options: TaskHandleRegistryOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
  }

  create(input: Pick<TaskHandleRecord, "target" | "taskId">): TaskHandleRecord {
    const now = this.now();
    this.pruneExpired(now);

    const record: TaskHandleRecord = {
      taskHandle: `rah_${randomUUID()}`,
      target: cloneTarget(input.target),
      taskId: input.taskId,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + this.ttlMs,
    };

    this.entries.set(record.taskHandle, record);
    this.evictLeastRecentlyUsed();

    return cloneRecord(record);
  }

  resolve(taskHandle: string): TaskHandleRecord {
    const now = this.now();
    const entry = this.requireLiveEntry(taskHandle, now);
    const next: TaskHandleRecord = {
      ...entry,
      target: cloneTarget(entry.target),
      lastAccessedAt: now,
    };

    this.entries.set(taskHandle, next);
    return cloneRecord(next);
  }

  refresh(
    taskHandle: string,
    input: Partial<Pick<TaskHandleRecord, "target" | "taskId">> = {},
  ): TaskHandleRecord {
    const now = this.now();
    const entry = this.requireLiveEntry(taskHandle, now);
    const next: TaskHandleRecord = {
      taskHandle: entry.taskHandle,
      target: cloneTarget(input.target ?? entry.target),
      taskId: input.taskId ?? entry.taskId,
      createdAt: entry.createdAt,
      lastAccessedAt: now,
      expiresAt: now + this.ttlMs,
    };

    this.entries.set(taskHandle, next);
    this.evictLeastRecentlyUsed();

    return cloneRecord(next);
  }

  private requireLiveEntry(
    taskHandle: string,
    now: number,
  ): TaskHandleRecord {
    const existing = this.entries.get(taskHandle);
    const wasExpired = existing !== undefined && existing.expiresAt <= now;

    this.pruneExpired(now);

    if (wasExpired && existing) {
      throw expiredTaskHandleError(taskHandle, existing.expiresAt);
    }

    const live = this.entries.get(taskHandle);
    if (!live) {
      throw unknownTaskHandleError(taskHandle);
    }

    return live;
  }

  private pruneExpired(now: number): void {
    for (const [taskHandle, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(taskHandle);
      }
    }
  }

  private evictLeastRecentlyUsed(): void {
    while (this.entries.size > this.maxEntries) {
      let evictTaskHandle: string | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;

      for (const [taskHandle, entry] of this.entries) {
        if (entry.lastAccessedAt < oldestAccess) {
          oldestAccess = entry.lastAccessedAt;
          evictTaskHandle = taskHandle;
        }
      }

      if (!evictTaskHandle) {
        return;
      }

      this.entries.delete(evictTaskHandle);
    }
  }
}

export function createTaskHandleRegistry(
  options: TaskHandleRegistryOptions,
): TaskHandleRegistry {
  return new TaskHandleRegistry(options);
}
