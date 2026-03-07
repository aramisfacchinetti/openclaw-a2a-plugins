import test from 'node:test'
import assert from 'node:assert/strict'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError('expected object')
  }

  return value
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

test('plugin registration with enabled=false registers no tools', () => {
  const tools: RegisteredTool[] = []

  plugin.register(
    createApi({ enabled: false }, (descriptor, options) => {
      tools.push({ descriptor, options })
    }),
  )

  assert.equal(tools.length, 0)
})

test('plugin registers the four public a2a tools with optional flag', () => {
  const tools: RegisteredTool[] = []

  plugin.register(
    createApi({ enabled: true }, (descriptor, options) => {
      tools.push({ descriptor, options })
    }),
  )

  assert.equal(tools.length, 4)
  assert.deepEqual(
    tools.map((entry) => entry.descriptor.name).sort(),
    [
      'a2a_delegate',
      'a2a_task_cancel',
      'a2a_task_status',
      'a2a_task_wait',
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
  assert.equal(tools.length, 4)
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

test('task wait tool accepts execute(callId, params) shorthand', async () => {
  const tools = new Map<string, AnyAgentTool>()

  plugin.register(
    createApi({ enabled: true }, (descriptor) => {
      tools.set(descriptor.name, descriptor)
    }),
  )

  const wait = tools.get('a2a_task_wait')
  assert.ok(wait)
  const result = await executeToolByIdAndInput(wait, 'call-wait-1', {
    target: {
      baseUrl: 'http://peer.example',
    },
    request: {
      taskId: 'task-1',
    },
  })

  const payload = toFailure(readStructuredContent(result))
  const details = asRecord(payload.error.details)

  assert.equal(payload.operation, 'a2a_task_wait')
  assert.equal(payload.error.code, 'VALIDATION_ERROR')
  assert.equal(details.tool, 'a2a_task_wait')
})

test('task wait tool rejects malformed input with validation envelope', async () => {
  const tools = new Map<string, AnyAgentTool>()

  plugin.register(
    createApi({ enabled: true }, (descriptor) => {
      tools.set(descriptor.name, descriptor)
    }),
  )

  const wait = tools.get('a2a_task_wait')
  assert.ok(wait)
  const result = await executeTool(wait, {
    target: {
      baseUrl: '',
    },
    request: {
      taskId: '',
    },
  })

  const payload = toFailure(readStructuredContent(result))
  const details = asRecord(payload.error.details)

  assert.equal(payload.operation, 'a2a_task_wait')
  assert.equal(payload.error.code, 'VALIDATION_ERROR')
  assert.equal(details.tool, 'a2a_task_wait')
})
