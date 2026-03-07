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
  assert.notStrictEqual(parsed.targets, A2A_OUTBOUND_DEFAULT_CONFIG.targets)
  assert.notStrictEqual(parsed.taskHandles, A2A_OUTBOUND_DEFAULT_CONFIG.taskHandles)
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
      taskHandles: {
        ttlMs: 0,
        maxEntries: 'many',
      },
      policy: {
        normalizeBaseUrl: 'false',
        enforceSupportedTransports: 1,
        allowTargetUrlOverride: 'yes',
      },
    })
  })

  const parsed = parseA2AOutboundPluginConfig({
    enabled: 'yes',
    defaults: {
      timeoutMs: 0,
      cardPath: '  ',
    },
    taskHandles: {
      ttlMs: 0,
      maxEntries: 'many',
    },
    policy: {
      normalizeBaseUrl: 'false',
      enforceSupportedTransports: 1,
      allowTargetUrlOverride: 'yes',
    },
  })

  assert.equal(parsed.enabled, A2A_OUTBOUND_DEFAULT_CONFIG.enabled)
  assert.equal(parsed.defaults.timeoutMs, A2A_OUTBOUND_DEFAULT_CONFIG.defaults.timeoutMs)
  assert.equal(parsed.defaults.cardPath, A2A_OUTBOUND_DEFAULT_CONFIG.defaults.cardPath)
  assert.equal(parsed.taskHandles.ttlMs, A2A_OUTBOUND_DEFAULT_CONFIG.taskHandles.ttlMs)
  assert.equal(
    parsed.taskHandles.maxEntries,
    A2A_OUTBOUND_DEFAULT_CONFIG.taskHandles.maxEntries,
  )
  assert.equal(parsed.policy.normalizeBaseUrl, A2A_OUTBOUND_DEFAULT_CONFIG.policy.normalizeBaseUrl)
  assert.equal(
    parsed.policy.enforceSupportedTransports,
    A2A_OUTBOUND_DEFAULT_CONFIG.policy.enforceSupportedTransports,
  )
  assert.equal(
    parsed.policy.allowTargetUrlOverride,
    A2A_OUTBOUND_DEFAULT_CONFIG.policy.allowTargetUrlOverride,
  )
})

test('targets normalize trimmed values, dedupe arrays, and materialize per-target defaults', () => {
  const parsed = parseA2AOutboundPluginConfig({
    defaults: {
      cardPath: ' /delegation/card.json ',
      preferredTransports: ['GRPC', 'HTTP+JSON'],
    },
    targets: [
      {
        alias: ' support ',
        baseUrl: ' https://support.example/a2a ',
        description: ' Primary escalation queue ',
        tags: [' ops ', 'support', 'ops', ''],
        cardPath: ' /support/card.json ',
        preferredTransports: [' HTTP+JSON ', 'INVALID', 'HTTP+JSON'],
        examples: [' delegate support ', 'delegate support', '', 'escalate'],
        default: true,
      },
      {
        alias: 'sales',
        baseUrl: ' https://sales.example/a2a ',
        description: ' ',
        tags: [' revenue ', 7, 'revenue'],
        cardPath: '   ',
        preferredTransports: ['INVALID', '', null],
        examples: ['intro', ' intro '],
        default: 'yes',
      },
    ],
  })

  assert.deepEqual(parsed.targets, [
    {
      alias: 'support',
      baseUrl: 'https://support.example/a2a',
      description: 'Primary escalation queue',
      tags: ['ops', 'support'],
      cardPath: '/support/card.json',
      preferredTransports: ['HTTP+JSON'],
      examples: ['delegate support', 'escalate'],
      default: true,
    },
    {
      alias: 'sales',
      baseUrl: 'https://sales.example/a2a',
      tags: ['revenue'],
      cardPath: '/delegation/card.json',
      preferredTransports: ['GRPC', 'HTTP+JSON'],
      examples: ['intro'],
      default: false,
    },
  ])
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

for (const testCase of [
  {
    name: 'blank alias',
    input: {
      targets: [{ alias: '   ', baseUrl: 'https://example.com/a2a' }],
    },
    pattern: /targets\[0\]\.alias/,
  },
  {
    name: 'blank base URL',
    input: {
      targets: [{ alias: 'support', baseUrl: '   ' }],
    },
    pattern: /targets\[0\]\.baseUrl/,
  },
  {
    name: 'duplicate aliases after trimming',
    input: {
      targets: [
        { alias: 'support', baseUrl: 'https://one.example/a2a' },
        { alias: ' support ', baseUrl: 'https://two.example/a2a' },
      ],
    },
    pattern: /duplicate alias "support"/,
  },
  {
    name: 'multiple default targets',
    input: {
      targets: [
        { alias: 'support', baseUrl: 'https://one.example/a2a', default: true },
        { alias: 'sales', baseUrl: 'https://two.example/a2a', default: true },
      ],
    },
    pattern: /multiple default entries/,
  },
]) {
  test(`target registry validation rejects ${testCase.name}`, () => {
    assert.throws(() => parseA2AOutboundPluginConfig(testCase.input), testCase.pattern)
  })
}
