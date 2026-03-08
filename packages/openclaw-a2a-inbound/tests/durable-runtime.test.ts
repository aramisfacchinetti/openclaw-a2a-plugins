import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import {
  INTERRUPTED_TASK_FAILURE_TEXT,
  type StoredTaskBinding,
} from "../dist/task-store.js";
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

type RecordInboundSessionCall = {
  storePath: string;
  sessionKey: string;
  senderId?: string;
  messageSid?: string;
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
  runtimeOverrides?: Parameters<typeof createPluginRuntimeHarness>[1],
) {
  const { pluginRuntime } = createPluginRuntimeHarness(script, runtimeOverrides);
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

function createStoredBinding(params?: Partial<StoredTaskBinding>): StoredTaskBinding {
  return {
    schemaVersion: 1,
    agentId: "main",
    channel: "a2a",
    accountId: "default",
    matchedBy: "default",
    sessionKey: "session:test",
    mainSessionKey: "session:test",
    storePath: "/tmp/openclaw-a2a-inbound-sessions.json",
    peer: {
      kind: "direct",
      id: "peer:test",
      source: "message-id",
    },
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z",
    ...params,
  };
}

async function writeSeededTask(params: {
  rootPath: string;
  task: Task;
  runtime: Record<string, unknown>;
  events: JournalRecord[];
  binding?: StoredTaskBinding;
}): Promise<void> {
  const dir = taskDirectory(params.rootPath, params.task.id);
  await mkdir(dir, { recursive: true });
  if (params.binding) {
    await writeFile(join(dir, "binding.json"), JSON.stringify(params.binding, null, 2));
  }
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

async function readBinding(
  rootPath: string,
  taskId: string,
): Promise<StoredTaskBinding> {
  const raw = await readFile(join(taskDirectory(rootPath, taskId), "binding.json"), "utf8");
  return JSON.parse(raw) as StoredTaskBinding;
}

async function readJournal(rootPath: string, taskId: string): Promise<JournalRecord[]> {
  const raw = await readFile(join(taskDirectory(rootPath, taskId), "events.ndjson"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalRecord);
}

async function readRuntime(
  rootPath: string,
  taskId: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(join(taskDirectory(rootPath, taskId), "runtime.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function getStatusMessageText(
  value: Task | TaskStatusUpdateEvent,
): string | undefined {
  const part = value.status.message?.parts[0];
  return part?.kind === "text" ? part.text : undefined;
}

function createWorkingSeed(params?: {
  taskId?: string;
  contextId?: string;
  lease?: Record<string, unknown> | undefined;
  binding?: StoredTaskBinding;
}): {
  taskId: string;
  snapshot: Task;
  runtime: Record<string, unknown>;
  events: JournalRecord[];
  binding?: StoredTaskBinding;
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
    binding: params?.binding,
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
    const lastEvent = journal.at(-1)?.event;

    assert.equal(sweptSnapshot.status.state, "failed");
    assert.equal(getCurrentSequence(sweptSnapshot), 3);
    assert.equal(journal.at(-1)?.sequence, 3);
    assert.equal(
      lastEvent?.kind === "status-update"
        ? getStatusMessageText(lastEvent)
        : undefined,
      INTERRUPTED_TASK_FAILURE_TEXT,
    );
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("startup sweep preserves interrupted run provenance from binding and lease", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-startup-provenance-"));
  const seed = createWorkingSeed({
    lease: {
      ownerId: "lost-process",
      runId: "run-orphaned",
      state: "active",
      heartbeatAt: "2026-03-08T09:59:30.000Z",
      leaseExpiresAt: "2026-03-08T09:59:40.000Z",
    },
    binding: createStoredBinding({
      sessionKey: "session:orphaned",
      mainSessionKey: "session:orphaned",
    }),
  });
  let server: ReturnType<typeof createServerHarness> | undefined;

  try {
    await writeSeededTask({
      rootPath,
      task: seed.snapshot,
      runtime: seed.runtime,
      events: seed.events,
      binding: seed.binding,
    });

    server = createServerHarness(async () => {}, {
      taskStore: {
        kind: "json-file",
        path: rootPath,
      },
    });

    const sweptSnapshot = await readSnapshot(rootPath, seed.taskId);
    const journal = await readJournal(rootPath, seed.taskId);
    const lastRecord = journal.at(-1);

    assert.equal(getOpenClawMetadata(sweptSnapshot)?.runId, "run-orphaned");
    assert.equal(lastRecord?.provenance.runId, "run-orphaned");
    assert.equal(lastRecord?.provenance.sessionKey, "session:orphaned");
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

test("materialized reads prefer a journal-ahead terminal state over a stale active snapshot", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-journal-terminal-"));
  const seed = createWorkingSeed({
    lease: {
      ownerId: "lost-process",
      runId: "run-orphaned",
      state: "active",
      heartbeatAt: "2026-03-08T09:59:30.000Z",
      leaseExpiresAt: "2026-03-08T09:59:40.000Z",
    },
  });
  const completed = createTaskStatusUpdate({
    taskId: seed.taskId,
    contextId: seed.snapshot.contextId,
    state: "completed",
    final: true,
    messageText: "Completed durably",
  });
  let server: ReturnType<typeof createServerHarness> | undefined;

  try {
    await writeSeededTask({
      rootPath,
      task: seed.snapshot,
      runtime: seed.runtime,
      events: [
        ...seed.events,
        {
          sequence: 3,
          committedAt: "2026-03-08T10:00:02.000Z",
          event: completed,
          provenance: {
            runId: "run-orphaned",
          },
        },
      ],
    });

    server = createServerHarness(async () => {}, {
      taskStore: {
        kind: "json-file",
        path: rootPath,
      },
    });

    const journal = await readJournal(rootPath, seed.taskId);
    const lastEvent = journal.at(-1)?.event;
    assert.equal(journal.length, 3);
    assert.equal(lastEvent?.kind, "status-update");
    assert.equal(
      lastEvent?.kind === "status-update"
        ? lastEvent.status.state
        : undefined,
      "completed",
    );

    const persisted = await server.requestHandler.getTask({
      id: seed.taskId,
      historyLength: 10,
    });
    assert.equal(persisted.status.state, "completed");
    assert.equal(getCurrentSequence(persisted), 3);
    assert.equal(getStatusMessageText(persisted), "Completed durably");

    const resubscribed: Array<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
    for await (const event of server.requestHandler.resubscribe({ id: seed.taskId })) {
      resubscribed.push(event);
    }

    assert.equal(resubscribed.length, 1);
    assert.equal(isTask(resubscribed[0]), true);
    assert.equal(
      isTask(resubscribed[0]) ? resubscribed[0].status.state : undefined,
      "completed",
    );

    const canceled = await server.requestHandler.cancelTask({ id: seed.taskId });
    assert.equal(canceled.status.state, "completed");
    assert.equal(getCurrentSequence(canceled), 3);
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("startup sweep preserves a journal-ahead input-required pause instead of synthesizing failed", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-journal-paused-"));
  const seed = createWorkingSeed({
    lease: {
      ownerId: "lost-process",
      runId: "run-orphaned",
      state: "active",
      heartbeatAt: "2026-03-08T09:59:30.000Z",
      leaseExpiresAt: "2026-03-08T09:59:40.000Z",
    },
  });
  const paused = createTaskStatusUpdate({
    taskId: seed.taskId,
    contextId: seed.snapshot.contextId,
    state: "input-required",
    final: false,
    messageText: "Approve deploy",
  });
  let server: ReturnType<typeof createServerHarness> | undefined;

  try {
    await writeSeededTask({
      rootPath,
      task: seed.snapshot,
      runtime: seed.runtime,
      events: [
        ...seed.events,
        {
          sequence: 3,
          committedAt: "2026-03-08T10:00:02.000Z",
          event: paused,
          provenance: {
            runId: "run-orphaned",
          },
        },
      ],
    });

    server = createServerHarness(async () => {}, {
      taskStore: {
        kind: "json-file",
        path: rootPath,
      },
    });

    const journal = await readJournal(rootPath, seed.taskId);
    const lastEvent = journal.at(-1)?.event;
    assert.equal(journal.length, 3);
    assert.equal(lastEvent?.kind, "status-update");
    assert.equal(
      lastEvent?.kind === "status-update"
        ? lastEvent.status.state
        : undefined,
      "input-required",
    );

    const persisted = await server.requestHandler.getTask({
      id: seed.taskId,
      historyLength: 10,
    });
    assert.equal(persisted.status.state, "input-required");
    assert.equal(getCurrentSequence(persisted), 3);
    assert.equal(getStatusMessageText(persisted), "Approve deploy");
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("paused follow-up runs keep the snapshot sequence authoritative and pinned binding after restart", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-sequence-authority-"));
  const taskId = randomUUID();
  const contextId = randomUUID();
  const binding = createStoredBinding({
    sessionKey: "session:pinned",
    mainSessionKey: "session:pinned",
    storePath: "/tmp/pinned-openclaw-a2a-sessions.json",
    peer: {
      kind: "direct",
      id: contextId,
      source: "context-id",
    },
  });
  const initialMessage = createUserMessage({ taskId, contextId });
  const pausedSnapshot = createTaskSnapshot({
    taskId,
    contextId,
    state: "input-required",
    history: [initialMessage],
    metadata: {
      openclaw: {
        currentSequence: 3,
        runId: "run-paused",
      },
    },
    messageText: "Awaiting approval",
  });
  let server: ReturnType<typeof createServerHarness> | undefined;
  const recordedSessions: RecordInboundSessionCall[] = [];

  try {
    await writeSeededTask({
      rootPath,
      task: pausedSnapshot,
      runtime: {
        currentSequence: 2,
        lease: {
          ownerId: "lost-process",
          runId: "run-paused",
          state: "released",
          heartbeatAt: "2026-03-08T10:00:02.000Z",
          leaseExpiresAt: "2026-03-08T10:00:02.000Z",
          releasedAt: "2026-03-08T10:00:02.000Z",
        },
      },
      binding,
      events: [
        {
          sequence: 1,
          committedAt: "2026-03-08T10:00:00.000Z",
          event: createTaskStatusUpdate({
            taskId,
            contextId,
            state: "submitted",
          }),
          provenance: {
            runId: "run-paused",
          },
        },
        {
          sequence: 2,
          committedAt: "2026-03-08T10:00:01.000Z",
          event: createTaskStatusUpdate({
            taskId,
            contextId,
            state: "working",
          }),
          provenance: {
            runId: "run-paused",
          },
        },
        {
          sequence: 3,
          committedAt: "2026-03-08T10:00:02.000Z",
          event: createTaskStatusUpdate({
            taskId,
            contextId,
            state: "input-required",
            final: false,
            messageText: "Awaiting approval",
          }),
          provenance: {
            runId: "run-paused",
          },
        },
      ],
    });

    server = createServerHarness(async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-resumed");
      emit({
        runId: "run-resumed",
        sessionKey: "session:pinned",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        { text: "Resumed answer" },
        { kind: "final" },
      );
      emit({
        runId: "run-resumed",
        sessionKey: "session:pinned",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    }, {
      taskStore: {
        kind: "json-file",
        path: rootPath,
      },
    }, {
      defaultEventSessionKey: "session:rerouted",
      resolveAgentRoute: () => ({
        agentId: "rerouted",
        channel: "a2a",
        accountId: "default",
        sessionKey: "session:rerouted",
        mainSessionKey: "session:rerouted",
        matchedBy: "binding.channel",
      }),
      resolveStorePath: () => "/tmp/rerouted-openclaw-a2a-sessions.json",
      recordInboundSession: async (params) => {
        recordedSessions.push({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          senderId:
            typeof params.ctx.SenderId === "string" ? params.ctx.SenderId : undefined,
          messageSid:
            typeof params.ctx.MessageSid === "string" ? params.ctx.MessageSid : undefined,
        });
      },
    });

    const continuedMessageId = randomUUID();

    const result = await server.requestHandler.sendMessage({
      message: createUserMessage({
        taskId,
        contextId,
        messageId: continuedMessageId,
        parts: [{ kind: "text", text: "Continue" }],
      }),
    });

    assert.equal(isTask(result), true);
    if (!isTask(result)) {
      assert.fail("expected resumed task result");
    }

    assert.equal(result.status.state, "completed");
    assert.equal(getCurrentSequence(result), 8);

    const persisted = await server.requestHandler.getTask({
      id: taskId,
      historyLength: 10,
    });
    assert.equal(persisted.status.state, "completed");
    assert.equal(getCurrentSequence(persisted), 8);

    const runtime = await readRuntime(rootPath, taskId);
    const persistedBinding = await readBinding(rootPath, taskId);
    assert.equal(runtime.currentSequence, 8);
    assert.equal(recordedSessions.length, 1);
    assert.deepEqual(recordedSessions[0], {
      storePath: binding.storePath,
      sessionKey: binding.sessionKey,
      senderId: binding.peer.id,
      messageSid: continuedMessageId,
    });
    assert.equal(persistedBinding.sessionKey, binding.sessionKey);
    assert.equal(persistedBinding.storePath, binding.storePath);
    assert.equal(persistedBinding.peer.id, binding.peer.id);
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("promoted durable tasks write binding.json with resolved route and bound peer data", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-binding-write-"));
  let server: ReturnType<typeof createServerHarness> | undefined;
  let result: Message | Task | undefined;

  try {
    server = createServerHarness(
      async ({ params, emit }) => {
        params.replyOptions?.onAgentRunStart?.("run-binding");
        emit({
          runId: "run-binding",
          sessionKey: "session:bound-context",
          stream: "lifecycle",
          data: { phase: "start" },
        });
        await params.dispatcherOptions.deliver(
          { text: "Bound response" },
          { kind: "tool" },
        );
        await params.dispatcherOptions.deliver(
          { text: "Bound response" },
          { kind: "final" },
        );
        emit({
          runId: "run-binding",
          sessionKey: "session:bound-context",
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
      {
        resolveAgentRoute: () => ({
          agentId: "bound-agent",
          channel: "a2a",
          accountId: "default",
          sessionKey: "session:bound-context",
          mainSessionKey: "session:bound-main",
          matchedBy: "binding.channel",
        }),
        resolveStorePath: () => "/tmp/openclaw-a2a-bound-store.json",
      },
    );

    result = await server.requestHandler.sendMessage({
      message: createUserMessage({
        contextId: "context-peer-preferred",
        messageId: "message-peer-fallback",
      }),
      configuration: {
        blocking: false,
      },
    });

    assert.equal(isTask(result), true);
    if (!isTask(result)) {
      assert.fail("expected promoted durable task");
    }

    await waitFor(async () => {
      const snapshot = await server!.requestHandler.getTask({
        id: result.id,
        historyLength: 10,
      });

      return snapshot.status.state === "completed";
    });

    const binding = await readBinding(rootPath, result.id);
    assert.deepEqual(binding, {
      schemaVersion: 1,
      agentId: "bound-agent",
      channel: "a2a",
      accountId: "default",
      matchedBy: "binding.channel",
      sessionKey: "session:bound-context",
      mainSessionKey: "session:bound-main",
      storePath: "/tmp/openclaw-a2a-bound-store.json",
      peer: {
        kind: "direct",
        id: "context-peer-preferred",
        source: "context-id",
      },
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    });
  } finally {
    if (server && typeof result !== "undefined" && isTask(result)) {
      const activeServer = server;
      const taskResult = result;

      await waitFor(async () => {
        const snapshot = await activeServer.requestHandler.getTask({
          id: taskResult.id,
          historyLength: 10,
        });

        return snapshot.status.state === "completed";
      });
    }

    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("direct blocking replies do not flush binding.json without a durable task write", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-direct-no-binding-"));
  let server: ReturnType<typeof createServerHarness> | undefined;
  const message = createUserMessage({
    contextId: "context-direct-fast-path",
    messageId: "message-direct-fast-path",
  });

  try {
    server = createServerHarness(
      async ({ params, emit }) => {
        params.replyOptions?.onAgentRunStart?.("run-direct-fast-path");
        emit({
          runId: "run-direct-fast-path",
          sessionKey: "session:direct-fast-path",
          stream: "lifecycle",
          data: { phase: "start" },
        });
        await params.dispatcherOptions.deliver(
          { text: "Direct reply" },
          { kind: "final" },
        );
        emit({
          runId: "run-direct-fast-path",
          sessionKey: "session:direct-fast-path",
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
      {
        resolveAgentRoute: () => ({
          agentId: "main",
          channel: "a2a",
          accountId: "default",
          sessionKey: "session:direct-fast-path",
          mainSessionKey: "session:direct-fast-path",
          matchedBy: "default",
        }),
      },
    );

    const result = await server.requestHandler.sendMessage({
      message,
    });

    assert.equal(result.kind, "message");
    const entries = await readdir(join(rootPath, "tasks")).catch(() => []);
    assert.deepEqual(entries, []);
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("continuation rejects conflicting contextId for an existing bound task", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-conflicting-context-"));
  const taskId = randomUUID();
  const seedContextId = randomUUID();
  const initialMessage = createUserMessage({ taskId, contextId: seedContextId });
  const pausedSnapshot = createTaskSnapshot({
    taskId,
    contextId: seedContextId,
    state: "input-required",
    history: [initialMessage],
    metadata: {
      openclaw: {
        currentSequence: 1,
        runId: "run-paused",
      },
    },
    messageText: "Awaiting approval",
  });
  let server: ReturnType<typeof createServerHarness> | undefined;

  try {
    await writeSeededTask({
      rootPath,
      task: pausedSnapshot,
      runtime: {
        currentSequence: 1,
        lease: {
          ownerId: "lost-process",
          runId: "run-paused",
          state: "released",
          heartbeatAt: "2026-03-08T10:00:00.000Z",
          leaseExpiresAt: "2026-03-08T10:00:00.000Z",
          releasedAt: "2026-03-08T10:00:00.000Z",
        },
      },
      binding: createStoredBinding({
        sessionKey: "session:conflict",
        peer: {
          kind: "direct",
          id: seedContextId,
          source: "context-id",
        },
      }),
      events: [
        {
          sequence: 1,
          committedAt: "2026-03-08T10:00:00.000Z",
          event: createTaskStatusUpdate({
            taskId,
            contextId: seedContextId,
            state: "input-required",
            final: false,
            messageText: "Awaiting approval",
          }),
          provenance: {
            runId: "run-paused",
          },
        },
      ],
    });

    server = createServerHarness(async () => {}, {
      taskStore: {
        kind: "json-file",
        path: rootPath,
      },
    });

    await assert.rejects(
      async () =>
        server!.requestHandler.sendMessage({
          message: createUserMessage({
            taskId,
            contextId: randomUUID(),
            parts: [{ kind: "text", text: "Continue" }],
          }),
        }),
      /contextId/i,
    );
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("legacy bindingless quiescent tasks stay readable and cancelable but cannot resume", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-legacy-bindingless-"));
  const taskId = randomUUID();
  const contextId = randomUUID();
  const initialMessage = createUserMessage({ taskId, contextId });
  const pausedSnapshot = createTaskSnapshot({
    taskId,
    contextId,
    state: "input-required",
    history: [initialMessage],
    metadata: {
      openclaw: {
        currentSequence: 2,
        runId: "run-legacy",
      },
    },
    messageText: "Need approval",
  });
  let server: ReturnType<typeof createServerHarness> | undefined;

  try {
    await writeSeededTask({
      rootPath,
      task: pausedSnapshot,
      runtime: {
        currentSequence: 2,
        lease: {
          ownerId: "lost-process",
          runId: "run-legacy",
          state: "released",
          heartbeatAt: "2026-03-08T10:00:01.000Z",
          leaseExpiresAt: "2026-03-08T10:00:01.000Z",
          releasedAt: "2026-03-08T10:00:01.000Z",
        },
      },
      events: [
        {
          sequence: 1,
          committedAt: "2026-03-08T10:00:00.000Z",
          event: createTaskStatusUpdate({
            taskId,
            contextId,
            state: "submitted",
          }),
          provenance: {
            runId: "run-legacy",
          },
        },
        {
          sequence: 2,
          committedAt: "2026-03-08T10:00:01.000Z",
          event: createTaskStatusUpdate({
            taskId,
            contextId,
            state: "input-required",
            final: false,
            messageText: "Need approval",
          }),
          provenance: {
            runId: "run-legacy",
          },
        },
      ],
    });

    server = createServerHarness(async () => {}, {
      taskStore: {
        kind: "json-file",
        path: rootPath,
      },
    });

    const readable = await server.requestHandler.getTask({
      id: taskId,
      historyLength: 10,
    });
    assert.equal(readable.status.state, "input-required");

    const replayed: Array<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
    for await (const event of server.requestHandler.resubscribe({ id: taskId })) {
      replayed.push(event);
    }
    assert.equal(replayed.length, 1);
    assert.equal(isTask(replayed[0]), true);

    await assert.rejects(
      async () =>
        server!.requestHandler.sendMessage({
          message: createUserMessage({
            taskId,
            contextId,
            parts: [{ kind: "text", text: "Resume" }],
          }),
        }),
      /cannot be resumed/i,
    );

    const canceled = await server.requestHandler.cancelTask({ id: taskId });
    assert.equal(canceled.status.state, "canceled");
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("cursor replay returns committed submitted, working, artifact, and final events in order", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-replay-"));
  let server: ReturnType<typeof createServerHarness> | undefined;
  let result: Message | Task | undefined;

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
    const taskResult = result;

    await waitFor(async () => {
      const snapshot = await server!.requestHandler.getTask({
        id: taskResult.id,
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
      if (event.kind === "task") {
        assert.fail("expected replay events only");
      }

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
      const activeServer = server;
      const taskResult = result;

      await waitFor(async () => {
        const snapshot = await activeServer.requestHandler.getTask({
          id: taskResult.id,
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
      if (event.kind === "task") {
        assert.fail("expected replay events only");
      }

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
      if (!isTask(event)) {
        assert.fail("expected current task snapshot");
      }

      currentSnapshots.push(event);
    }

    assert.equal(currentSnapshots.length, 1);
    assert.equal(getCurrentSequence(currentSnapshots[0]!), getCurrentSequence(persisted));
  } finally {
    server?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("persisted task metadata keeps runId distinct from SessionKey and contextId when learned from agent events", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "openclaw-a2a-runid-"));
  let server: ReturnType<typeof createServerHarness> | undefined;
  let result: Task | Message | undefined;

  try {
    server = createServerHarness(
      async ({ params, emit }) => {
        emit({
          runId: "run-event-owned",
          stream: "lifecycle",
          data: { phase: "start" },
        });
        emit({
          runId: "run-event-owned",
          stream: "assistant",
          data: { delta: "Hello" },
        });
        await params.dispatcherOptions.deliver(
          { text: "Hello" },
          { kind: "final" },
        );
        emit({
          runId: "run-event-owned",
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
      message: createUserMessage({
        contextId: "context-event-owned",
      }),
      configuration: {
        blocking: false,
      },
    });

    assert.ok(isTask(result));

    if (!isTask(result)) {
      assert.fail("expected task result");
    }

    await waitFor(async () => {
      const snapshot = await server?.requestHandler.getTask({
        id: result.id,
        historyLength: 10,
      });

      return snapshot?.status.state === "completed";
    });

    const persisted = await server.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });
    const runtime = await readRuntime(rootPath, result.id);
    const journal = await readJournal(rootPath, result.id);
    const runtimeLease =
      typeof runtime.lease === "object" &&
      runtime.lease !== null &&
      !Array.isArray(runtime.lease)
        ? (runtime.lease as Record<string, unknown>)
        : undefined;

    assert.equal(getOpenClawMetadata(persisted)?.runId, "run-event-owned");
    assert.notEqual(getOpenClawMetadata(persisted)?.runId, persisted.contextId);
    assert.notEqual(getOpenClawMetadata(persisted)?.runId, "session:test");
    assert.equal(runtimeLease?.runId, "run-event-owned");
    assert.equal(
      journal.some((record) => record.provenance.runId === "run-event-owned"),
      true,
    );
    assert.equal(journal.at(-1)?.provenance.runId, "run-event-owned");
  } finally {
    if (server && typeof result !== "undefined" && isTask(result)) {
      const activeServer = server;
      const taskResult = result;

      await waitFor(async () => {
        const snapshot = await activeServer.requestHandler.getTask({
          id: taskResult.id,
          historyLength: 10,
        });

        return snapshot.status.state === "completed";
      });
    }

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
      if (event.kind === "task") {
        assert.fail("expected replay events only");
      }

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
    const taskResult = result;

    await waitFor(async () => {
      const snapshot = await server!.requestHandler.getTask({
        id: taskResult.id,
        historyLength: 10,
      });

      return snapshot.status.state === "completed";
    });

    for (const invalidCursor of [-1, 1.5, "1"] as const) {
      await assert.rejects(
        async () => {
          for await (const _event of server!.requestHandler.resubscribe({
            id: taskResult.id,
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
    assert.deepEqual(memoryCard.defaultInputModes, [
      "text/plain",
      "application/json",
      "application/octet-stream",
    ]);
    assert.deepEqual(durableCard.defaultInputModes, [
      "text/plain",
      "application/json",
      "application/octet-stream",
    ]);
  } finally {
    memoryServer.close();
    durableServer.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});
