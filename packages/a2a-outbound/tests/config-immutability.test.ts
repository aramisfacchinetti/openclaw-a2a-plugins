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
    policy: {
      acceptedOutputModes: ['text/plain'],
      normalizeBaseUrl: true,
      enforceSupportedTransports: true,
    },
  }

  const parsedA = parseA2AOutboundPluginConfig(input)
  const parsedB = parseA2AOutboundPluginConfig(input)

  assert.notStrictEqual(parsedA, parsedB)
  assert.notStrictEqual(parsedA.defaults, parsedB.defaults)
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
  parsedA.policy.acceptedOutputModes.push('application/json')

  assert.deepEqual(parsedB.defaults.preferredTransports, ['JSONRPC', 'HTTP+JSON'])
  assert.deepEqual(parsedB.defaults.serviceParameters, { 'X-Test': '1' })
  assert.deepEqual(parsedB.policy.acceptedOutputModes, ['text/plain'])

  assert.deepEqual(A2A_OUTBOUND_DEFAULT_CONFIG.defaults.preferredTransports, [
    'JSONRPC',
    'HTTP+JSON',
  ])
  assert.deepEqual(A2A_OUTBOUND_DEFAULT_CONFIG.defaults.serviceParameters, {})
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
    policy: {
      acceptedOutputModes: ['text/plain'],
      normalizeBaseUrl: true,
      enforceSupportedTransports: true,
    },
  }

  const serviceA = new A2AOutboundService({ config: sourceConfig })
  const serviceB = new A2AOutboundService({ config: sourceConfig })

  const configA = (serviceA as unknown as { config: A2AOutboundPluginConfig }).config
  const configB = (serviceB as unknown as { config: A2AOutboundPluginConfig }).config

  assert.notStrictEqual(configA, configB)
  assert.notStrictEqual(configA.defaults, configB.defaults)
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
  configA.policy.acceptedOutputModes.push('application/json')

  assert.deepEqual(configB.defaults.preferredTransports, ['JSONRPC', 'HTTP+JSON'])
  assert.deepEqual(configB.defaults.serviceParameters, { 'X-Source': 'source' })
  assert.deepEqual(configB.policy.acceptedOutputModes, ['text/plain'])

  assert.deepEqual(sourceConfig.defaults.preferredTransports, ['JSONRPC', 'HTTP+JSON'])
  assert.deepEqual(sourceConfig.defaults.serviceParameters, { 'X-Source': 'source' })
  assert.deepEqual(sourceConfig.policy.acceptedOutputModes, ['text/plain'])
})
