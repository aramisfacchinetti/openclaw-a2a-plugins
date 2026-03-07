import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOOL_DEFINITIONS,
  validateCancelInput,
  validateDelegateInput,
  validateDelegateStreamInput,
  validateResubscribeInput,
  validateStatusInput,
  validateWaitInput,
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
  const configuration = {
    blocking: true,
    acceptedOutputModes: ['text/plain', 'application/json'],
    historyLength: 4,
    pushNotificationConfig: {
      url: 'https://notify.example/hooks/123',
      id: 'push-1',
      token: 'push-token',
      authentication: {
        schemes: ['Bearer', 'Basic'],
        credentials: 'credential-1',
      },
    },
  }

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
      configuration,
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
  assert.deepEqual(out.request.configuration, configuration)
})

test('validateDelegateStreamInput accepts the delegate streaming envelope', () => {
  const out = validateDelegateStreamInput({
    target: {
      baseUrl: 'http://peer.example',
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
    },
    request: {
      message: {
        kind: 'message',
        messageId: 'msg-stream-1',
        role: 'user',
        parts: [{ kind: 'text', text: 'hello stream' }],
      },
      timeoutMs: 5000,
      serviceParameters: {
        'X-Trace-Id': 'trace-stream-1',
      },
      metadata: {
        ticket: 'stream-123',
      },
      configuration: {
        blocking: true,
        acceptedOutputModes: ['text/plain'],
      },
    },
  })

  assert.equal(out.target.baseUrl, 'http://peer.example')
  assert.equal(out.request.message.messageId, 'msg-stream-1')
  assert.equal(out.request.timeoutMs, 5000)
  assert.equal(out.request.serviceParameters?.['X-Trace-Id'], 'trace-stream-1')
  assert.equal(out.request.metadata?.ticket, 'stream-123')
  assert.deepEqual(out.request.configuration, {
    blocking: true,
    acceptedOutputModes: ['text/plain'],
  })
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

const delegateConfigurationValidationCases = [
  {
    name: 'unknown configuration keys',
    input: {
      blocking: true,
      unexpected: true,
    },
    predicate: (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (e) =>
          e.keyword === 'additionalProperties' &&
          e.instancePath === '/request/configuration' &&
          isRecord(e.params) &&
          e.params.additionalProperty === 'unexpected',
      ),
  },
  {
    name: 'non-boolean configuration.blocking',
    input: {
      blocking: 'yes',
    },
    predicate: (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (e) =>
          e.keyword === 'type' &&
          e.instancePath === '/request/configuration/blocking',
      ),
  },
  {
    name: 'non-array configuration.acceptedOutputModes',
    input: {
      acceptedOutputModes: 'text/plain',
    },
    predicate: (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (e) =>
          e.keyword === 'type' &&
          e.instancePath === '/request/configuration/acceptedOutputModes',
      ),
  },
  {
    name: 'negative configuration.historyLength',
    input: {
      historyLength: -1,
    },
    predicate: (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (e) =>
          e.keyword === 'minimum' &&
          e.instancePath === '/request/configuration/historyLength',
      ),
  },
  {
    name: 'configuration.pushNotificationConfig without url',
    input: {
      pushNotificationConfig: {
        token: 'push-token',
      },
    },
    predicate: (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (e) =>
          e.keyword === 'required' &&
          e.instancePath === '/request/configuration/pushNotificationConfig' &&
          isRecord(e.params) &&
          e.params.missingProperty === 'url',
      ),
  },
  {
    name: 'configuration.pushNotificationConfig.authentication.schemes with invalid type',
    input: {
      pushNotificationConfig: {
        url: 'https://notify.example/hooks/123',
        authentication: {
          schemes: 'Bearer',
        },
      },
    },
    predicate: (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (e) =>
          e.keyword === 'type' &&
          e.instancePath ===
            '/request/configuration/pushNotificationConfig/authentication/schemes',
      ),
  },
] as const

for (const testCase of delegateConfigurationValidationCases) {
  test(`validateDelegateInput rejects ${testCase.name}`, () => {
    assert.throws(
      () =>
        validateDelegateInput({
          target: {
            baseUrl: 'http://peer.example',
          },
          request: {
            message: {
              kind: 'message',
              messageId: 'msg-config',
              role: 'user',
              parts: [{ kind: 'text', text: 'hello' }],
            },
            configuration: testCase.input,
          },
        }),
      testCase.predicate,
    )
  })
}

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

test('validateDelegateStreamInput rejects missing request.message', () => {
  assert.throws(
    () =>
      validateDelegateStreamInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        request: {
          timeoutMs: 1000,
        },
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (e) =>
          e.keyword === 'required' &&
          e.instancePath === '/request' &&
          isRecord(e.params) &&
          e.params.missingProperty === 'message',
      ),
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

test('validateStatusInput accepts request.taskHandle without an explicit target', () => {
  const out = validateStatusInput({
    request: {
      taskHandle: 'rah_status-1',
      historyLength: 2,
    },
  })

  assert.equal(out.target, undefined)
  assert.equal(out.request.taskHandle, 'rah_status-1')
  assert.equal(out.request.historyLength, 2)
})

test('validateWaitInput accepts nested request.taskId and applies backoff defaults', () => {
  const out = validateWaitInput({
    target: {
      baseUrl: 'http://peer.example',
      cardPath: '/agent-card.json',
    },
    request: {
      taskId: 'task-wait-1',
      waitTimeoutMs: 15000,
      historyLength: 3,
      timeoutMs: 700,
      serviceParameters: {
        'X-Trace-Id': 'trace-wait-1',
      },
    },
  })

  assert.equal(out.target.cardPath, '/agent-card.json')
  assert.equal(out.request.taskId, 'task-wait-1')
  assert.equal(out.request.waitTimeoutMs, 15000)
  assert.equal(out.request.historyLength, 3)
  assert.equal(out.request.timeoutMs, 700)
  assert.equal(out.request.serviceParameters?.['X-Trace-Id'], 'trace-wait-1')
  assert.equal(out.request.initialDelayMs, 250)
  assert.equal(out.request.maxDelayMs, 5000)
  assert.equal(out.request.backoffMultiplier, 2)
})

test('validateWaitInput accepts request.taskHandle without an explicit target', () => {
  const out = validateWaitInput({
    request: {
      taskHandle: 'rah_wait-1',
      waitTimeoutMs: 15000,
    },
  })

  assert.equal(out.target, undefined)
  assert.equal(out.request.taskHandle, 'rah_wait-1')
  assert.equal(out.request.waitTimeoutMs, 15000)
  assert.equal(out.request.initialDelayMs, 250)
})

test('validateWaitInput rejects missing request.taskId', () => {
  assert.throws(
    () =>
      validateWaitInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        request: {
          waitTimeoutMs: 15000,
        },
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (e) =>
          e.keyword === 'required' &&
          e.instancePath === '/request' &&
          isRecord(e.params) &&
          e.params.missingProperty === 'taskId',
      ),
  )
})

test('validateWaitInput rejects missing request.waitTimeoutMs', () => {
  assert.throws(
    () =>
      validateWaitInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        request: {
          taskId: 'task-wait-2',
        },
      }),
    (error: unknown) =>
      isValidationError(error) &&
      hasAjvError(
        error,
        (e) =>
          e.keyword === 'required' &&
          e.instancePath === '/request' &&
          isRecord(e.params) &&
          e.params.missingProperty === 'waitTimeoutMs',
      ),
  )
})

test('validateWaitInput rejects invalid backoff combinations', () => {
  assert.throws(
    () =>
      validateWaitInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        request: {
          taskId: 'task-wait-3',
          waitTimeoutMs: 15000,
          initialDelayMs: 1000,
          maxDelayMs: 500,
          backoffMultiplier: 0.5,
        },
      }),
    (error: unknown) => isValidationError(error),
  )
})

