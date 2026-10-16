import { expect, test } from 'bun:test'
import { addBlocked, dismissBlocked, isStartable, normalizeBlocked, patchBlocked } from './blocked-core'
import type { BlockedCommand } from '../types'

const item = (id: string, over: Partial<BlockedCommand> = {}): BlockedCommand => ({ id, command: `echo ${id}`, reason: 'denied', at: 1, status: 'waiting', openedPane: false, ...over })

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

test('only a waiting command can be approved', () => {
  const l = [item('a'), item('b', { status: 'running' })]
  expect(isStartable(l, 'a')).toBe(true)
  expect(isStartable(l, 'b')).toBe(false)
  expect(isStartable(l, 'zz')).toBe(false)
})

test('normalizeBlocked drops unreadable entries', () => {
  expect(normalizeBlocked('x')).toEqual([])
  expect(normalizeBlocked([item('a'), { nope: 1 }, null])).toEqual([item('a')])
})
