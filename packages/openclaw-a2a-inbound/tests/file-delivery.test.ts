import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@a2a-js/sdk";
import type { ChannelGatewayContext, PluginRuntime } from "openclaw/plugin-sdk";
import { createA2AInboundServer, type A2AInboundServer } from "../dist/a2a-server.js";
import { deriveFilesBasePath } from "../dist/file-delivery.js";
import { A2AInboundPluginHost } from "../dist/plugin-host.js";
import {
  createPluginRuntimeHarness,
  createTestAccount,
  createUserMessage,
  waitFor,
} from "./runtime-harness.js";

type MockFetchCall = {
  url: string;
  method: string;
  headers: Headers;
};

type MockFetchHandler = (request: MockFetchCall) => Promise<Response> | Response;

function createMockResponse(
  url: string,
  init: ResponseInit & { body?: BodyInit | null },
): Response {
  const response = new Response(init.body ?? null, init);
  Object.defineProperty(response, "url", {
    value: url,
    configurable: true,
  });
  return response;
}

function createMockSourceFetcher() {
  const handlers = new Map<string, MockFetchHandler>();
  const calls: MockFetchCall[] = [];

  return {
    calls,
    on(url: string, handler: MockFetchHandler): void {
      handlers.set(url, handler);
    },
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const call: MockFetchCall = {
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      };
      calls.push(call);
      const handler = handlers.get(url);

      if (!handler) {
        throw new Error(`Unhandled mock fetch for ${url}`);
      }

      return await handler(call);
    },
    lookupFn: (async (hostname: string, options?: { all?: boolean }) => {
      const address =
        hostname === "private.example.test"
          ? {
              address: "127.0.0.1",
              family: 4,
            }
          : {
              address: "93.184.216.34",
              family: 4,
            };

      return options?.all ? [address] : address;
    }) as typeof import("node:dns/promises").lookup,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address.");
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function createAccount(overrides: Partial<ReturnType<typeof createTestAccount>> = {}) {
  return createTestAccount({
    publicBaseUrl: "https://agents.example.com",
    ...overrides,
  });
}

function createFileServer(params: {
  script: Parameters<typeof createPluginRuntimeHarness>[0];
  accountOverrides?: Partial<ReturnType<typeof createTestAccount>>;
  runtimeOverrides?: Parameters<typeof createPluginRuntimeHarness>[1];
  fileDelivery?: Parameters<typeof createA2AInboundServer>[0]["fileDelivery"];
}): {
  account: ReturnType<typeof createTestAccount>;
  runtime: PluginRuntime;
  server: A2AInboundServer;
} {
  const account = createAccount(params.accountOverrides);
  const { pluginRuntime } = createPluginRuntimeHarness(
    params.script,
    params.runtimeOverrides,
  );

  return {
    account,
    runtime: pluginRuntime,
    server: createA2AInboundServer({
      accountId: "default",
      account,
      cfg: {},
      channelRuntime: pluginRuntime.channel,
      pluginRuntime,
      fileDelivery: params.fileDelivery,
    }),
  };
}

async function createCompletedFileTask(params: {
  server: A2AInboundServer;
  acceptedOutputModes?: string[];
}): Promise<{
  fileUri: string;
  task: Task;
}> {
  const result = await params.server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      blocking: false,
      ...(params.acceptedOutputModes
        ? { acceptedOutputModes: params.acceptedOutputModes }
        : {}),
    },
  });

  assert.equal(result.kind, "task");

  await waitFor(async () => {
    const snapshot = await params.server.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return snapshot.status.state === "completed";
  });

  const task = await params.server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });
  const fileUri = task.status.message?.parts.flatMap((part) =>
    part.kind === "file" ? [part.file.uri] : [],
  )[0];

  assert.ok(fileUri);

  return {
    task,
    fileUri: fileUri!,
  };
}

async function fetchTaskFile(
  routeBaseUrl: string,
  publicFileUri: string,
  init?: RequestInit,
): Promise<Response> {
  const parsed = new URL(publicFileUri);
  return await fetch(`${routeBaseUrl}${parsed.pathname}`, init);
}