test('validateResubscribeInput enforces nested request.taskId contract', () => {
  const out = validateResubscribeInput({
    target: {
      baseUrl: 'http://peer.example',
      cardPath: '/agent-card.json',
    },
    request: {
      taskId: 'task-stream-1',
      timeoutMs: 750,
      serviceParameters: {
        'X-Trace-Id': 'trace-stream-2',
      },
    },
  })

  assert.equal(out.target.cardPath, '/agent-card.json')
  assert.equal(out.request.taskId, 'task-stream-1')
  assert.equal(out.request.timeoutMs, 750)
  assert.equal(out.request.serviceParameters?.['X-Trace-Id'], 'trace-stream-2')

  assert.throws(
    () =>
      validateResubscribeInput({
        target: {
          baseUrl: 'http://peer.example',
        },
        taskId: 'legacy-stream-1',
      }),
    (error: unknown) => isValidationError(error),
  )
})

test('validateResubscribeInput accepts request.taskHandle without an explicit target', () => {
  const out = validateResubscribeInput({
    request: {
      taskHandle: 'rah_resubscribe-1',
      timeoutMs: 750,
    },
  })

  assert.equal(out.target, undefined)
  assert.equal(out.request.taskHandle, 'rah_resubscribe-1')
  assert.equal(out.request.timeoutMs, 750)
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

test('validateCancelInput accepts request.taskHandle without an explicit target', () => {
  const out = validateCancelInput({
    request: {
      taskHandle: 'rah_cancel-1',
      timeoutMs: 1200,
    },
  })

  assert.equal(out.target, undefined)
  assert.equal(out.request.taskHandle, 'rah_cancel-1')
  assert.equal(out.request.timeoutMs, 1200)
})

test('follow-up validators reject requests with no resolvable task context', () => {
  const validators = [
    () =>
      validateStatusInput({
        request: {},
      }),
    () =>
      validateWaitInput({
        request: {
          waitTimeoutMs: 1500,
        },
      }),
    () =>
      validateResubscribeInput({
        request: {},
      }),
    () =>
      validateCancelInput({
        request: {},
      }),
  ]

  for (const validate of validators) {
    assert.throws(() => validate(), (error: unknown) => isValidationError(error))
  }
})

test('TOOL_DEFINITIONS exposes all six outbound A2A tool schemas', () => {
  assert.deepEqual(Object.keys(TOOL_DEFINITIONS).sort(), [
    'a2a_delegate',
    'a2a_delegate_stream',
    'a2a_task_cancel',
    'a2a_task_resubscribe',
    'a2a_task_status',
    'a2a_task_wait',
  ])

  assert.equal(TOOL_DEFINITIONS.a2a_delegate_stream.name, 'a2a_delegate_stream')
  assert.equal(
    TOOL_DEFINITIONS.a2a_task_resubscribe.name,
    'a2a_task_resubscribe',
  )
  assert.equal(TOOL_DEFINITIONS.a2a_task_wait.name, 'a2a_task_wait')
  assert.deepEqual(
    TOOL_DEFINITIONS.a2a_delegate_stream.parameters,
    TOOL_DEFINITIONS.a2a_delegate.parameters,
  )
})
