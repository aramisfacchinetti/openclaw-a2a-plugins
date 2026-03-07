import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http'
import { A2AOutboundService } from '../dist/service.js'
import type { A2AToolResult, FailureEnvelope, SuccessEnvelope } from '../dist/result-shape.js'
import type { A2AOutboundPluginConfig } from '../dist/config.js'

type JsonObject = Record<string, unknown>

type RpcResponse = {
  result?: JsonObject
  error?: JsonObject
  delayMs?: number
}

type SseResponse = RpcResponse

type StartPeerOptions = {
  cardPath?: string
  rpcPath?: string
  streaming?: boolean
  sendDelayMs?: number
  sendResult?: JsonObject
  getTaskResult?: JsonObject
  getTaskResponses?: RpcResponse[]
  cancelTaskResult?: JsonObject
  streamResponses?: SseResponse[]
  resubscribeResponses?: SseResponse[]
}

type PeerState = {
  lastRpcHeaders?: IncomingHttpHeaders
  lastSendParams?: JsonObject
  lastGetTaskParams?: JsonObject
  getTaskHeaders: IncomingHttpHeaders[]
  getTaskParams: JsonObject[]
  lastStreamParams?: JsonObject
  lastResubscribeParams?: JsonObject
  sendCalls: number
  streamCalls: number
  getCalls: number
  cancelCalls: number
  resubscribeCalls: number
}

type StartedPeer = {
  server: http.Server
  state: PeerState
  baseUrl: string
  cardPath: string
}

type ServiceConfigOverrides = Partial<A2AOutboundPluginConfig> & {
  defaults?: Partial<A2AOutboundPluginConfig['defaults']>
  policy?: Partial<A2AOutboundPluginConfig['policy']>
}

