import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PLUGIN_ID } from '../dist/constants.js'

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('expected object')
  }

  return value as JsonRecord
}

function unscopedPackageName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('expected package name')
  }

  const segments = value.split('/')
  return segments.at(-1) ?? value
}

test('package name leaf stays aligned with the plugin id', () => {
  const rawPackage = readFileSync(
    new URL('../package.json', import.meta.url),
    'utf8',
  )
  const rawManifest = readFileSync(
    new URL('../openclaw.plugin.json', import.meta.url),
    'utf8',
  )

  const packageJson = asRecord(JSON.parse(rawPackage))
  const manifest = asRecord(JSON.parse(rawManifest))
  const packageIdHint = unscopedPackageName(packageJson.name)

  assert.equal(packageIdHint, manifest.id)
  assert.equal(packageIdHint, PLUGIN_ID)
  assert.equal(packageJson.version, manifest.version)
})
