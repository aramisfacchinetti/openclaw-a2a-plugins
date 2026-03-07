import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateCancelInput,
  validateDelegateInput,
  validateStatusInput,
} from '../dist/schemas.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'VALIDATION_ERROR'
  )
}

function ajvErrors(error: unknown): Array<Record<string, unknown>> {
  if (!isValidationError(error) || !isRecord(error) || !isRecord(error.details)) {
    return []
  }
  if (!Array.isArray(error.details.errors)) return []
  return error.details.errors.filter(isRecord)
}

function hasAjvError(
  error: unknown,
  predicate: (e: Record<string, unknown>) => boolean,
): boolean {
  return ajvErrors(error).some(predicate)
}

test('validateDelegateInput accepts strict SDK-native delegate envelope', () => {
  const out = validateDelegateInput({
    target: {
      baseUrl: 'http://peer.example',
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
    },
    request: {
      message: {
        kind: 'message',
        messageId: 'msg-1',
        role: 'user',
        parts: [{ kind: 'text', text: 'hello' }],
      },
      timeoutMs: 5000,
      serviceParameters: {
        'X-Trace-Id': 'trace-1',
      },
      metadata: {
        ticket: '123',
      },
    },
  })

  assert.equal(out.target.baseUrl, 'http://peer.example')
  assert.ok(out.target.preferredTransports)
  assert.equal(out.target.preferredTransports.length, 2)
  assert.equal(out.request.message.messageId, 'msg-1')
  assert.equal(out.request.timeoutMs, 5000)
  assert.ok(out.request.serviceParameters)
  assert.equal(out.request.serviceParameters['X-Trace-Id'], 'trace-1')
  assert.ok(out.request.metadata)
  assert.equal(out.request.metadata.ticket, '123')
})

test('validateDelegateInput accepts valid text, file(uri), file(bytes), and data parts', () => {
  const base = {
    target: {
      baseUrl: 'http://peer.example',
    },
  }

  const text = validateDelegateInput({
    ...base,
    request: {
      message: {
        kind: 'message',
        messageId: 'msg-text',
        role: 'user',
        parts: [{ kind: 'text', text: 'hello' }],
      },
    },
  })
  assert.equal(text.request.message.parts[0]?.kind, 'text')

  const fileUri = validateDelegateInput({
    ...base,
    request: {
      message: {
        kind: 'message',
        messageId: 'msg-file-uri',
        role: 'user',
        parts: [
          {
            kind: 'file',
            file: {
              uri: 'https://example.com/file.txt',
              name: 'file.txt',
              mimeType: 'text/plain',
            },
          },
        ],
      },
    },
  })
  assert.equal(fileUri.request.message.parts[0]?.kind, 'file')

  const fileBytes = validateDelegateInput({
    ...base,
    request: {
      message: {
        kind: 'message',
        messageId: 'msg-file-bytes',
        role: 'user',
        parts: [{ kind: 'file', file: { bytes: 'Zm9v' } }],
      },
    },
  })
  assert.equal(fileBytes.request.message.parts[0]?.kind, 'file')

  const data = validateDelegateInput({
    ...base,
    request: {
      message: {
        kind: 'message',
        messageId: 'msg-data',
        role: 'user',
        parts: [{ kind: 'data', data: { ticket: '123' } }],
      },
    },
  })
  assert.equal(data.request.message.parts[0]?.kind, 'data')
})

test('validateDelegateInput rejects missing request.message.kind', () => {
  assert.throws(
    () =>
      validateDelegateInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        request: {
          message: {
            messageId: 'msg-1',
            role: 'user',
            parts: [{ kind: 'text', text: 'hello' }],
          },
        },
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(error, (e) =>
        e.keyword === 'required' &&
        e.instancePath === '/request/message' &&
        isRecord(e.params) && e.params.missingProperty === 'kind',
      ),
  )
})

