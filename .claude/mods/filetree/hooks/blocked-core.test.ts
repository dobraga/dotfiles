import { expect, test } from 'bun:test'
import { addBlocked, clipOutput, dismissBlocked, isStartable, normalizeBlocked, patchBlocked, promptText } from './blocked-core'
import type { BlockedCommand } from '../types'

const item = (id: string, over: Partial<BlockedCommand> = {}): BlockedCommand => ({ id, command: `echo ${id}`, reason: 'denied', at: 1, status: 'waiting', output: '', exitCode: null, openedPane: false, ...over })

test('addBlocked ignores a repeated id and keeps the newest ten', () => {
  let l = addBlocked([], item('a'))
  expect(addBlocked(l, item('a'))).toBe(l)
  for (let i = 0; i < 15; i++) l = addBlocked(l, item(`x${i}`))
  expect(l).toHaveLength(10)
  expect(l.at(-1)?.id).toBe('x14')
})

test('patchBlocked and dismissBlocked touch only a held id', () => {
  const l = [item('a'), item('b')]
  expect(patchBlocked(l, 'a', { status: 'running' })[0]?.status).toBe('running')
  expect(patchBlocked(l, 'zz', { status: 'running' })).toBe(l)
  expect(dismissBlocked(l, 'a').map(b => b.id)).toEqual(['b'])
  expect(dismissBlocked(l, 'zz')).toBe(l)
})

test('only a waiting command is startable', () => {
  const l = [item('a'), item('b', { status: 'running' }), item('c', { status: 'done' })]
  expect(isStartable(l, 'a')).toBe(true)
  expect(isStartable(l, 'b')).toBe(false)
  expect(isStartable(l, 'c')).toBe(false)
  expect(isStartable(l, 'zz')).toBe(false)
})

test('clipOutput keeps the tail and marks a cut', () => {
  expect(clipOutput('a\nb')).toBe('a\nb')
  const long = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')
  const out = clipOutput(long, 3)
  expect(out).toBe('… l27\nl28\nl29')
  expect(clipOutput('x'.repeat(5000), 14, 100)).toHaveLength(102)
})

test('promptText states what ran and how it ended', () => {
  const t = promptText(item('a', { status: 'done', output: 'hi', exitCode: 0 }))
  expect(t).toContain('$ echo a')
  expect(t).toContain('hi')
  expect(t).toContain('(exit 0)')
  expect(promptText(item('b', { exitCode: 1 }))).toContain('(no output)')
})

test('normalizeBlocked drops unreadable entries', () => {
  expect(normalizeBlocked('x')).toEqual([])
  expect(normalizeBlocked([item('a'), { nope: 1 }, null])).toEqual([item('a')])
})
