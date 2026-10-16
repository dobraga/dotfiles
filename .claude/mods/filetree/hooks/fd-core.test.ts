import { expect, test } from 'bun:test'
import { endTask, recordFiles, startTask, taskEnds } from './fd-core'

test('taskEnds reads id and status from each notification', () => {
  const text = '<task-notification><task-id>a1</task-id><status>completed</status></task-notification> x <task-notification><task-id>b2</task-id><status>killed</status></task-notification><task-notification><status>failed</status></task-notification>'
  expect(taskEnds(text)).toEqual([['a1', 'completed'], ['b2', 'killed']])
})

test('startTask dedupes by id and redacts the label', () => {
  let t = startTask([], { id: 'a', kind: 'shell', label: 'curl -H "Authorization: Bearer sk-ant-abcdefghijklmnop"', at: 1 })
  t = startTask(t, { id: 'a', kind: 'shell', label: 'dup', at: 2 })
  expect(t).toHaveLength(1)
  expect(t[0]?.label).not.toContain('sk-ant-abcdefghijklmnop')
})

test('endTask ends only a running task and ignores unknown ids', () => {
  let t = startTask([], { id: 'a', kind: 'monitor', label: 'w', at: 1 })
  t = endTask(t, 'a', 'completed', 5)
  expect(t[0]).toMatchObject({ endedAt: 5, status: 'completed' })
  expect(endTask(t, 'a', 'killed', 9)).toBe(t)
  expect(endTask(t, 'zz', 'killed', 9)).toBe(t)
})

test('trim keeps running tasks when the list overflows', () => {
  let t = startTask([], { id: 'run', kind: 'monitor', label: 'm', at: 0 })
  for (let i = 0; i < 30; i++) t = endTask(startTask(t, { id: `x${i}`, kind: 'shell', label: 'x', at: i }), `x${i}`, 'completed', i)
  expect(t).toHaveLength(20)
  expect(t.some(x => x.id === 'run' && x.endedAt === null)).toBe(true)
})

import { normalize } from './fd-core'

test('normalize fills missing keys and drops values of the wrong type', () => {
  const def = { list: [] as string[], n: 0, name: '', any: null as string | null }
  expect(normalize(def, { n: 3 })).toEqual({ list: [], n: 3, name: '', any: null })
  expect(normalize(def, { list: 'x', n: '3', any: 'ok' })).toEqual({ list: [], n: 0, name: '', any: 'ok' })
  expect(normalize(def, 'garbage')).toBe(def)
  expect(normalize(def, { extra: 1 })).toMatchObject({ extra: 1 })
})

test('recordFiles replaces an earlier event for the same path and kind, keeps order, and caps the list', () => {
  const ev = (path: string, kind: 'read' | 'write' | 'git', at: number) => ({ path, kind, verb: '', at })
  let l = recordFiles([], [ev('a', 'write', 1), ev('b', 'read', 2)])
  l = recordFiles(l, [ev('a', 'write', 3)])
  expect(l.map(e => `${e.kind}:${e.path}@${e.at}`)).toEqual(['read:b@2', 'write:a@3'])
  expect(recordFiles(l, [ev('a', 'read', 4)]).length).toBe(3)
  expect(recordFiles(l, [])).toBe(l)
  let many = [] as ReturnType<typeof ev>[]
  for (let i = 0; i < 80; i++) many = recordFiles(many, [ev(`f${i}`, 'write', i)])
  expect(many).toHaveLength(50)
  expect(many.at(-1)?.path).toBe('f79')
})
