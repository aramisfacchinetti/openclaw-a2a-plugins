import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { A2AOutboundPluginConfig } from '../dist/config.js'
import {
  A2A_OUTBOUND_DEFAULT_CONFIG,
  A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA,
  parseA2AOutboundPluginConfig,
} from '../dist/config.js'

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('expected object')
  }

  return value as JsonRecord
}

function readManifestConfigSchema(): JsonRecord {
  const raw = readFileSync(
    new URL('../openclaw.plugin.json', import.meta.url),
    'utf8',
  )

  const manifest = JSON.parse(raw)
  return asRecord(asRecord(manifest).configSchema)
}

function schemaDefault(schema: JsonRecord, path: string[]): unknown {
  let node: unknown = schema

  for (const segment of path) {
    node = asRecord(node)[segment]
  }

  return asRecord(node).default
}

test('empty parser input returns cloned defaults', () => {
  const parsed = parseA2AOutboundPluginConfig(undefined)

  assert.deepEqual(parsed, A2A_OUTBOUND_DEFAULT_CONFIG)
  assert.notStrictEqual(parsed, A2A_OUTBOUND_DEFAULT_CONFIG)
  assert.notStrictEqual(parsed.defaults, A2A_OUTBOUND_DEFAULT_CONFIG.defaults)
  assert.notStrictEqual(parsed.targets, A2A_OUTBOUND_DEFAULT_CONFIG.targets)
  assert.notStrictEqual(parsed.taskHandles, A2A_OUTBOUND_DEFAULT_CONFIG.taskHandles)
  assert.notStrictEqual(
    parsed.defaults.preferredTransports,
    A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports,
  )
})

test('partial parser input merges with defaults for targets and taskHandles', () => {
  const parsed = parseA2AOutboundPluginConfig({
    enabled: true,
    defaults: {
      timeoutMs: 5000,
      serviceParameters: {
        'X-Test': 'yes',
      },
    },
    targets: [
      {
        alias: ' support ',
        baseUrl: ' https://support.example/a2a ',
        tags: [' ops ', 'ops'],
      },
    ],
    taskHandles: {
      ttlMs: 5000,
    },
    policy: {
      normalizeBaseUrl: false,
    },
  })

  assert.equal(parsed.enabled, true)
  assert.equal(parsed.defaults.timeoutMs, 5000)
  assert.equal(parsed.defaults.cardPath, A2A_OUTBOUND_DEFAULT_CONFIG.defaults.cardPath)
  assert.deepEqual(
    parsed.defaults.preferredTransports,
    A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports,
  )
  assert.deepEqual(parsed.defaults.serviceParameters, { 'X-Test': 'yes' })
  assert.deepEqual(parsed.targets, [
    {
      alias: 'support',
      baseUrl: 'https://support.example/a2a',
      tags: ['ops'],
      cardPath: A2A_OUTBOUND_DEFAULT_CONFIG.defaults.cardPath,
      preferredTransports: A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports,
      examples: [],
      default: false,
    },
  ])
  assert.deepEqual(parsed.taskHandles, {
    ttlMs: 5000,
    maxEntries: A2A_OUTBOUND_DEFAULT_CONFIG.taskHandles.maxEntries,
  })
  assert.equal(parsed.policy.normalizeBaseUrl, false)
  assert.equal(
    parsed.policy.enforceSupportedTransports,
    A2A_OUTBOUND_DEFAULT_CONFIG.policy.enforceSupportedTransports,
  )
  assert.equal(
    parsed.policy.allowTargetUrlOverride,
    A2A_OUTBOUND_DEFAULT_CONFIG.policy.allowTargetUrlOverride,
  )
})

test('invalid parser field types fall back to defaults', () => {
  const parsed = parseA2AOutboundPluginConfig({
    enabled: 'yes',
    defaults: {
      timeoutMs: 'fast',
      cardPath: 42,
      preferredTransports: 'JSONRPC',
      serviceParameters: 'invalid',
    },
    taskHandles: {
      ttlMs: 'slow',
      maxEntries: 0,
    },
    policy: {
      acceptedOutputModes: 'text/plain',
      normalizeBaseUrl: 'false',
      enforceSupportedTransports: 1,
      allowTargetUrlOverride: 'yes',
    },
  })

  assert.deepEqual(parsed, A2A_OUTBOUND_DEFAULT_CONFIG)
})

