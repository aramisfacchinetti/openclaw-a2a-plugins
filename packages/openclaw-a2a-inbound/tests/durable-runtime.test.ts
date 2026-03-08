import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { createA2AInboundServer } from "../dist/a2a-server.js";
import {
  createArtifactUpdate,
  createTaskSnapshot,
  createTaskStatusUpdate,
} from "../dist/response-mapping.js";
import { INTERRUPTED_TASK_FAILURE_TEXT } from "../dist/task-store.js";
import {
  createPluginRuntimeHarness,
  createTestAccount,
  createUserMessage,
  waitFor,
} from "./runtime-harness.js";

type StreamEvent = Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | Message;
type JournalRecord = {
  sequence: number;
  committedAt: string;
  event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
  provenance: Record<string, unknown>;
};

function isTask(event: StreamEvent): event is Task {
  return event.kind === "task";
}

function isStatusUpdate(event: StreamEvent): event is TaskStatusUpdateEvent {
  return event.kind === "status-update";
}

function isArtifactUpdate(event: StreamEvent): event is TaskArtifactUpdateEvent {
  return event.kind === "artifact-update";
}

function getOpenClawMetadata(
  value: { metadata?: Record<string, unknown> | undefined },
): Record<string, unknown> | undefined {
  const metadata = value.metadata;

  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    typeof metadata.openclaw !== "object" ||
    metadata.openclaw === null ||
    Array.isArray(metadata.openclaw)
  ) {
    return undefined;
  }

  return metadata.openclaw as Record<string, unknown>;
}

function getCurrentSequence(task: Task): number | undefined {
  const openclaw = getOpenClawMetadata(task);
  return typeof openclaw?.currentSequence === "number"
    ? openclaw.currentSequence
    : undefined;
}

function getEventSequence(
  event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): number | undefined {
  const openclaw = getOpenClawMetadata(event);
  return typeof openclaw?.sequence === "number" ? openclaw.sequence : undefined;
}

function isReplayed(
  event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): boolean {
  return getOpenClawMetadata(event)?.replayed === true;
}

function createServerHarness(
  script: Parameters<typeof createPluginRuntimeHarness>[0],
  accountOverrides: Partial<ReturnType<typeof createTestAccount>> = {},
) {
  const { pluginRuntime } = createPluginRuntimeHarness(script);
  return createA2AInboundServer({
    accountId: "default",
    account: createTestAccount(accountOverrides),
    cfg: {},
    channelRuntime: pluginRuntime.channel,
    pluginRuntime,
  });
}

function taskDirectory(rootPath: string, taskId: string): string {
  return join(
    rootPath,
    "tasks",
    Buffer.from(taskId, "utf8").toString("base64url"),
  );
}

async function writeSeededTask(params: {
  rootPath: string;
  task: Task;
  runtime: Record<string, unknown>;
  events: JournalRecord[];
}): Promise<void> {
  const dir = taskDirectory(params.rootPath, params.task.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "snapshot.json"), JSON.stringify(params.task, null, 2));
  await writeFile(join(dir, "runtime.json"), JSON.stringify(params.runtime, null, 2));
  await writeFile(
    join(dir, "events.ndjson"),
    params.events.map((event) => JSON.stringify(event)).join("\n") +
      (params.events.length > 0 ? "\n" : ""),
  );
}

async function readSnapshot(rootPath: string, taskId: string): Promise<Task> {
  const raw = await readFile(join(taskDirectory(rootPath, taskId), "snapshot.json"), "utf8");
  return JSON.parse(raw) as Task;
}

