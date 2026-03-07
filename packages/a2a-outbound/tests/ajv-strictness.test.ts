import test from 'node:test'
import assert from 'node:assert/strict'
import { createA2AOutboundAjv } from '../dist/ajv-validator.js'

test('strict mode rejects schemas with unknown keywords', () => {
  const ajv = createA2AOutboundAjv()

  assert.throws(
    () =>
      ajv.compile({
        type: 'object',
        unknownKeyword: true,
      }),
    (error: unknown) =>
      error instanceof Error && /unknown keyword/i.test(error.message),
  )
})

test('strict mode compiles valid schemas successfully', () => {
  const ajv = createA2AOutboundAjv()

  const validate = ajv.compile({
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 0 },
    },
    required: ['name'],
  })

  assert.equal(typeof validate, 'function')
  assert.ok(validate({ name: 'test', count: 1 }))
  assert.ok(!validate({ count: 'not a number' }))
})