test('validateDelegateInput rejects invalid request.message.role', () => {
  assert.throws(
    () =>
      validateDelegateInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        request: {
          message: {
            kind: 'message',
            messageId: 'msg-1',
            role: 'system',
            parts: [{ kind: 'text', text: 'hello' }],
          },
        },
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(error, (e) =>
        e.keyword === 'enum' &&
        e.instancePath === '/request/message/role',
      ),
  )
})

test('validateDelegateInput rejects non-array request.message.parts', () => {
  assert.throws(
    () =>
      validateDelegateInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        request: {
          message: {
            kind: 'message',
            messageId: 'msg-1',
            role: 'user',
            parts: {
              kind: 'text',
              text: 'hello',
            },
          },
        },
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(error, (e) =>
        e.keyword === 'type' &&
        e.instancePath === '/request/message/parts',
      ),
  )
})

test('validateDelegateInput rejects unsupported part kind', () => {
  assert.throws(
    () =>
      validateDelegateInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        request: {
          message: {
            kind: 'message',
            messageId: 'msg-1',
            role: 'user',
            parts: [
              {
                kind: 'audio',
                data: {},
              },
            ],
          },
        },
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(error, (e) =>
        e.keyword === 'oneOf' &&
        e.instancePath === '/request/message/parts/0',
      ),
  )
})

test('validateDelegateInput rejects file part without uri and bytes', () => {
  assert.throws(
    () =>
      validateDelegateInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        request: {
          message: {
            kind: 'message',
            messageId: 'msg-1',
            role: 'user',
            parts: [
              {
                kind: 'file',
                file: {
                  name: 'missing-content.txt',
                },
              },
            ],
          },
        },
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(error, (e) =>
        typeof e.instancePath === 'string' &&
        (e.instancePath as string).startsWith('/request/message/parts/0'),
      ),
  )
})

test('validateDelegateInput rejects legacy aliases and malformed target shapes', () => {
  assert.throws(
    () =>
      validateDelegateInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        request: {
          task: 'legacy alias',
        },
      }),
    (error: unknown) => isValidationError(error),
  )

  assert.throws(
    () =>
      validateDelegateInput({
        target: {
          type: 'legacy',
          url: 'http://peer.example/rpc',
        },
        request: {
          message: {},
        },
      }),
    (error: unknown) => isValidationError(error),
  )

  assert.throws(
    () =>
      validateDelegateInput({
        target: {
          baseUrl: 'not-a-url',
        },
        request: {
          message: {},
        },
      }),
    (error: unknown) => isValidationError(error),
  )
})

test('validateStatusInput enforces nested request.taskId contract', () => {
  const out = validateStatusInput({
    target: {
      baseUrl: 'http://peer.example',
    },
    request: {
      taskId: 'task-1',
      historyLength: 2,
      timeoutMs: 900,
      serviceParameters: {
        'X-Trace-Id': 'trace-1',
      },
    },
  })

  assert.equal(out.request.taskId, 'task-1')
  assert.equal(out.request.historyLength, 2)
  assert.equal(out.request.timeoutMs, 900)

  assert.throws(
    () =>
      validateStatusInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        taskId: 'legacy-1',
      }),
    (error: unknown) => isValidationError(error),
  )
})

test('validateCancelInput enforces nested request.taskId contract', () => {
  const out = validateCancelInput({
    target: {
      baseUrl: 'http://peer.example',
      cardPath: '/agent-card.json',
    },
    request: {
      taskId: 'task-2',
      timeoutMs: 1200,
      serviceParameters: {
        'X-Trace-Id': 'trace-2',
      },
    },
  })

  assert.equal(out.target.cardPath, '/agent-card.json')
  assert.equal(out.request.taskId, 'task-2')
  assert.equal(out.request.timeoutMs, 1200)

  assert.throws(
    () =>
      validateCancelInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        request: {
          taskId: 'task-2',
          extra: true,
        },
      }),
    (error: unknown) => isValidationError(error),
  )
})
