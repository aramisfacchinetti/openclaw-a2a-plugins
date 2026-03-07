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

type StartPeerOptions = {
  cardPath?: string
  rpcPath?: string
  sendDelayMs?: number
  sendResult?: JsonObject
  getTaskResult?: JsonObject
  cancelTaskResult?: JsonObject
}

type PeerState = {
  lastRpcHeaders?: IncomingHttpHeaders
  lastGetTaskParams?: JsonObject
  sendCalls: number
  getCalls: number
  cancelCalls: number
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
  assert.equal(result.ok, true)
  return result
}

function asFailure(result: A2AToolResult): FailureEnvelope {
  assert.equal(result.ok, false)
  return result
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
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

function startPeer(options: StartPeerOptions = {}): Promise<StartedPeer> {
  const cardPath = options.cardPath ?? '/.well-known/agent-card.json'
  const rpcPath = options.rpcPath ?? '/a2a/jsonrpc'

  const state: PeerState = {
    lastRpcHeaders: undefined,
    lastGetTaskParams: undefined,
    sendCalls: 0,
    getCalls: 0,
    cancelCalls: 0,
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
          streaming: false,
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

        if (options.sendDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.sendDelayMs))
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

      if (payload.method === 'tasks/get') {
        state.getCalls += 1
        state.lastGetTaskParams = payloadParams

        return json(res, 200, {
          jsonrpc: '2.0',
          id: payload.id,
          result:
            options.getTaskResult ?? {
              kind: 'task',
              id: payloadParams.id,
              contextId: 'ctx-1',
              status: {
                state: 'completed',
              },
            },
        })
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
  assert.equal(peer.state.lastRpcHeaders['x-from-input'], 'input')
  assert.equal(peer.state.lastRpcHeaders['x-from-config'], 'override')
})
