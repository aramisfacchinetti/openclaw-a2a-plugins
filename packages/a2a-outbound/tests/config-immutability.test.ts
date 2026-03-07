import test from 'node:test'
import assert from 'node:assert/strict'
import {
  A2A_OUTBOUND_DEFAULT_CONFIG,
  type A2AOutboundPluginConfig,
  parseA2AOutboundPluginConfig,
} from '../dist/config.js'
import { A2AOutboundService } from '../dist/service.js'

test('parser output instances never share mutable references', () => {
  const input = {
    enabled: true,
    defaults: {
      timeoutMs: 500,
      cardPath: '/.well-known/agent-card.json',
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
      serviceParameters: {
        'X-Test': '1',
      },
    },
    targets: [
      {
        alias: 'alpha',
        baseUrl: 'https://alpha.example/a2a',
        description: 'Primary target',
        tags: ['core'],
        cardPath: '/alpha/card.json',
        preferredTransports: ['JSONRPC'],
        examples: ['delegate alpha'],
        default: true,
      },
    ],
    taskHandles: {
      ttlMs: 60000,
      maxEntries: 25,
    },
    policy: {
      acceptedOutputModes: ['text/plain'],
      normalizeBaseUrl: true,
      enforceSupportedTransports: true,
      allowTargetUrlOverride: false,
    },
  }

  const parsedA = parseA2AOutboundPluginConfig(input)
  const parsedB = parseA2AOutboundPluginConfig(input)

  assert.notStrictEqual(parsedA, parsedB)
  assert.notStrictEqual(parsedA.defaults, parsedB.defaults)
  assert.notStrictEqual(parsedA.targets, parsedB.targets)
  assert.notStrictEqual(parsedA.targets[0], parsedB.targets[0])
  assert.notStrictEqual(parsedA.targets[0].tags, parsedB.targets[0].tags)
  assert.notStrictEqual(
    parsedA.targets[0].preferredTransports,
    parsedB.targets[0].preferredTransports,
  )
  assert.notStrictEqual(parsedA.targets[0].examples, parsedB.targets[0].examples)
  assert.notStrictEqual(parsedA.taskHandles, parsedB.taskHandles)
  assert.notStrictEqual(parsedA.policy, parsedB.policy)
  assert.notStrictEqual(
    parsedA.defaults.preferredTransports,
    parsedB.defaults.preferredTransports,
  )
  assert.notStrictEqual(
    parsedA.defaults.serviceParameters,
    parsedB.defaults.serviceParameters,
  )
  assert.notStrictEqual(
    parsedA.policy.acceptedOutputModes,
    parsedB.policy.acceptedOutputModes,
  )

  parsedA.defaults.preferredTransports.push('GRPC')
  parsedA.defaults.serviceParameters['X-Mutated'] = 'yes'
  parsedA.targets.push({
    alias: 'beta',
    baseUrl: 'https://beta.example/a2a',
    tags: [],
    cardPath: '/.well-known/agent-card.json',
    preferredTransports: ['HTTP+JSON'],
    examples: [],
    default: false,
  })
  parsedA.targets[0].tags.push('priority')
  parsedA.targets[0].preferredTransports.push('HTTP+JSON')
  parsedA.targets[0].examples.push('fallback')
  parsedA.taskHandles.maxEntries = 99
  parsedA.policy.acceptedOutputModes.push('application/json')

  assert.deepEqual(parsedB.defaults.preferredTransports, ['JSONRPC', 'HTTP+JSON'])
  assert.deepEqual(parsedB.defaults.serviceParameters, { 'X-Test': '1' })
  assert.deepEqual(parsedB.targets, [
    {
      alias: 'alpha',
      baseUrl: 'https://alpha.example/a2a',
      description: 'Primary target',
      tags: ['core'],
      cardPath: '/alpha/card.json',
      preferredTransports: ['JSONRPC'],
      examples: ['delegate alpha'],
      default: true,
    },
  ])
  assert.deepEqual(parsedB.taskHandles, {
    ttlMs: 60000,
    maxEntries: 25,
  })
  assert.deepEqual(parsedB.policy.acceptedOutputModes, ['text/plain'])

  assert.deepEqual(A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports, [
    'JSONRPC',
    'HTTP+JSON',
  ])
  assert.deepEqual(A2A_OUTBOUND_DEFAULT_CONFIG.defaults.serviceParameters, {})
  assert.deepEqual(A2A_OUTBOUND_DEFAULT_CONFIG.targets, [])
  assert.deepEqual(A2A_OUTBOUND_DEFAULT_CONFIG.taskHandles, {
    ttlMs: 86400000,
    maxEntries: 1000,
  })
  assert.deepEqual(A2A_OUTBOUND_DEFAULT_CONFIG.policy.acceptedOutputModes, [])
})