type UserMessageRequest = {
  message: {
    kind: 'message'
    messageId: string
    role: 'user'
    parts: Array<{ kind: 'text'; text: string }>
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): JsonObject {
  if (!isRecord(value)) {
    throw new TypeError('expected object')
  }

  return value
}

function asSuccess(result: A2AToolResult): SuccessEnvelope {
  if (result.ok !== true) {
    throw new TypeError('expected success result')
  }

  return result
}

function asFailure(result: A2AToolResult): FailureEnvelope {
  if (result.ok !== false) {
    throw new TypeError('expected failure result')
  }

  return result
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function writeSse(res: ServerResponse, body: unknown): void {
  res.write(`data: ${JSON.stringify(body)}\n\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readJson(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(asRecord(parsed))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sequenceValue<T>(values: T[] | undefined, index: number): T | undefined {
  if (!values || values.length === 0) {
    return undefined
  }

  return values[Math.min(index, values.length - 1)]
}

async function sendRpcResponse(
  res: ServerResponse,
  id: unknown,
  response: RpcResponse | undefined,
  fallbackResult: JsonObject,
): Promise<void> {
  if (response?.delayMs) {
    await sleep(response.delayMs)
  }

  json(res, 200, {
    jsonrpc: '2.0',
    id,
    ...(response?.result !== undefined
      ? { result: response.result }
      : response?.error !== undefined
        ? { error: response.error }
        : { result: fallbackResult }),
  })
}

async function sendSseResponses(
  res: ServerResponse,
  id: unknown,
  responses: SseResponse[],
): Promise<void> {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')

  for (const response of responses) {
    if (response.delayMs) {
      await sleep(response.delayMs)
    }

    writeSse(res, {
      jsonrpc: '2.0',
      id,
      ...(response.result !== undefined
        ? { result: response.result }
        : { error: response.error ?? { code: -32004, message: 'stream failure' } }),
    })
  }

  res.end()
}

function startPeer(options: StartPeerOptions = {}): Promise<StartedPeer> {
  const cardPath = options.cardPath ?? '/.well-known/agent-card.json'
  const rpcPath = options.rpcPath ?? '/a2a/jsonrpc'

  const state: PeerState = {
    lastRpcHeaders: undefined,
    lastSendParams: undefined,
    lastGetTaskParams: undefined,
    getTaskHeaders: [],
    getTaskParams: [],
    lastStreamParams: undefined,
    lastResubscribeParams: undefined,
    sendCalls: 0,
    streamCalls: 0,
    getCalls: 0,
    cancelCalls: 0,
    resubscribeCalls: 0,
  }

  const server = http.createServer(async (req, res) => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new TypeError('expected bound server address')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`

    if (req.method === 'GET' && req.url === cardPath) {
      return json(res, 200, {
        name: 'Mock Peer',
        description: 'Mock A2A peer for tests',
        protocolVersion: '0.3.0',
        version: '0.1.0',
        url: `${baseUrl}${rpcPath}`,
        preferredTransport: 'JSONRPC',
        capabilities: {
          streaming: options.streaming ?? false,
          pushNotifications: false,
          stateTransitionHistory: false,
        },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [
          {
            id: 'mock',
            name: 'mock',
            description: 'mock skill',
            tags: ['test'],
          },
        ],
      })
    }

    if (req.method === 'POST' && req.url === rpcPath) {
      state.lastRpcHeaders = req.headers
      const payload = await readJson(req)
      const payloadParams = isRecord(payload.params) ? payload.params : {}

      if (payload.method === 'message/send') {
        state.sendCalls += 1
        state.lastSendParams = payloadParams

        if (options.sendDelayMs) {
          await sleep(options.sendDelayMs)
        }

        return json(res, 200, {
          jsonrpc: '2.0',
          id: payload.id,
          result:
            options.sendResult ?? {
              kind: 'message',
              messageId: 'message-1',
              role: 'agent',
              parts: [{ kind: 'text', text: 'ack' }],
            },
        })
      }

      if (payload.method === 'message/stream') {
        state.streamCalls += 1
        state.lastStreamParams = payloadParams

        return await sendSseResponses(res, payload.id, options.streamResponses ?? [])
      }

      if (payload.method === 'tasks/get') {
        state.getCalls += 1
        state.lastGetTaskParams = payloadParams
        state.getTaskHeaders.push(req.headers)
        state.getTaskParams.push(payloadParams)

        return await sendRpcResponse(
          res,
          payload.id,
          sequenceValue(options.getTaskResponses, state.getCalls - 1),
          options.getTaskResult ?? {
            kind: 'task',
            id: payloadParams.id,
            contextId: 'ctx-1',
            status: {
              state: 'completed',
            },
          },
        )
      }

      if (payload.method === 'tasks/cancel') {
        state.cancelCalls += 1

        return json(res, 200, {
          jsonrpc: '2.0',
          id: payload.id,
          result:
            options.cancelTaskResult ?? {
              kind: 'task',
              id: payloadParams.id,
              contextId: 'ctx-1',
              status: {
                state: 'canceled',
              },
            },
        })
      }

      if (payload.method === 'tasks/resubscribe') {
        state.resubscribeCalls += 1
        state.lastResubscribeParams = payloadParams

        return await sendSseResponses(
          res,
          payload.id,
          options.resubscribeResponses ?? [],
        )
      }

      return json(res, 200, {
        jsonrpc: '2.0',
        id: payload.id,
        error: {
          code: -32601,
          message: 'method not found',
        },
      })
    }

    json(res, 404, { error: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new TypeError('expected bound server address')
      }
      resolve({
        server,
        state,
        baseUrl: `http://127.0.0.1:${address.port}`,
        cardPath,
      })
    })
  })
}