async function readJournal(rootPath: string, taskId: string): Promise<JournalRecord[]> {
  const raw = await readFile(join(taskDirectory(rootPath, taskId), "events.ndjson"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalRecord);
}

function createWorkingSeed(params?: {
  taskId?: string;
  contextId?: string;
  lease?: Record<string, unknown> | undefined;
}): {
  taskId: string;
  snapshot: Task;
  runtime: Record<string, unknown>;
  events: JournalRecord[];
} {
  const taskId = params?.taskId ?? randomUUID();
  const contextId = params?.contextId ?? randomUUID();
  const userMessage = createUserMessage({ taskId, contextId });
  const submitted = createTaskStatusUpdate({
    taskId,
    contextId,
    state: "submitted",
    metadata: {
      openclaw: {
        sequence: 1,
      },
    },
  });
  const working = createTaskStatusUpdate({
    taskId,
    contextId,
    state: "working",
    metadata: {
      openclaw: {
        sequence: 2,
      },
    },
  });
  const snapshot = createTaskSnapshot({
    taskId,
    contextId,
    state: "working",
    history: [userMessage],
    metadata: {
      openclaw: {
        currentSequence: 2,
        runId: "run-orphaned",
      },
    },
  });

  return {
    taskId,
    snapshot,
    runtime: {
      currentSequence: 2,
      ...(typeof params?.lease === "undefined" ? {} : { lease: params.lease }),
    },
    events: [
      {
        sequence: 1,
        committedAt: "2026-03-08T10:00:00.000Z",
        event: submitted,
        provenance: {
          runId: "run-orphaned",
        },
      },
      {
        sequence: 2,
        committedAt: "2026-03-08T10:00:01.000Z",
        event: working,
        provenance: {
          runId: "run-orphaned",
        },
      },
    ],
  };
}

test("startup sweep finalizes orphaned durable tasks before any API call", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-startup-"));
  const seed = createWorkingSeed({
    lease: {
      ownerId: "lost-process",
      runId: "run-orphaned",
      state: "active",
      heartbeatAt: "2026-03-08T09:59:30.000Z",
      leaseExpiresAt: "2026-03-08T09:59:40.000Z",
    },
  });
  let server: ReturnType<typeof createServerHarness> | undefined;

  try {
    await writeSeededTask({
      rootPath,
      task: seed.snapshot,
      runtime: seed.runtime,
      events: seed.events,
    });

    server = createServerHarness(async () => {}, {
      taskStore: {
        kind: "json-file",
        path: rootPath,
      },
    });

    const sweptSnapshot = await readSnapshot(rootPath, seed.taskId);
    const journal = await readJournal(rootPath, seed.taskId);

    assert.equal(sweptSnapshot.status.state, "failed");
    assert.equal(getCurrentSequence(sweptSnapshot), 3);
    assert.equal(journal.at(-1)?.sequence, 3);
    assert.equal(
      journal.at(-1)?.event.status.message?.parts[0] &&
        "text" in journal.at(-1)!.event.status.message!.parts[0]
        ? journal.at(-1)!.event.status.message!.parts[0].text
        : undefined,
      INTERRUPTED_TASK_FAILURE_TEXT,
    );
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("getTask alone reconciles an orphaned durable task to failed", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-get-task-"));
  const seed = createWorkingSeed();
  let server: ReturnType<typeof createServerHarness> | undefined;

  try {
    server = createServerHarness(async () => {}, {
      taskStore: {
        kind: "json-file",
        path: rootPath,
      },
    });

    await writeSeededTask({
      rootPath,
      task: seed.snapshot,
      runtime: seed.runtime,
      events: seed.events,
    });

    const reconciled = await server.requestHandler.getTask({
      id: seed.taskId,
      historyLength: 10,
    });

    assert.equal(reconciled.status.state, "failed");
    assert.equal(getCurrentSequence(reconciled), 3);
    assert.equal(
      reconciled.status.message?.parts[0] &&
        "text" in reconciled.status.message.parts[0]
        ? reconciled.status.message.parts[0].text
        : undefined,
      INTERRUPTED_TASK_FAILURE_TEXT,
    );
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("resubscribe reconciles an orphaned durable task to failed and ends cleanly", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-resubscribe-"));
  const seed = createWorkingSeed();
  let server: ReturnType<typeof createServerHarness> | undefined;

  try {
    server = createServerHarness(async () => {}, {
      taskStore: {
        kind: "json-file",
        path: rootPath,
      },
    });

    await writeSeededTask({
      rootPath,
      task: seed.snapshot,
      runtime: seed.runtime,
      events: seed.events,
    });

    const resubscribed: Array<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];

    for await (const event of server.requestHandler.resubscribe({
      id: seed.taskId,
    })) {
      resubscribed.push(event);
    }

    assert.equal(resubscribed.length, 1);
    assert.equal(resubscribed[0]?.kind, "task");
    if (!resubscribed[0] || !isTask(resubscribed[0])) {
      assert.fail("expected current task snapshot");
    }

    assert.equal(resubscribed[0].status.state, "failed");
    assert.equal(getCurrentSequence(resubscribed[0]), 3);
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("cancelTask returns failed after process loss instead of canceled", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-cancel-"));
  const seed = createWorkingSeed();
  let server: ReturnType<typeof createServerHarness> | undefined;

  try {
    server = createServerHarness(async () => {}, {
      taskStore: {
        kind: "json-file",
        path: rootPath,
      },
    });

    await writeSeededTask({
      rootPath,
      task: seed.snapshot,
      runtime: seed.runtime,
      events: seed.events,
    });

    const canceled = await server.requestHandler.cancelTask({ id: seed.taskId });

    assert.equal(canceled.status.state, "failed");
    assert.equal(getCurrentSequence(canceled), 3);
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("cursor replay returns committed submitted, working, artifact, and final events in order", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-replay-"));
  let server: ReturnType<typeof createServerHarness> | undefined;

  try {
    server = createServerHarness(
      async ({ params, emit }) => {
        params.replyOptions?.onAgentRunStart?.("run-replay");
        emit({
          runId: "run-replay",
          stream: "lifecycle",
          data: { phase: "start" },
        });
        emit({
          runId: "run-replay",
          stream: "assistant",
          data: { delta: "Draft" },
        });
        emit({
          runId: "run-replay",
          stream: "tool",
          data: {
            phase: "result",
            name: "lookup",
            toolCallId: "lookup/1",
            isError: false,
            result: { hits: 2 },
          },
        });
        await params.dispatcherOptions.deliver(
          { text: "Tool summary" },
          { kind: "tool" },
        );
        await params.dispatcherOptions.deliver(
          { text: "Final answer" },
          { kind: "final" },
        );
        emit({
          runId: "run-replay",
          stream: "lifecycle",
          data: { phase: "end" },
        });
      },
      {
        taskStore: {
          kind: "json-file",
          path: rootPath,
        },
      },
    );

    const result = await server.requestHandler.sendMessage({
      message: createUserMessage(),
      configuration: {
        blocking: false,
      },
    });

    assert.equal(isTask(result), true);
    if (!isTask(result)) {
      assert.fail("expected completed task");
    }

    await waitFor(async () => {
      const snapshot = await server!.requestHandler.getTask({
        id: result.id,
        historyLength: 10,
      });

      return snapshot.status.state === "completed";
    });

    const replayed: Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];

    for await (const event of server.requestHandler.resubscribe({
      id: result.id,
      metadata: {
        openclaw: {
          afterSequence: 0,
        },
      },
    })) {
      replayed.push(event);
    }

    assert.deepEqual(
      replayed
        .filter(isStatusUpdate)
        .map((event) => [event.status.state, event.final]),
      [
        ["submitted", false],
        ["working", false],
        ["completed", true],
      ],
    );
    assert.ok(
      replayed.some(
        (event) =>
          isArtifactUpdate(event) && event.artifact.artifactId === "assistant-output",
      ),
    );
    assert.ok(
      replayed.some(
        (event) =>
          isArtifactUpdate(event) &&
          event.artifact.artifactId === "tool-progress-lookup_1",
      ),
    );
    assert.deepEqual(
      replayed.map((event) => getEventSequence(event)),
      replayed.map((_, index) => index + 1),
    );
    const replayFlags = replayed.map((event) => getOpenClawMetadata(event)?.replayed);
    assert.equal(
      replayFlags.every((flag) => flag === true),
      true,
      JSON.stringify(replayFlags),
    );
  } finally {
    if (server && typeof result !== "undefined" && isTask(result)) {
      await waitFor(async () => {
        const snapshot = await server.requestHandler.getTask({
          id: result.id,
          historyLength: 10,
        });

        return snapshot.status.state === "completed";
      });
    }

    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("metadata exposes currentSequence plus sequence and replayed flags on live and replayed events", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-metadata-"));
  let server: ReturnType<typeof createServerHarness> | undefined;

  try {
    server = createServerHarness(
      async ({ params, emit }) => {
        params.replyOptions?.onAgentRunStart?.("run-metadata");
        emit({
          runId: "run-metadata",
          stream: "lifecycle",
          data: { phase: "start" },
        });
        emit({
          runId: "run-metadata",
          stream: "assistant",
          data: { delta: "Hello" },
        });
        await params.dispatcherOptions.deliver(
          { text: "Hello" },
          { kind: "final" },
        );
        emit({
          runId: "run-metadata",
          stream: "lifecycle",
          data: { phase: "end" },
        });
      },
      {
        taskStore: {
          kind: "json-file",
          path: rootPath,
        },
      },
    );

    const streamed: StreamEvent[] = [];

    for await (const event of server.requestHandler.sendMessageStream({
      message: createUserMessage(),
    })) {
      streamed.push(event);
    }

    const task = streamed.find(isTask);
    const liveEvents = streamed.filter(
      (event): event is TaskStatusUpdateEvent | TaskArtifactUpdateEvent =>
        isStatusUpdate(event) || isArtifactUpdate(event),
    );

    assert.ok(task);
    assert.equal(getCurrentSequence(task), 0);
    assert.equal(
      liveEvents.every((event) => typeof getEventSequence(event) === "number"),
      true,
    );
    assert.equal(liveEvents.some((event) => isReplayed(event)), false);

    const persisted = await server.requestHandler.getTask({
      id: task.id,
      historyLength: 10,
    });

    const replayed: Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];

    for await (const event of server.requestHandler.resubscribe({
      id: task.id,
      metadata: {
        openclaw: {
          afterSequence: 0,
        },
      },
    })) {
      replayed.push(event);
    }

    assert.equal(getCurrentSequence(persisted), liveEvents.length);
    assert.equal(replayed.every((event) => isReplayed(event)), true);
    assert.deepEqual(
      replayed.map((event) => getEventSequence(event)),
      liveEvents.map((event) => getEventSequence(event)),
    );

    const currentSnapshots: Task[] = [];
    for await (const event of server.requestHandler.resubscribe({ id: task.id })) {
      currentSnapshots.push(event);
    }

    assert.equal(currentSnapshots.length, 1);
    assert.equal(getCurrentSequence(currentSnapshots[0]!), getCurrentSequence(persisted));
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("memory mode replays only within the current process lifetime", async () => {
  let server: ReturnType<typeof createServerHarness> | undefined;
  let restarted: ReturnType<typeof createServerHarness> | undefined;

  try {
    server = createServerHarness(async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-memory");
      emit({
        runId: "run-memory",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      emit({
        runId: "run-memory",
        stream: "assistant",
        data: { delta: "Ephemeral" },
      });
      await params.dispatcherOptions.deliver(
        { text: "Ephemeral" },
        { kind: "final" },
      );
      emit({
        runId: "run-memory",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    });

    const result = await server.requestHandler.sendMessage({
      message: createUserMessage(),
      configuration: {
        blocking: false,
      },
    });

    assert.equal(isTask(result), true);
    if (!isTask(result)) {
      assert.fail("expected completed task");
    }

    const replayed: Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
    for await (const event of server.requestHandler.resubscribe({
      id: result.id,
      metadata: {
        openclaw: {
          afterSequence: 0,
        },
      },
    })) {
      replayed.push(event);
    }

    assert.ok(replayed.length > 0);

    restarted = createServerHarness(async () => {});

    await assert.rejects(
      async () =>
        restarted!.requestHandler.getTask({
          id: result.id,
          historyLength: 10,
        }),
      /not found/i,
    );
  } finally {
    restarted?.close();
    server?.close();
  }
});

test("resubscribe rejects negative, fractional, and non-numeric afterSequence cursors", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-invalid-cursor-"));
  let server: ReturnType<typeof createServerHarness> | undefined;
  let result: Message | Task | undefined;

  try {
    server = createServerHarness(
      async ({ params, emit }) => {
        params.replyOptions?.onAgentRunStart?.("run-invalid-cursor");
        emit({
          runId: "run-invalid-cursor",
          stream: "lifecycle",
          data: { phase: "start" },
        });
        await params.dispatcherOptions.deliver(
          { text: "Done" },
          { kind: "final" },
        );
        emit({
          runId: "run-invalid-cursor",
          stream: "lifecycle",
          data: { phase: "end" },
        });
      },
      {
        taskStore: {
          kind: "json-file",
          path: rootPath,
        },
      },
    );

    result = await server.requestHandler.sendMessage({
      message: createUserMessage(),
      configuration: {
        blocking: false,
      },
    });

    assert.equal(isTask(result), true);
    if (!isTask(result)) {
      assert.fail("expected completed task");
    }

    await waitFor(async () => {
      const snapshot = await server!.requestHandler.getTask({
        id: result.id,
        historyLength: 10,
      });

      return snapshot.status.state === "completed";
    });

    for (const invalidCursor of [-1, 1.5, "1"] as const) {
      await assert.rejects(
        async () => {
          for await (const _event of server!.requestHandler.resubscribe({
            id: result.id,
            metadata: {
              openclaw: {
                afterSequence: invalidCursor,
              },
            },
          })) {
            // noop
          }
        },
        /afterSequence/,
      );
    }
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("agent card advertises stateTransitionHistory only for durable json-file stores", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-agent-card-"));
  const memoryServer = createServerHarness(async () => {});
  const durableServer = createServerHarness(async () => {}, {
    taskStore: {
      kind: "json-file",
      path: rootPath,
    },
  });

  try {
    const memoryCard = await memoryServer.requestHandler.getAgentCard();
    const durableCard = await durableServer.requestHandler.getAgentCard();

    assert.equal(memoryCard.capabilities.stateTransitionHistory, undefined);
    assert.equal(durableCard.capabilities.stateTransitionHistory, true);
  } finally {
    memoryServer.close();
    durableServer.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});
