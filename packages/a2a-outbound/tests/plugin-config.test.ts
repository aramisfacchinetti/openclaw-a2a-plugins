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
  assert.notStrictEqual(
    parsed.defaults.preferredTransports,
    A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports,
  )
})

test('partial parser input merges with defaults', () => {
  const parsed = parseA2AOutboundPluginConfig({
    enabled: true,
    defaults: {
      timeoutMs: 5000,
      serviceParameters: {
        'X-Test': 'yes',
      },
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
  assert.equal(parsed.policy.normalizeBaseUrl, false)
  assert.equal(
    parsed.policy.enforceSupportedTransports,
    A2A_OUTBOUND_DEFAULT_CONFIG.policy.enforceSupportedTransports,
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
    policy: {
      acceptedOutputModes: 'text/plain',
      normalizeBaseUrl: 'false',
      enforceSupportedTransports: 1,
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
  }) as A2AOutboundPluginConfig

  assert.equal(parsed.enabled, true)
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
})
