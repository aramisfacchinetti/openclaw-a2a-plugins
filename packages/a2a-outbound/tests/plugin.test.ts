import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AnyAgentTool, OpenClawPluginApi } from 'openclaw/plugin-sdk'
import plugin from '../dist/index.js'
import type { A2AToolResult, FailureEnvelope } from '../dist/result-shape.js'

type RegisterToolCapture = (tool: AnyAgentTool, options?: { optional?: boolean }) => void

type RegisteredTool = {
  descriptor: AnyAgentTool
  options?: { optional?: boolean }
}

type ToolResultLike = {
  structuredContent?: unknown
  content?: Array<{ text?: unknown }>
}

type StartedPeer = {
  server: http.Server
  baseUrl: string
  cardPath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError('expected object')
  }

  return value
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function writeSse(res: ServerResponse, body: unknown): void {
  res.write(`data: ${JSON.stringify(body)}\n\n`)
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    req.on('end', () => {
      try {
        resolve(asRecord(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function startStreamingPeer(): Promise<StartedPeer> {
  const cardPath = '/.well-known/agent-card.json'
  const rpcPath = '/a2a/jsonrpc'

  const server = http.createServer(async (req, res) => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new TypeError('expected bound server address')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`

    if (req.method === 'GET' && req.url === cardPath) {
      return json(res, 200, {
        name: 'Mock Stream Peer',
        description: 'Mock A2A peer for plugin streaming tests',
        protocolVersion: '0.3.0',
        version: '0.1.0',
        url: `${baseUrl}${rpcPath}`,
        preferredTransport: 'JSONRPC',
        capabilities: {
          streaming: true,
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
      const payload = await readJson(req)

      if (payload.method === 'message/stream') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream')
        writeSse(res, {
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            kind: 'task',
            id: 'task-stream-1',
            contextId: 'ctx-stream-1',
            status: {
              state: 'submitted',
            },
          },
        })
        writeSse(res, {
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            kind: 'status-update',
            taskId: 'task-stream-1',
            contextId: 'ctx-stream-1',
            status: {
              state: 'completed',
            },
            final: true,
          },
        })
        return res.end()
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
        baseUrl: `http://127.0.0.1:${address.port}`,
        cardPath,
      })
    })
  })
}

function toFailure(result: A2AToolResult): FailureEnvelope {
  assert.equal(result.ok, false)
  return result
}

function createApi(
  pluginConfig: Record<string, unknown>,
  onRegisterTool: RegisterToolCapture,
): OpenClawPluginApi {
  const api: OpenClawPluginApi = {
    id: 'a2a-outbound',
    name: 'a2a-outbound',
    version: '1.0.0',
    source: 'test',
    config: {} as OpenClawPluginApi['config'],
    pluginConfig,
    runtime: {
      logging: {},
    } as OpenClawPluginApi['runtime'],
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    registerTool(tool, options) {
      if (typeof tool === 'function') {
        throw new TypeError('unexpected tool factory registration in test')
      }

      onRegisterTool(tool, options)
    },
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath(input) {
      return input
    },
    on() {},
  }

  return api
}

function readStructuredContent<T = A2AToolResult>(result: unknown): T {
  const toolResult = asRecord(result) as ToolResultLike

  if (toolResult.structuredContent !== undefined) {
    return toolResult.structuredContent as T
  }

  if (!Array.isArray(toolResult.content)) {
    throw new TypeError('expected content array')
  }

  const first = toolResult.content[0]
  const firstRecord = asRecord(first)

  if (typeof firstRecord.text !== 'string') {
    throw new TypeError('expected first content text')
  }

  return JSON.parse(firstRecord.text) as T
}

async function executeTool(tool: AnyAgentTool, input: unknown): Promise<unknown> {
  const executable = tool as unknown as {
    execute: (arg: unknown, context: unknown) => Promise<unknown>
  }

  return executable.execute(input, {})
}

async function executeToolByIdAndInput(
  tool: AnyAgentTool,
  callId: string,
  input: unknown,
): Promise<unknown> {
  const executable = tool as unknown as {
    execute: (id: string, params: unknown, context: unknown) => Promise<unknown>
  }

  return executable.execute(callId, input, {})
}

async function executeToolWithSignalAndUpdates(
  tool: AnyAgentTool,
  callId: string,
  input: unknown,
  signal?: AbortSignal,
  onUpdate?: (result: unknown) => void,
): Promise<unknown> {
  const executable = tool as unknown as {
    execute: (
      id: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (result: unknown) => void,
    ) => Promise<unknown>
  }

  return executable.execute(callId, input, signal, onUpdate)
}

test('plugin registration with enabled=false registers no tools', () => {
  const tools: RegisteredTool[] = []

  plugin.register(
    createApi({ enabled: false }, (descriptor, options) => {
      tools.push({ descriptor, options })
    }),
  )

  assert.equal(tools.length, 0)
})

test('plugin registers the five a2a tools with optional flag', () => {
  const tools: RegisteredTool[] = []

  plugin.register(
    createApi({ enabled: true }, (descriptor, options) => {
      tools.push({ descriptor, options })
    }),
  )

  assert.equal(tools.length, 5)
  assert.deepEqual(
    tools.map((entry) => entry.descriptor.name).sort(),
    [
      'a2a_delegate',
      'a2a_delegate_stream',
      'a2a_task_cancel',
      'a2a_task_resubscribe',
      'a2a_task_status',
    ],
  )

  for (const entry of tools) {
    assert.deepEqual(entry.options, { optional: true })
    assert.ok(entry.descriptor.parameters)
    assert.equal(typeof entry.descriptor.execute, 'function')
  }
})

test('plugin registration parses pluginConfig through configSchema once', () => {
  const tools: RegisteredTool[] = []
  const configSchema = plugin.configSchema as {
    parse?: (value: unknown) => unknown
  }

  const originalParse = configSchema.parse
  assert.equal(typeof originalParse, 'function')

  let parseCalls = 0
  configSchema.parse = (value: unknown) => {
    parseCalls += 1
    return originalParse!(value)
  }

  try {
    plugin.register(
      createApi({ enabled: true }, (descriptor, options) => {
        tools.push({ descriptor, options })
      }),
    )
  } finally {
    configSchema.parse = originalParse
  }

  assert.equal(parseCalls, 1)
  assert.equal(tools.length, 5)
})

test('delegate tool rejects malformed input with validation envelope', async () => {
  const tools = new Map<string, AnyAgentTool>()

  plugin.register(
    createApi({ enabled: true }, (descriptor) => {
      tools.set(descriptor.name, descriptor)
    }),
  )

  const delegate = tools.get('a2a_delegate')
  assert.ok(delegate)
  const result = await executeTool(delegate, {
    target: {
      baseUrl: '',
    },
    request: {
      message: {},
    },
  })

  const payload = toFailure(readStructuredContent(result))
  const details = asRecord(payload.error.details)

  assert.equal(payload.operation, 'a2a_delegate')
  assert.equal(payload.error.code, 'VALIDATION_ERROR')
  assert.equal(details.source, 'ajv')
  assert.equal(details.tool, 'a2a_delegate')
  assert.ok(Array.isArray(details.errors))
  assert.ok((details.errors as unknown[]).length > 0)
})

test('delegate tool reports root-level shape mismatch details', async () => {
  const tools = new Map<string, AnyAgentTool>()

  plugin.register(
    createApi({ enabled: true }, (descriptor) => {
      tools.set(descriptor.name, descriptor)
    }),
  )

  const delegate = tools.get('a2a_delegate')
  assert.ok(delegate)
  const result = await executeTool(delegate, '{"target":{"baseUrl":"https://peer.example"}}')
  const payload = toFailure(readStructuredContent(result))
  const details = asRecord(payload.error.details)

  assert.equal(payload.operation, 'a2a_delegate')
  assert.equal(payload.error.code, 'VALIDATION_ERROR')
  assert.equal(details.source, 'ajv')
  assert.equal(details.tool, 'a2a_delegate')
  const errors = details.errors as Array<Record<string, unknown>>
  assert.ok(errors.length > 0)
  assert.ok(errors.some((e) => isRecord(e) && e.keyword === 'required' && e.instancePath === ''))
})

test('delegate tool accepts execute(callId, params) signature', async () => {
  const tools = new Map<string, AnyAgentTool>()

  plugin.register(
    createApi({ enabled: true }, (descriptor) => {
      tools.set(descriptor.name, descriptor)
    }),
  )

  const delegate = tools.get('a2a_delegate')
  assert.ok(delegate)
  const result = await executeToolByIdAndInput(delegate, 'call-1', {
    target: {
      baseUrl: '',
    },
    request: {
      message: {},
    },
  })

  const payload = toFailure(readStructuredContent(result))
  const details = asRecord(payload.error.details)
  const errors = details.errors as Array<Record<string, unknown>>

  assert.equal(payload.operation, 'a2a_delegate')
  assert.equal(payload.error.code, 'VALIDATION_ERROR')
  assert.ok(errors.length > 0)
  assert.ok(!errors.some((e) => isRecord(e) && e.keyword === 'type' && e.instancePath === ''))
})

test('delegate stream tool accepts execute(params) shorthand', async () => {
  const tools = new Map<string, AnyAgentTool>()

  plugin.register(
    createApi({ enabled: true }, (descriptor) => {
      tools.set(descriptor.name, descriptor)
    }),
  )

  const delegateStream = tools.get('a2a_delegate_stream')
  assert.ok(delegateStream)
  const result = await executeTool(delegateStream, {
    target: {
      baseUrl: '',
    },
    request: {
      message: {},
    },
  })

  const payload = toFailure(readStructuredContent(result))
  const details = asRecord(payload.error.details)

  assert.equal(payload.operation, 'a2a_delegate_stream')
  assert.equal(payload.error.code, 'VALIDATION_ERROR')
  assert.equal(details.tool, 'a2a_delegate_stream')
})

test('task resubscribe tool accepts execute(callId, params) shorthand', async () => {
  const tools = new Map<string, AnyAgentTool>()

  plugin.register(
    createApi({ enabled: true }, (descriptor) => {
      tools.set(descriptor.name, descriptor)
    }),
  )

  const resubscribe = tools.get('a2a_task_resubscribe')
  assert.ok(resubscribe)
  const result = await executeToolByIdAndInput(resubscribe, 'call-stream-1', {
    target: {
      baseUrl: 'http://peer.example',
    },
    request: {},
  })

  const payload = toFailure(readStructuredContent(result))
  const details = asRecord(payload.error.details)

  assert.equal(payload.operation, 'a2a_task_resubscribe')
  assert.equal(payload.error.code, 'VALIDATION_ERROR')
  assert.equal(details.tool, 'a2a_task_resubscribe')
})

test('delegate stream tool forwards per-event updates through onUpdate', async (t) => {
  const peer = await startStreamingPeer()
  t.after(() => peer.server.close())

  const tools = new Map<string, AnyAgentTool>()

  plugin.register(
    createApi({ enabled: true }, (descriptor) => {
      tools.set(descriptor.name, descriptor)
    }),
  )

  const delegateStream = tools.get('a2a_delegate_stream')
  assert.ok(delegateStream)

  const updates: unknown[] = []
  const result = await executeToolWithSignalAndUpdates(
    delegateStream,
    'call-stream-2',
    {
      target: {
        baseUrl: peer.baseUrl,
        cardPath: peer.cardPath,
      },
      request: {
        message: {
          kind: 'message',
          messageId: 'user-msg-stream-1',
          role: 'user',
          parts: [{ kind: 'text', text: 'hello stream' }],
        },
      },
    },
    undefined,
    (update) => updates.push(readStructuredContent(update)),
  )

  assert.equal(updates.length, 2)

  const firstUpdate = asRecord(updates[0])
  assert.equal(firstUpdate.ok, true)
  assert.equal(firstUpdate.operation, 'a2a_delegate_stream')
  assert.equal(firstUpdate.phase, 'update')
  assert.equal(asRecord(firstUpdate.summary).kind, 'task')
  assert.equal(asRecord(firstUpdate.raw).kind, 'task')

  const secondUpdate = asRecord(updates[1])
  assert.equal(secondUpdate.phase, 'update')
  assert.equal(asRecord(secondUpdate.summary).kind, 'status-update')
  assert.equal(asRecord(secondUpdate.summary).status, 'completed')

  const payload = readStructuredContent(result)
  assert.equal(payload.ok, true)
  assert.equal(payload.operation, 'a2a_delegate_stream')
  assert.equal(payload.summary.kind, 'stream')
  assert.equal(payload.summary.eventCount, 2)
  assert.equal(payload.summary.finalEventKind, 'status-update')
})