function buildService(config: ServiceConfigOverrides = {}): A2AOutboundService {
  return new A2AOutboundService({
    config: {
      enabled: true,
      defaults: {
        timeoutMs: 250,
        cardPath: '/.well-known/agent-card.json',
        preferredTransports: ['JSONRPC', 'HTTP+JSON'],
        serviceParameters: {},
      },
      policy: {
        acceptedOutputModes: [],
        normalizeBaseUrl: true,
        enforceSupportedTransports: true,
      },
      ...config,
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  })
}

function userMessageRequest(text: string): UserMessageRequest {
  return {
    message: {
      kind: 'message',
      messageId: 'user-msg-1',
      role: 'user',
      parts: [{ kind: 'text', text }],
    },
  }
}

test('delegate success returns normalized envelope and raw payload', async (t) => {
  const peer = await startPeer({
    sendResult: {
      kind: 'message',
      messageId: 'agent-msg-1',
      role: 'agent',
      parts: [{ kind: 'text', text: 'done' }],
    },
  })
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.delegate({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: userMessageRequest('hello'),
  })

  const success = asSuccess(result)
  const raw = asRecord(success.raw)

  assert.equal(success.operation, 'a2a_delegate')
  assert.equal(success.target.baseUrl, `${peer.baseUrl}/`)
  assert.equal(success.summary.kind, 'message')
  assert.equal(raw.kind, 'message')
  assert.equal(peer.state.sendCalls, 1)
})

test('delegate success accepts fully valid SDK message shape', async (t) => {
  const peer = await startPeer()
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.delegate({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      message: {
        kind: 'message',
        messageId: 'user-msg-full-1',
        role: 'user',
        contextId: 'ctx-1',
        taskId: 'task-seed',
        extensions: ['urn:openclaw:test-extension'],
        referenceTaskIds: ['task-0'],
        metadata: {
          traceId: 'trace-1',
        },
        parts: [
          { kind: 'text', text: 'hello full message' },
          {
            kind: 'file',
            file: {
              uri: 'https://example.com/file.txt',
              name: 'file.txt',
              mimeType: 'text/plain',
            },
          },
          {
            kind: 'file',
            file: {
              bytes: 'Zm9v',
              name: 'inline.txt',
              mimeType: 'text/plain',
            },
          },
          {
            kind: 'data',
            data: {
              ticket: '123',
            },
          },
        ],
      },
      metadata: {
        requestId: 'req-1',
      },
    },
  })

  const success = asSuccess(result)

  assert.equal(success.operation, 'a2a_delegate')
  assert.equal(success.summary.kind, 'message')
  assert.equal(peer.state.sendCalls, 1)
})

test('delegate forwards request.configuration unchanged in message/send params', async (t) => {
  const peer = await startPeer()
  t.after(() => peer.server.close())

  const service = buildService({
    policy: {
      acceptedOutputModes: ['text/plain'],
      normalizeBaseUrl: true,
      enforceSupportedTransports: true,
    },
  })
  const message = {
    kind: 'message' as const,
    messageId: 'user-msg-config-1',
    role: 'user' as const,
    parts: [{ kind: 'text' as const, text: 'configuration passthrough' }],
  }
  const metadata = {
    requestId: 'req-config-1',
  }
  const configuration = {
    blocking: true,
    acceptedOutputModes: ['application/json'],
    historyLength: 5,
    pushNotificationConfig: {
      url: 'https://notify.example/hooks/123',
      id: 'push-1',
      token: 'push-token',
      authentication: {
        schemes: ['Bearer', 'Basic'],
        credentials: 'credential-1',
      },
    },
  }

  const result = await service.delegate({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      message,
      metadata,
      configuration,
    },
  })

  asSuccess(result)

  assert.ok(peer.state.lastSendParams)
  assert.deepEqual(peer.state.lastSendParams, {
    message,
    metadata,
    configuration,
  })
})