test('service instances keep isolated normalized configs', () => {
  const sourceConfig: A2AOutboundPluginConfig = {
    enabled: true,
    defaults: {
      timeoutMs: 200,
      cardPath: '/.well-known/agent-card.json',
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
      serviceParameters: {
        'X-Source': 'source',
      },
    },
    targets: [
      {
        alias: 'alpha',
        baseUrl: 'https://alpha.example/a2a',
        description: 'Primary target',
        tags: ['core'],
        cardPath: '/alpha/card.json',
        preferredTransports: ['JSONRPC'],
        examples: ['delegate alpha'],
        default: true,
      },
    ],
    taskHandles: {
      ttlMs: 120000,
      maxEntries: 30,
    },
    policy: {
      acceptedOutputModes: ['text/plain'],
      normalizeBaseUrl: true,
      enforceSupportedTransports: true,
      allowTargetUrlOverride: false,
    },
  }

  const serviceA = new A2AOutboundService({ config: sourceConfig })
  const serviceB = new A2AOutboundService({ config: sourceConfig })

  const configA = (serviceA as unknown as { config: A2AOutboundPluginConfig }).config
  const configB = (serviceB as unknown as { config: A2AOutboundPluginConfig }).config

  assert.notStrictEqual(configA, configB)
  assert.notStrictEqual(configA.defaults, configB.defaults)
  assert.notStrictEqual(configA.targets, configB.targets)
  assert.notStrictEqual(configA.targets[0], configB.targets[0])
  assert.notStrictEqual(configA.targets[0].tags, configB.targets[0].tags)
  assert.notStrictEqual(
    configA.targets[0].preferredTransports,
    configB.targets[0].preferredTransports,
  )
  assert.notStrictEqual(configA.targets[0].examples, configB.targets[0].examples)
  assert.notStrictEqual(configA.taskHandles, configB.taskHandles)
  assert.notStrictEqual(configA.policy, configB.policy)
  assert.notStrictEqual(
    configA.defaults.preferredTransports,
    configB.defaults.preferredTransports,
  )
  assert.notStrictEqual(
    configA.defaults.serviceParameters,
    configB.defaults.serviceParameters,
  )

  configA.defaults.preferredTransports.push('GRPC')
  configA.defaults.serviceParameters['X-Mutated'] = 'mutated'
  configA.targets[0].tags.push('priority')
  configA.targets[0].preferredTransports.push('HTTP+JSON')
  configA.targets[0].examples.push('fallback')
  configA.taskHandles.maxEntries = 88
  configA.policy.acceptedOutputModes.push('application/json')

  assert.deepEqual(configB.defaults.preferredTransports, ['JSONRPC', 'HTTP+JSON'])
  assert.deepEqual(configB.defaults.serviceParameters, { 'X-Source': 'source' })
  assert.deepEqual(configB.targets, [
    {
      alias: 'alpha',
      baseUrl: 'https://alpha.example/a2a',
      description: 'Primary target',
      tags: ['core'],
      cardPath: '/alpha/card.json',
      preferredTransports: ['JSONRPC'],
      examples: ['delegate alpha'],
      default: true,
    },
  ])
  assert.deepEqual(configB.taskHandles, {
    ttlMs: 120000,
    maxEntries: 30,
  })
  assert.deepEqual(configB.policy.acceptedOutputModes, ['text/plain'])

  assert.deepEqual(sourceConfig.defaults.preferredTransports, ['JSONRPC', 'HTTP+JSON'])
  assert.deepEqual(sourceConfig.defaults.serviceParameters, { 'X-Source': 'source' })
  assert.deepEqual(sourceConfig.targets, [
    {
      alias: 'alpha',
      baseUrl: 'https://alpha.example/a2a',
      description: 'Primary target',
      tags: ['core'],
      cardPath: '/alpha/card.json',
      preferredTransports: ['JSONRPC'],
      examples: ['delegate alpha'],
      default: true,
    },
  ])
  assert.deepEqual(sourceConfig.taskHandles, {
    ttlMs: 120000,
    maxEntries: 30,
  })
  assert.deepEqual(sourceConfig.policy.acceptedOutputModes, ['text/plain'])
})