test("first GET materializes once, concurrent first fetches collapse, and later GETs serve cache", async () => {
  const source = createMockSourceFetcher();
  let upstreamFetches = 0;
  source.on("https://agents.example.com/upstream/report.pdf", async (request) => {
    upstreamFetches += 1;
    assert.equal(request.headers.get("authorization"), "secret");
    await new Promise((resolve) => setTimeout(resolve, 25));

    return createMockResponse(request.url, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename=\"report.pdf\"",
      },
      body: Buffer.from("report-body"),
    });
  });

  const { server } = createFileServer({
    script: async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-files-cache");
      emit({
        runId: "run-files-cache",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        {
          mediaUrl: "https://agents.example.com/upstream/report.pdf",
        },
        { kind: "final" },
      );
      emit({
        runId: "run-files-cache",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
    accountOverrides: {
      auth: {
        mode: "header-token",
        headerName: "authorization",
        token: "secret",
      },
    },
    fileDelivery: {
      fetchImpl: source.fetchImpl,
      lookupFn: source.lookupFn,
    },
  });
  const routeServer = createServer((req, res) => {
    void server.handle(req, res);
  });

  try {
    const routeBaseUrl = await listen(routeServer);
    const { fileUri } = await createCompletedFileTask({
      server,
      acceptedOutputModes: ["application/octet-stream"],
    });

    const [first, second] = await Promise.all([
      fetchTaskFile(routeBaseUrl, fileUri),
      fetchTaskFile(routeBaseUrl, fileUri),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(await first.text(), "report-body");
    assert.equal(await second.text(), "report-body");
    assert.equal(first.headers.get("content-type"), "application/pdf");
    assert.match(first.headers.get("content-disposition") ?? "", /report\.pdf/);
    assert.equal(upstreamFetches, 1);

    const cached = await fetchTaskFile(routeBaseUrl, fileUri);
    assert.equal(cached.status, 200);
    assert.equal(await cached.text(), "report-body");
    assert.equal(upstreamFetches, 1);
  } finally {
    server.close();
    await closeHttpServer(routeServer);
  }
});

test("HEAD materializes on first request and returns the cached file headers without a body", async () => {
  const source = createMockSourceFetcher();
  let upstreamFetches = 0;
  source.on("https://agents.example.com/upstream/head.pdf", async (request) => {
    upstreamFetches += 1;

    return createMockResponse(request.url, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
      },
      body: Buffer.from("head-body"),
    });
  });

  const { server } = createFileServer({
    script: async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-files-head");
      emit({
        runId: "run-files-head",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        {
          mediaUrl: "https://agents.example.com/upstream/head.pdf",
        },
        { kind: "final" },
      );
      emit({
        runId: "run-files-head",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
    fileDelivery: {
      fetchImpl: source.fetchImpl,
      lookupFn: source.lookupFn,
    },
  });
  const routeServer = createServer((req, res) => {
    void server.handle(req, res);
  });

  try {
    const routeBaseUrl = await listen(routeServer);
    const { fileUri } = await createCompletedFileTask({
      server,
      acceptedOutputModes: ["application/octet-stream"],
    });

    const head = await fetchTaskFile(routeBaseUrl, fileUri, {
      method: "HEAD",
    });

    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("content-length"), String(Buffer.byteLength("head-body")));
    assert.equal(upstreamFetches, 1);

    const get = await fetchTaskFile(routeBaseUrl, fileUri);
    assert.equal(get.status, 200);
    assert.equal(await get.text(), "head-body");
    assert.equal(upstreamFetches, 1);
  } finally {
    server.close();
    await closeHttpServer(routeServer);
  }
});

test("external fetches omit auth and failed materialization remains retriable", async () => {
  const source = createMockSourceFetcher();
  let upstreamFetches = 0;
  source.on("https://cdn.example.net/assets/report.txt", async (request) => {
    upstreamFetches += 1;
    assert.equal(request.headers.has("authorization"), false);

    if (upstreamFetches === 1) {
      return createMockResponse(request.url, {
        status: 503,
        body: "temporary failure",
      });
    }

    return createMockResponse(request.url, {
      status: 200,
      headers: {
        "content-type": "text/plain",
      },
      body: Buffer.from("external-body"),
    });
  });

  const { server } = createFileServer({
    script: async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-files-external");
      emit({
        runId: "run-files-external",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        {
          mediaUrl: "https://cdn.example.net/assets/report.txt",
        },
        { kind: "final" },
      );
      emit({
        runId: "run-files-external",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
    fileDelivery: {
      fetchImpl: source.fetchImpl,
      lookupFn: source.lookupFn,
    },
  });
  const routeServer = createServer((req, res) => {
    void server.handle(req, res);
  });

  try {
    const routeBaseUrl = await listen(routeServer);
    const { fileUri } = await createCompletedFileTask({
      server,
      acceptedOutputModes: ["application/octet-stream"],
    });

    const first = await fetchTaskFile(routeBaseUrl, fileUri);
    assert.equal(first.status, 502);

    const second = await fetchTaskFile(routeBaseUrl, fileUri);
    assert.equal(second.status, 200);
    assert.equal(await second.text(), "external-body");
    assert.equal(upstreamFetches, 2);
  } finally {
    server.close();
    await closeHttpServer(routeServer);
  }
});

test("json-file mode survives restart while memory mode does not retain file descriptors", async () => {
  const source = createMockSourceFetcher();
  let upstreamFetches = 0;
  source.on("https://cdn.example.net/assets/persisted.txt", async (request) => {
    upstreamFetches += 1;

    return createMockResponse(request.url, {
      status: 200,
      headers: {
        "content-type": "text/plain",
      },
      body: Buffer.from("persisted-body"),
    });
  });

  const persistentRoot = await mkdtemp(join(tmpdir(), "openclaw-a2a-files-persist-"));
  let persistent = createFileServer({
    script: async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-files-persist");
      emit({
        runId: "run-files-persist",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        {
          mediaUrl: "https://cdn.example.net/assets/persisted.txt",
        },
        { kind: "final" },
      );
      emit({
        runId: "run-files-persist",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
    accountOverrides: {
      taskStore: {
        kind: "json-file",
        path: persistentRoot,
      },
    },
    fileDelivery: {
      fetchImpl: source.fetchImpl,
      lookupFn: source.lookupFn,
    },
  });
  const currentPersistent = {
    server: persistent.server,
  };
  const persistentRouteServer = createServer((req, res) => {
    void currentPersistent.server.handle(req, res);
  });

  let memory = createFileServer({
    script: async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-files-memory");
      emit({
        runId: "run-files-memory",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        {
          mediaUrl: "https://cdn.example.net/assets/memory.txt",
        },
        { kind: "final" },
      );
      emit({
        runId: "run-files-memory",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
    fileDelivery: {
      fetchImpl: async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return createMockResponse(url, {
          status: 200,
          body: Buffer.from("memory-body"),
          headers: {
            "content-type": "text/plain",
          },
        });
      },
      lookupFn: source.lookupFn,
    },
  });
  const currentMemory = {
    server: memory.server,
  };
  const memoryRouteServer = createServer((req, res) => {
    void currentMemory.server.handle(req, res);
  });

  try {
    const persistentBaseUrl = await listen(persistentRouteServer);
    const memoryBaseUrl = await listen(memoryRouteServer);
    const { fileUri: persistentUri } = await createCompletedFileTask({
      server: currentPersistent.server,
      acceptedOutputModes: ["application/octet-stream"],
    });
    const { fileUri: memoryUri } = await createCompletedFileTask({
      server: currentMemory.server,
      acceptedOutputModes: ["application/octet-stream"],
    });

    const initialPersistent = await fetchTaskFile(persistentBaseUrl, persistentUri);
    assert.equal(initialPersistent.status, 200);
    assert.equal(await initialPersistent.text(), "persisted-body");
    assert.equal(upstreamFetches, 1);

    const initialMemory = await fetchTaskFile(memoryBaseUrl, memoryUri);
    assert.equal(initialMemory.status, 200);
    assert.equal(await initialMemory.text(), "memory-body");

    currentPersistent.server.close();
    persistent = createFileServer({
      script: async () => {},
      accountOverrides: {
        taskStore: {
          kind: "json-file",
          path: persistentRoot,
        },
      },
      fileDelivery: {
        fetchImpl: source.fetchImpl,
        lookupFn: source.lookupFn,
      },
    });
    currentPersistent.server = persistent.server;

    currentMemory.server.close();
    memory = createFileServer({
      script: async () => {},
      fileDelivery: {
        fetchImpl: source.fetchImpl,
        lookupFn: source.lookupFn,
      },
    });
    currentMemory.server = memory.server;

    const persistedAfterRestart = await fetchTaskFile(persistentBaseUrl, persistentUri);
    assert.equal(persistedAfterRestart.status, 200);
    assert.equal(await persistedAfterRestart.text(), "persisted-body");
    assert.equal(upstreamFetches, 1);

    const missingAfterRestart = await fetchTaskFile(memoryBaseUrl, memoryUri);
    assert.equal(missingAfterRestart.status, 404);
  } finally {
    currentPersistent.server.close();
    currentMemory.server.close();
    await closeHttpServer(persistentRouteServer);
    await closeHttpServer(memoryRouteServer);
    await rm(persistentRoot, { recursive: true, force: true });
  }
});

test("unknown ids return 404, blocked schemes and private targets return 502, and account auth still protects the files route", async () => {
  const source = createMockSourceFetcher();
  const blockedServer = createFileServer({
    script: async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-files-blocked");
      emit({
        runId: "run-files-blocked",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        {
          mediaUrl: "http://cdn.example.net/assets/blocked.txt",
        },
        { kind: "final" },
      );
      emit({
        runId: "run-files-blocked",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
    fileDelivery: {
      fetchImpl: source.fetchImpl,
      lookupFn: source.lookupFn,
    },
  });
  const privateTargetServer = createFileServer({
    script: async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-files-private");
      emit({
        runId: "run-files-private",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        {
          mediaUrl: "https://private.example.test/assets/private.txt",
        },
        { kind: "final" },
      );
      emit({
        runId: "run-files-private",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
    fileDelivery: {
      fetchImpl: source.fetchImpl,
      lookupFn: source.lookupFn,
    },
  });
  const blockedRouteServer = createServer((req, res) => {
    void blockedServer.server.handle(req, res);
  });
  const privateRouteServer = createServer((req, res) => {
    void privateTargetServer.server.handle(req, res);
  });

  const authAccount = createAccount({
    auth: {
      mode: "header-token",
      headerName: "authorization",
      token: "secret",
    },
  });
  const { pluginRuntime } = createPluginRuntimeHarness(async () => {});
  const host = new A2AInboundPluginHost(pluginRuntime);
  const abortController = new AbortController();
  let statusSnapshot = {
    accountId: "default",
    enabled: false,
    configured: false,
    running: false,
    connected: false,
  };
  const startPromise = host.startAccount({
    accountId: "default",
    account: authAccount,
    cfg: {},
    runtime: {} as ChannelGatewayContext["runtime"],
    abortSignal: abortController.signal,
    getStatus: () => statusSnapshot,
    setStatus: (next) => {
      statusSnapshot = next;
    },
    channelRuntime: pluginRuntime.channel,
  });
  const hostRouteServer = createServer((req, res) => {
    void host.handleHttpRoute({
      accountId: "default",
      req,
      res,
    });
  });

  try {
    const blockedBaseUrl = await listen(blockedRouteServer);
    const privateBaseUrl = await listen(privateRouteServer);
    const hostBaseUrl = await listen(hostRouteServer);
    await waitFor(() => statusSnapshot.running === true);
    const { fileUri: blockedUri } = await createCompletedFileTask({
      server: blockedServer.server,
      acceptedOutputModes: ["application/octet-stream"],
    });
    const { fileUri: privateUri } = await createCompletedFileTask({
      server: privateTargetServer.server,
      acceptedOutputModes: ["application/octet-stream"],
    });

    const unknown = await fetch(
      `${hostBaseUrl}${deriveFilesBasePath(authAccount.jsonRpcPath)}/missing/missing/missing`,
    );
    assert.equal(unknown.status, 401);

    const authorizedUnknown = await fetch(
      `${hostBaseUrl}${deriveFilesBasePath(authAccount.jsonRpcPath)}/missing/missing/missing`,
      {
        headers: {
          authorization: "secret",
        },
      },
    );
    assert.equal(authorizedUnknown.status, 404);

    const blocked = await fetchTaskFile(blockedBaseUrl, blockedUri);
    assert.equal(blocked.status, 502);

    const privateTarget = await fetchTaskFile(privateBaseUrl, privateUri);
    assert.equal(privateTarget.status, 502);
    assert.equal(source.calls.length, 0);
  } finally {
    blockedServer.server.close();
    privateTargetServer.server.close();
    abortController.abort();
    await startPromise;
    await closeHttpServer(blockedRouteServer);
    await closeHttpServer(privateRouteServer);
    await closeHttpServer(hostRouteServer);
  }
});
