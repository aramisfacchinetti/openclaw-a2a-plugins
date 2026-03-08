import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Task } from "@a2a-js/sdk";
import { InMemoryTaskStore, type TaskStore } from "@a2a-js/sdk/server";
import type { A2AInboundTaskStoreConfig } from "./config.js";

type StoredTasks = Record<string, Task>;

class JsonFileTaskStore implements TaskStore {
  constructor(private readonly filePath: string) {}

  async load(taskId: string): Promise<Task | undefined> {
    const stored = await this.readAll();
    return stored[taskId];
  }

  async save(task: Task): Promise<void> {
    const stored = await this.readAll();
    stored[task.id] = task;
    await this.writeAll(stored);
  }

  private async readAll(): Promise<StoredTasks> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoredTasks;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code === "ENOENT") {
        return {};
      }

      throw error;
    }
  }

  private async writeAll(tasks: StoredTasks): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(tasks, null, 2));
  }
}

export function createTaskStore(config: A2AInboundTaskStoreConfig): TaskStore {
  if (config.kind === "json-file") {
    if (!config.path) {
      throw new Error(
        "taskStore.kind=json-file requires taskStore.path for openclaw-a2a-inbound",
      );
    }

    return new JsonFileTaskStore(config.path);
  }

  return new InMemoryTaskStore();
}