test('delegate stream success returns event log and emits updates', async (t) => {
  const peer = await startPeer({
    streaming: true,
    streamResponses: [
      {
        result: {
          kind: 'task',
          id: 'task-stream-1',
          contextId: 'ctx-stream-1',
          status: {
            state: 'submitted',
          },
        },
      },
      {
        result: {
          kind: 'status-update',
          taskId: 'task-stream-1',
          contextId: 'ctx-stream-1',
          status: {
            state: 'completed',
          },
          final: true,
        },
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService()
  const updates: Array<Record<string, unknown>> = []
  const result = await service.delegateStream(
    {
      target: {
        baseUrl: peer.baseUrl,
        cardPath: peer.cardPath,
      },
      request: userMessageRequest('stream hello'),
    },
    {
      onUpdate(update) {
        updates.push(asRecord(update))
      },
    },
  )

  const success = asSuccess(result)
  const raw = asRecord(success.raw)

  assert.equal(success.operation, 'a2a_delegate_stream')
  assert.equal(success.summary.kind, 'stream')
  assert.equal(success.summary.eventCount, 2)
  assert.equal(success.summary.finalEventKind, 'status-update')
  assert.equal(success.summary.taskId, 'task-stream-1')
  assert.equal(success.summary.status, 'completed')
  assert.ok(Array.isArray(raw.events))
  assert.equal((raw.events as unknown[]).length, 2)
  assert.equal(asRecord(raw.finalEvent).kind, 'status-update')
  assert.equal(peer.state.streamCalls, 1)
  assert.equal(asRecord(peer.state.lastStreamParams ?? {}).message.messageId, 'user-msg-1')

  assert.equal(updates.length, 2)
  assert.equal(updates[0].operation, 'a2a_delegate_stream')
  assert.equal(updates[0].phase, 'update')
  assert.equal(asRecord(updates[0].summary).kind, 'task')
  assert.equal(asRecord(updates[1].summary).kind, 'status-update')
  assert.equal(asRecord(updates[1].summary).status, 'completed')
})

test('delegate stream falls back to a single non-streaming send result', async (t) => {
  const peer = await startPeer({
    streaming: false,
    sendResult: {
      kind: 'message',
      messageId: 'fallback-message-1',
      role: 'agent',
      parts: [{ kind: 'text', text: 'fallback' }],
    },
  })
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.delegateStream({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: userMessageRequest('fallback please'),
  })

  const success = asSuccess(result)
  const raw = asRecord(success.raw)

  assert.equal(success.operation, 'a2a_delegate_stream')
  assert.equal(success.summary.kind, 'stream')
  assert.equal(success.summary.eventCount, 1)
  assert.equal(success.summary.finalEventKind, 'message')
  assert.equal(success.summary.messageId, 'fallback-message-1')
  assert.ok(Array.isArray(raw.events))
  assert.equal((raw.events as unknown[]).length, 1)
  assert.equal(peer.state.sendCalls, 1)
  assert.equal(peer.state.streamCalls, 0)
})

test('task status success returns normalized envelope and raw payload', async (t) => {
  const peer = await startPeer()
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.status({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      taskId: 'task-99',
      historyLength: 3,
    },
  })

  const success = asSuccess(result)
  const raw = asRecord(success.raw)

  assert.equal(success.operation, 'a2a_task_status')
  assert.equal(success.summary.taskId, 'task-99')
  assert.equal(success.summary.status, 'completed')
  assert.equal(raw.id, 'task-99')
  assert.equal(peer.state.getCalls, 1)
  assert.ok(peer.state.lastGetTaskParams)
  assert.equal(peer.state.lastGetTaskParams.id, 'task-99')
  assert.equal(peer.state.lastGetTaskParams.historyLength, 3)
})

test('task wait returns terminal success from the first poll', async (t) => {
  const peer = await startPeer({
    getTaskResponses: [
      {
        result: {
          kind: 'task',
          id: 'task-wait-1',
          contextId: 'ctx-wait-1',
          status: {
            state: 'completed',
          },
        },
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.wait({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      taskId: 'task-wait-1',
      waitTimeoutMs: 200,
      initialDelayMs: 10,
      maxDelayMs: 20,
    },
  })

  const success = asSuccess(result)
  const raw = asRecord(success.raw)

  assert.equal(success.operation, 'a2a_task_wait')
  assert.equal(success.summary.taskId, 'task-wait-1')
  assert.equal(success.summary.status, 'completed')
  assert.equal(success.summary.attempts, 1)
  assert.equal(raw.id, 'task-wait-1')
  assert.equal(peer.state.getCalls, 1)
})

test('task wait polls through non-terminal states and sends history/service parameters on every poll', async (t) => {
  const peer = await startPeer({
    getTaskResponses: [
      {
        result: {
          kind: 'task',
          id: 'task-wait-2',
          contextId: 'ctx-wait-2',
          status: {
            state: 'submitted',
          },
        },
      },
      {
        result: {
          kind: 'task',
          id: 'task-wait-2',
          contextId: 'ctx-wait-2',
          status: {
            state: 'working',
          },
        },
      },
      {
        result: {
          kind: 'task',
          id: 'task-wait-2',
          contextId: 'ctx-wait-2',
          status: {
            state: 'completed',
          },
        },
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService({
    defaults: {
      timeoutMs: 250,
      cardPath: '/.well-known/agent-card.json',
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
      serviceParameters: {
        'X-From-Config': 'config',
      },
    },
  })

  const result = await service.wait({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      taskId: 'task-wait-2',
      waitTimeoutMs: 250,
      historyLength: 4,
      initialDelayMs: 5,
      maxDelayMs: 10,
      serviceParameters: {
        'X-From-Config': 'override',
        'X-From-Input': 'input',
      },
    },
  })

  const success = asSuccess(result)

  assert.equal(success.summary.status, 'completed')
  assert.equal(success.summary.attempts, 3)
  assert.equal(peer.state.getCalls, 3)
  assert.equal(peer.state.getTaskParams.length, 3)
  assert.equal(peer.state.getTaskHeaders.length, 3)

  for (const params of peer.state.getTaskParams) {
    assert.equal(params.id, 'task-wait-2')
    assert.equal(params.historyLength, 4)
  }

  for (const headers of peer.state.getTaskHeaders) {
    assert.equal(headers['x-from-config'], 'override')
    assert.equal(headers['x-from-input'], 'input')
  }
})

test('task wait treats input-required and auth-required as non-terminal states', async (t) => {
  const peer = await startPeer({
    getTaskResponses: [
      {
        result: {
          kind: 'task',
          id: 'task-wait-3',
          contextId: 'ctx-wait-3',
          status: {
            state: 'input-required',
          },
        },
      },
      {
        result: {
          kind: 'task',
          id: 'task-wait-3',
          contextId: 'ctx-wait-3',
          status: {
            state: 'auth-required',
          },
        },
      },
      {
        result: {
          kind: 'task',
          id: 'task-wait-3',
          contextId: 'ctx-wait-3',
          status: {
            state: 'completed',
          },
        },
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.wait({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      taskId: 'task-wait-3',
      waitTimeoutMs: 250,
      initialDelayMs: 5,
      maxDelayMs: 10,
    },
  })

  const success = asSuccess(result)

  assert.equal(success.summary.status, 'completed')
  assert.equal(success.summary.attempts, 3)
  assert.equal(peer.state.getCalls, 3)
})

test('task wait treats unknown as a terminal success state', async (t) => {
  const peer = await startPeer({
    getTaskResponses: [
      {
        result: {
          kind: 'task',
          id: 'task-wait-4',
          contextId: 'ctx-wait-4',
          status: {
            state: 'unknown',
          },
        },
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.wait({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      taskId: 'task-wait-4',
      waitTimeoutMs: 200,
      initialDelayMs: 5,
      maxDelayMs: 10,
    },
  })

  const success = asSuccess(result)

  assert.equal(success.summary.status, 'unknown')
  assert.equal(success.summary.attempts, 1)
  assert.equal(peer.state.getCalls, 1)
})

test('task wait returns WAIT_TIMEOUT with the latest task snapshot', async (t) => {
  const peer = await startPeer({
    getTaskResponses: [
      {
        result: {
          kind: 'task',
          id: 'task-wait-timeout',
          contextId: 'ctx-wait-timeout',
          status: {
            state: 'working',
          },
        },
      },
      {
        delayMs: 80,
        result: {
          kind: 'task',
          id: 'task-wait-timeout',
          contextId: 'ctx-wait-timeout',
          status: {
            state: 'working',
          },
        },
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService({
    defaults: {
      timeoutMs: 20,
      cardPath: '/.well-known/agent-card.json',
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
      serviceParameters: {},
    },
  })

  const result = await service.wait({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      taskId: 'task-wait-timeout',
      waitTimeoutMs: 60,
      initialDelayMs: 10,
      maxDelayMs: 10,
    },
  })

  const failure = asFailure(result)
  const details = asRecord(failure.error.details)
  const lastTask = asRecord(details.lastTask)
  const lastError = asRecord(details.lastError)

  assert.equal(failure.operation, 'a2a_task_wait')
  assert.equal(failure.error.code, 'WAIT_TIMEOUT')
  assert.equal(details.taskId, 'task-wait-timeout')
  assert.equal(details.waitTimeoutMs, 60)
  assert.ok((details.attempts as number) >= 2)
  assert.equal(lastTask.id, 'task-wait-timeout')
  assert.equal(asRecord(lastTask.status).state, 'working')
  assert.equal(lastError.code, 'A2A_SDK_ERROR')
})

test('task wait retries transient poll failures until a later poll succeeds', async (t) => {
  const peer = await startPeer({
    getTaskResponses: [
      {
        delayMs: 40,
        result: {
          kind: 'task',
          id: 'task-wait-retry',
          contextId: 'ctx-wait-retry',
          status: {
            state: 'working',
          },
        },
      },
      {
        result: {
          kind: 'task',
          id: 'task-wait-retry',
          contextId: 'ctx-wait-retry',
          status: {
            state: 'completed',
          },
        },
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService({
    defaults: {
      timeoutMs: 10,
      cardPath: '/.well-known/agent-card.json',
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
      serviceParameters: {},
    },
  })

  const result = await service.wait({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      taskId: 'task-wait-retry',
      waitTimeoutMs: 150,
      initialDelayMs: 5,
      maxDelayMs: 10,
    },
  })

  const success = asSuccess(result)

  assert.equal(success.summary.status, 'completed')
  assert.equal(success.summary.attempts, 2)
  assert.equal(peer.state.getCalls, 2)
})

test('task wait aborts immediately on non-retryable poll failures', async (t) => {
  const peer = await startPeer({
    getTaskResponses: [
      {
        error: {
          code: -32601,
          message: 'method not found',
        },
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.wait({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      taskId: 'task-wait-method-missing',
      waitTimeoutMs: 150,
      initialDelayMs: 5,
      maxDelayMs: 10,
    },
  })

  const failure = asFailure(result)

  assert.equal(failure.operation, 'a2a_task_wait')
  assert.equal(failure.error.code, 'A2A_SDK_ERROR')
  assert.match(failure.error.message, /method not found/i)
  assert.equal(peer.state.getCalls, 1)
})

test('task resubscribe success returns normalized stream envelope', async (t) => {
  const peer = await startPeer({
    streaming: true,
    resubscribeResponses: [
      {
        result: {
          kind: 'status-update',
          taskId: 'task-resubscribe-1',
          contextId: 'ctx-resubscribe-1',
          status: {
            state: 'working',
          },
          final: false,
        },
      },
      {
        result: {
          kind: 'artifact-update',
          taskId: 'task-resubscribe-1',
          contextId: 'ctx-resubscribe-1',
          artifact: {
            artifactId: 'artifact-1',
            parts: [{ kind: 'text', text: 'artifact chunk' }],
          },
          lastChunk: true,
        },
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.resubscribe({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      taskId: 'task-resubscribe-1',
    },
  })

  const success = asSuccess(result)
  const raw = asRecord(success.raw)

  assert.equal(success.operation, 'a2a_task_resubscribe')
  assert.equal(success.summary.kind, 'stream')
  assert.equal(success.summary.eventCount, 2)
  assert.equal(success.summary.finalEventKind, 'artifact-update')
  assert.equal(success.summary.taskId, 'task-resubscribe-1')
  assert.equal(success.summary.artifactId, 'artifact-1')
  assert.ok(Array.isArray(raw.events))
  assert.equal((raw.events as unknown[]).length, 2)
  assert.equal(asRecord(raw.finalEvent).kind, 'artifact-update')
  assert.equal(peer.state.resubscribeCalls, 1)
  assert.equal(asRecord(peer.state.lastResubscribeParams ?? {}).id, 'task-resubscribe-1')
})

test('task cancel success returns normalized envelope and raw payload', async (t) => {
  const peer = await startPeer()
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.cancel({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      taskId: 'task-13',
    },
  })

  const success = asSuccess(result)
  const raw = asRecord(success.raw)

  assert.equal(success.operation, 'a2a_task_cancel')
  assert.equal(success.summary.taskId, 'task-13')
  assert.equal(success.summary.status, 'canceled')
  assert.equal(raw.id, 'task-13')
  assert.equal(peer.state.cancelCalls, 1)
})

test('delegate stream treats an empty stream as failure', async (t) => {
  const peer = await startPeer({
    streaming: true,
    streamResponses: [],
  })
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.delegateStream({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: userMessageRequest('empty stream'),
  })

  const failure = asFailure(result)

  assert.equal(failure.operation, 'a2a_delegate_stream')
  assert.equal(failure.error.code, 'A2A_SDK_ERROR')
  assert.equal(failure.error.message, 'stream ended without events')
})

test('delegate stream decorates mid-stream failures with partial event details', async (t) => {
  const peer = await startPeer({
    streaming: true,
    streamResponses: [
      {
        result: {
          kind: 'task',
          id: 'task-partial-1',
          contextId: 'ctx-partial-1',
          status: {
            state: 'working',
          },
        },
      },
      {
        error: {
          code: -32004,
          message: 'stream exploded',
        },
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.delegateStream({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: userMessageRequest('partial stream'),
  })

  const failure = asFailure(result)
  const details = asRecord(failure.error.details)

  assert.equal(failure.operation, 'a2a_delegate_stream')
  assert.equal(failure.error.code, 'A2A_SDK_ERROR')
  assert.equal(details.partialEventCount, 1)
  assert.equal(asRecord(details.latestEventSummary).kind, 'task')
  assert.equal(asRecord(details.latestEventSummary).taskId, 'task-partial-1')
})

test('delegate stream timeout handling maps to SDK timeout error', async (t) => {
  const peer = await startPeer({
    streaming: true,
    streamResponses: [
      {
        result: {
          kind: 'task',
          id: 'task-timeout-1',
          contextId: 'ctx-timeout-1',
          status: {
            state: 'submitted',
          },
        },
        delayMs: 80,
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService({
    defaults: {
      timeoutMs: 10,
      cardPath: '/.well-known/agent-card.json',
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
      serviceParameters: {},
    },
  })

  const result = await service.delegateStream({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: userMessageRequest('slow stream'),
  })

  const failure = asFailure(result)

  assert.equal(failure.error.code, 'A2A_SDK_ERROR')
  assert.equal(failure.error.message, 'request timed out')
})

test('delegate stream abort handling preserves partial event details', async (t) => {
  const peer = await startPeer({
    streaming: true,
    streamResponses: [
      {
        result: {
          kind: 'task',
          id: 'task-abort-1',
          contextId: 'ctx-abort-1',
          status: {
            state: 'working',
          },
        },
      },
      {
        result: {
          kind: 'status-update',
          taskId: 'task-abort-1',
          contextId: 'ctx-abort-1',
          status: {
            state: 'completed',
          },
          final: true,
        },
        delayMs: 80,
      },
    ],
  })
  t.after(() => peer.server.close())

  const service = buildService({
    defaults: {
      timeoutMs: 500,
      cardPath: '/.well-known/agent-card.json',
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
      serviceParameters: {},
    },
  })
  const controller = new AbortController()

  const result = await service.delegateStream(
    {
      target: {
        baseUrl: peer.baseUrl,
        cardPath: peer.cardPath,
      },
      request: userMessageRequest('abort stream'),
    },
    {
      signal: controller.signal,
      onUpdate() {
        controller.abort()
      },
    },
  )

  const failure = asFailure(result)
  const details = asRecord(failure.error.details)

  assert.equal(failure.error.code, 'A2A_SDK_ERROR')
  assert.equal(failure.error.message, 'request timed out')
  assert.equal(details.partialEventCount, 1)
  assert.equal(asRecord(details.latestEventSummary).taskId, 'task-abort-1')
})

test('malformed input returns validation envelope', async () => {
  const service = buildService()
  const result = await service.delegate({
    target: {
      baseUrl: 'http://peer.example',
    },
    request: {
      message: {
        kind: 'message',
        messageId: 'msg-1',
        role: 'user',
        parts: [{ kind: 'audio', data: {} }],
      },
    },
  })

  const failure = asFailure(result)

  assert.equal(failure.operation, 'a2a_delegate')
  assert.equal(failure.error.code, 'VALIDATION_ERROR')
  const details = asRecord(failure.error.details)
  assert.equal(details.source, 'ajv')
  assert.ok(Array.isArray(details.errors))
  assert.ok((details.errors as unknown[]).length > 0)
})

test('transport mismatch returns deterministic SDK error envelope', async (t) => {
  const peer = await startPeer()
  t.after(() => peer.server.close())

  const service = buildService()
  const result = await service.delegate({
    target: {
      baseUrl: peer.baseUrl,
      preferredTransports: ['GRPC'],
    },
    request: userMessageRequest('transport mismatch'),
  })

  const failure = asFailure(result)

  assert.equal(failure.operation, 'a2a_delegate')
  assert.equal(failure.error.code, 'A2A_SDK_ERROR')
  assert.match(failure.error.message, /unsupported preferred transport/i)
})

test('delegate timeout handling maps to SDK timeout error', async (t) => {
  const peer = await startPeer({ sendDelayMs: 80 })
  t.after(() => peer.server.close())

  const service = buildService({
    defaults: {
      timeoutMs: 10,
      cardPath: '/.well-known/agent-card.json',
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
      serviceParameters: {},
    },
  })

  const result = await service.delegate({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: userMessageRequest('slow request'),
  })

  const failure = asFailure(result)

  assert.equal(failure.error.code, 'A2A_SDK_ERROR')
})

test('serviceParameters merge defaults and per-call overrides', async (t) => {
  const peer = await startPeer()
  t.after(() => peer.server.close())

  const service = buildService({
    defaults: {
      timeoutMs: 250,
      cardPath: '/.well-known/agent-card.json',
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
      serviceParameters: {
        'X-From-Config': 'config',
      },
    },
  })

  const result = await service.delegate({
    target: {
      baseUrl: peer.baseUrl,
      cardPath: peer.cardPath,
    },
    request: {
      ...userMessageRequest('header test'),
      serviceParameters: {
        'X-From-Input': 'input',
        'X-From-Config': 'override',
      },
    },
  })

  asSuccess(result)

  assert.ok(peer.state.lastRpcHeaders)
  assert.ok(peer.state.lastSendParams)
  assert.equal(peer.state.lastRpcHeaders['x-from-input'], 'input')
  assert.equal(peer.state.lastRpcHeaders['x-from-config'], 'override')
  assert.equal('serviceParameters' in peer.state.lastSendParams, false)
})
