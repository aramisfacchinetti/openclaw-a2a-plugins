import test from 'node:test'
import assert from 'node:assert/strict'
import {
  A2A_OUTBOUND_DEFAULT_CONFIG,
  parseA2AOutboundPluginConfig,
} from '../dist/config.js'

test('parse(undefined) returns defaults with cloned nested values', () => {
  const parsed = parseA2AOutboundPluginConfig(undefined)

  assert.deepEqual(parsed, A2A_OUTBOUND_DEFAULT_CONFIG)
  assert.notStrictEqual(parsed, A2A_OUTBOUND_DEFAULT_CONFIG)
  assert.notStrictEqual(parsed.defaults, A2A_OUTBOUND_DEFAULT_CONFIG.defaults)
  assert.notStrictEqual(parsed.policy, A2A_OUTBOUND_DEFAULT_CONFIG.policy)
  assert.notStrictEqual(
    parsed.defaults.preferredTransports,
    A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports,
  )
  assert.notStrictEqual(
    parsed.defaults.serviceParameters,
    A2A_OUTBOUND_DEFAULT_CONFIG.defaults.serviceParameters,
  )
  assert.notStrictEqual(
    parsed.policy.acceptedOutputModes,
    A2A_OUTBOUND_DEFAULT_CONFIG.policy.acceptedOutputModes,
  )
})

test('non-object config input returns defaults', () => {
  for (const input of [null, [], 'invalid']) {
    const parsed = parseA2AOutboundPluginConfig(input)
    assert.deepEqual(parsed, A2A_OUTBOUND_DEFAULT_CONFIG)
  }
})

test('invalid scalar values fall back to defaults without throwing', () => {
  assert.doesNotThrow(() => {
    parseA2AOutboundPluginConfig({
      enabled: 'yes',
      defaults: {
        timeoutMs: 0,
        cardPath: '  ',
      },
      policy: {
        normalizeBaseUrl: 'false',
        enforceSupportedTransports: 1,
      },
    })
  })

  const parsed = parseA2AOutboundPluginConfig({
    enabled: 'yes',
    defaults: {
      timeoutMs: 0,
      cardPath: '  ',
    },
    policy: {
      normalizeBaseUrl: 'false',
      enforceSupportedTransports: 1,
    },
  })

  assert.equal(parsed.enabled, A2A_OUTBOUND_DEFAULT_CONFIG.enabled)
  assert.equal(parsed.defaults.timeoutMs, A2A_OUTBOUND_DEFAULT_CONFIG.defaults.timeoutMs)
  assert.equal(parsed.defaults.cardPath, A2A_OUTBOUND_DEFAULT_CONFIG.defaults.cardPath)
  assert.equal(parsed.policy.normalizeBaseUrl, A2A_OUTBOUND_DEFAULT_CONFIG.policy.normalizeBaseUrl)
  assert.equal(
    parsed.policy.enforceSupportedTransports,
    A2A_OUTBOUND_DEFAULT_CONFIG.policy.enforceSupportedTransports,
  )
})

test('preferredTransports keeps known values, dedupes, and falls back when empty', () => {
  const normalized = parseA2AOutboundPluginConfig({
    defaults: {
      preferredTransports: [
        'GRPC',
        'HTTP+JSON',
        'INVALID',
        '',
        'HTTP+JSON',
      ],
    },
  })

  assert.deepEqual(normalized.defaults.preferredTransports, ['GRPC', 'HTTP+JSON'])

  const fallback = parseA2AOutboundPluginConfig({
    defaults: {
      preferredTransports: ['INVALID', '', 1, null],
    },
  })

  assert.deepEqual(
    fallback.defaults.preferredTransports,
    A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports,
  )
})

test('serviceParameters keeps only string-valued entries', () => {
  const parsed = parseA2AOutboundPluginConfig({
    defaults: {
      serviceParameters: {
        'X-String': 'ok',
        'X-Number': 1,
        'X-Boolean': false,
        'X-Null': null,
        'X-String-2': 'still-ok',
      },
    },
  })

  assert.deepEqual(parsed.defaults.serviceParameters, {
    'X-String': 'ok',
    'X-String-2': 'still-ok',
  })
})

test('acceptedOutputModes keeps non-empty strings and dedupes', () => {
  const parsed = parseA2AOutboundPluginConfig({
    policy: {
      acceptedOutputModes: [
        'text/plain',
        '',
        'text/plain',
        'application/json',
        7,
      ],
    },
  })

  assert.deepEqual(parsed.policy.acceptedOutputModes, [
    'text/plain',
    'application/json',
  ])
})
