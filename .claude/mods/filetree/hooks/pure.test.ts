import { expect, test } from 'bun:test'
import { cacheName, clean, clock, failAll, faint, openDirs, proven, rootOfDisk, shortenHome } from './pure'
import type { FileNode } from '../types'

const node = (id: string, kind: FileNode['kind'], loaded = true): FileNode => ({ id, parent: '', name: id, kind, hidden: false, mtime: 0, size: 0, loaded })

test('clean drops undefined keys in place', () => {
  const segs = clean([{ t: 'a', c: undefined, b: true }])
  expect(Object.keys(segs[0] ?? {})).toEqual(['t', 'b'])
})

test('faint pulls a colour toward the dark background', () => {
  expect(faint('#ffffff')).toBe('#676767')
  expect(faint('#262626')).toBe('#262626')
})

test('openDirs lists only loaded directories that are expanded', () => {
  const t = { expanded: ['/r/a', '/r/b'], nodes: [node('/r/a', 'dir'), node('/r/b', 'dir', false), node('/r/c', 'dir'), node('/r/a/f', 'file')] } as never
  expect(openDirs(t)).toEqual(['/r/a'])
})

test('failAll and proven read the actions of a pending call', () => {
  const actions = [{ verb: 'commit' }, { verb: 'push' }] as never[]
  const p = { actions, ids: [], command: '', head: '' }
  const failed = failAll(p)
  expect(failed.map(o => o.state)).toEqual(['failed', 'failed'])
  expect(failed[0]?.label).toBe('commit failed')
  expect(proven(null, [])).toEqual([])
  expect(proven(p, [{ state: 'done', label: '', detail: '' }, { state: 'failed', label: '', detail: '' }]).map(a => (a as { verb: string }).verb)).toEqual(['commit'])
})

test('rootOfDisk accepts / and drive roots only', () => {
  expect(rootOfDisk('/')).toBe(true)
  expect(rootOfDisk('C:/')).toBe(true)
  expect(rootOfDisk('/home')).toBe(false)
})

test('shortenHome replaces the home prefix and leaves other paths', () => {
  expect(shortenHome('/home/u/src/x', '/home/u')).toBe('~/src/x')
  expect(shortenHome('/etc/hosts', '/home/u')).toBe('/etc/hosts')
  expect(shortenHome('/home/u/x', '')).toBe('/home/u/x')
})

test('cacheName and clock', () => {
  expect(cacheName('/a b/c.png')).toBe('_a_b_c_png')
  expect(cacheName('x'.repeat(300))).toHaveLength(120)
  expect(clock(65)).toBe('1:05')
  expect(clock(9.9)).toBe('0:09')
})