test('transport parser keeps only supported enum values', () => {
  const parsed = parseA2AOutboundPluginConfig({
    defaults: {
      preferredTransports: [
        'GRPC',
        'HTTP+JSON',
        'INVALID',
        'HTTP+JSON',
        '',
        'JSONRPC',
      ],
    },
  })

  assert.deepEqual(parsed.defaults.preferredTransports, [
    'GRPC',
    'HTTP+JSON',
    'JSONRPC',
  ])
})

test('config schema parse delegates to parser', () => {
  const parsed = A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA.parse?.({
    enabled: true,
    taskHandles: {
      maxEntries: 12,
    },
  }) as A2AOutboundPluginConfig

  assert.equal(parsed.enabled, true)
  assert.equal(parsed.taskHandles.maxEntries, 12)
})

test('manifest defaults stay in parity for key config fields', () => {
  const manifestConfigSchema = readManifestConfigSchema()
  const parserDefaults = parseA2AOutboundPluginConfig({})

  assert.equal(
    schemaDefault(manifestConfigSchema, ['properties', 'enabled']),
    parserDefaults.enabled,
  )
  assert.equal(
    schemaDefault(manifestConfigSchema, [
      'properties',
      'defaults',
      'properties',
      'timeoutMs',
    ]),
    parserDefaults.defaults.timeoutMs,
  )
  assert.equal(
    schemaDefault(manifestConfigSchema, [
      'properties',
      'defaults',
      'properties',
      'cardPath',
    ]),
    parserDefaults.defaults.cardPath,
  )
  assert.deepEqual(
    schemaDefault(manifestConfigSchema, [
      'properties',
      'defaults',
      'properties',
      'preferredTransports',
    ]),
    parserDefaults.defaults.preferredTransports,
  )
  assert.deepEqual(
    schemaDefault(manifestConfigSchema, ['properties', 'targets']),
    parserDefaults.targets,
  )
  assert.equal(
    schemaDefault(manifestConfigSchema, [
      'properties',
      'taskHandles',
      'properties',
      'ttlMs',
    ]),
    parserDefaults.taskHandles.ttlMs,
  )
  assert.equal(
    schemaDefault(manifestConfigSchema, [
      'properties',
      'taskHandles',
      'properties',
      'maxEntries',
    ]),
    parserDefaults.taskHandles.maxEntries,
  )
  assert.equal(
    schemaDefault(manifestConfigSchema, [
      'properties',
      'policy',
      'properties',
      'normalizeBaseUrl',
    ]),
    parserDefaults.policy.normalizeBaseUrl,
  )
  assert.equal(
    schemaDefault(manifestConfigSchema, [
      'properties',
      'policy',
      'properties',
      'enforceSupportedTransports',
    ]),
    parserDefaults.policy.enforceSupportedTransports,
  )
  assert.equal(
    schemaDefault(manifestConfigSchema, [
      'properties',
      'policy',
      'properties',
      'allowTargetUrlOverride',
    ]),
    parserDefaults.policy.allowTargetUrlOverride,
  )
})

for (const testCase of [
  {
    name: 'non-array targets',
    input: {
      targets: 'support',
    },
    pattern: /targets must be an array/,
  },
  {
    name: 'non-object target entries',
    input: {
      targets: ['support'],
    },
    pattern: /targets\[0\] must be an object/,
  },
  {
    name: 'duplicate aliases',
    input: {
      targets: [
        { alias: 'support', baseUrl: 'https://one.example/a2a' },
        { alias: 'support', baseUrl: 'https://two.example/a2a' },
      ],
    },
    pattern: /duplicate alias/,
  },
  {
    name: 'multiple defaults',
    input: {
      targets: [
        { alias: 'support', baseUrl: 'https://one.example/a2a', default: true },
        { alias: 'sales', baseUrl: 'https://two.example/a2a', default: true },
      ],
    },
    pattern: /multiple default entries/,
  },
]) {
  test(`parser rejects invalid target registry with ${testCase.name}`, () => {
    assert.throws(() => parseA2AOutboundPluginConfig(testCase.input), testCase.pattern)
  })
}
