import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const manifestPath = new URL('../openclaw.plugin.json', import.meta.url)
const skillPath = new URL('../skills/remote-agent/SKILL.md', import.meta.url)
const readmePath = new URL('../README.md', import.meta.url)

test('manifest declares skills field', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.deepEqual(manifest.skills, ['./skills'])
})

test('SKILL.md exists at expected path', () => {
  assert.ok(existsSync(skillPath))
})

test('SKILL.md has valid frontmatter', () => {
  const content = readFileSync(skillPath, 'utf8')
  assert.ok(content.startsWith('---\n'), 'must start with frontmatter delimiter')
  const closingIndex = content.indexOf('\n---\n', 4)
  assert.ok(closingIndex > 0, 'must have closing frontmatter delimiter')
  const frontmatter = content.slice(4, closingIndex)
  assert.ok(frontmatter.includes('name:'), 'frontmatter must include name')
  assert.ok(
    frontmatter.includes('description:'),
    'frontmatter must include description',
  )
})

test('SKILL.md references remote_agent tool', () => {
  const content = readFileSync(skillPath, 'utf8')
  assert.ok(content.includes('remote_agent'))
})

test('SKILL.md documents all five actions', () => {
  const content = readFileSync(skillPath, 'utf8')
  for (const action of ['list_targets', 'send', 'watch', 'status', 'cancel']) {
    assert.ok(content.includes(action), `must document action: ${action}`)
  }
})

test('SKILL.md teaches target_alias and task_handle preference', () => {
  const content = readFileSync(skillPath, 'utf8')
  assert.ok(content.includes('target_alias'))
  assert.ok(content.includes('task_handle'))
})

test('SKILL.md documents conditional task creation and strict durable mode', () => {
  const content = readFileSync(skillPath, 'utf8')
  assert.ok(content.includes('`task_requirement`'))
  assert.ok(content.includes('`follow_updates=true` means'))
  assert.ok(content.includes('`task_requirement="required"`'))
  assert.ok(content.includes('`task_handle` is returned only when the peer actually created a task'))
})

test('SKILL.md documents task_id versus reference_task_ids', () => {
  const content = readFileSync(skillPath, 'utf8')
  assert.ok(content.includes('`reference_task_ids`'))
  assert.ok(content.includes('`task_id` continues an existing task'))
  assert.ok(
    content.includes(
      '`reference_task_ids` references prior tasks without continuing them',
    ),
  )
})

test('SKILL.md documents summary.continuation task vs conversation branching', () => {
  const content = readFileSync(skillPath, 'utf8')
  assert.ok(content.includes('`summary.continuation.task`'))
  assert.ok(content.includes('`summary.continuation.conversation`'))
  assert.ok(
    content.includes(
      'Branch on `summary.continuation.task` vs `summary.continuation.conversation` before choosing the next action.',
    ),
  )
})

test('SKILL.md forbids inferring task continuity from conversation-only results', () => {
  const content = readFileSync(skillPath, 'utf8')
  assert.ok(
    content.includes(
      'Never infer or synthesize `summary.continuation.task` from `summary.continuation.conversation`',
    ),
  )
  assert.ok(
    content.includes(
      'Do not call `watch`, `status`, or `cancel` from a result that has only `summary.continuation.conversation`.',
    ),
  )
})

test('SKILL.md documents fail-fast behavior for non-trackable continuations', () => {
  const content = readFileSync(skillPath, 'utf8')
  assert.ok(
    content.includes(
      'If lifecycle tracking is required, fail fast when the peer returns only `summary.continuation.conversation`.',
    ),
  )
  assert.ok(
    content.includes(
      'If the result includes only `summary.continuation.conversation`, there is no task lifecycle to poll, watch, or cancel.',
    ),
  )
})

test('README documents the nested continuation contract and migration rule', () => {
  const content = readFileSync(readmePath, 'utf8')
  assert.ok(content.includes('`summary.continuation.task`'))
  assert.ok(content.includes('`summary.continuation.conversation`'))
  assert.ok(content.includes('`response_kind`'))
  assert.ok(content.includes('`task_requirement="required"`'))
  assert.ok(content.includes('`reference_task_ids`'))
  assert.ok(content.includes('Do not poll from conversation continuity.'))
  assert.ok(
    content.includes(
      'The old flat `summary.task_handle`, `summary.task_id`, `summary.context_id`, `summary.status`, and `summary.can_watch` fields are removed.',
    ),
  )
})

test('SKILL.md requires both outbound enable flags', () => {
  const content = readFileSync(skillPath, 'utf8')
  const closingIndex = content.indexOf('\n---\n', 4)
  assert.ok(closingIndex > 0, 'must have closing frontmatter delimiter')

  const frontmatter = content.slice(4, closingIndex)
  const metadataLine = frontmatter
    .split('\n')
    .find((line) => line.startsWith('metadata: '))

  assert.ok(metadataLine, 'frontmatter must include metadata')

  const metadata = JSON.parse(metadataLine.slice('metadata: '.length))

  assert.deepEqual(metadata.openclaw.requires.config, [
    'plugins.entries.openclaw-a2a-outbound.enabled',
    'plugins.entries.openclaw-a2a-outbound.config.enabled',
  ])
})
