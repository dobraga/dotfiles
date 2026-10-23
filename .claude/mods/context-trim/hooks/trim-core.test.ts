import { expect, test } from 'bun:test'
import { applyDrop, digest, parseDrop, tokensOf, type Msg } from './trim-core'

const say = (role: Msg['role'], text: string): Msg => ({ role, text, toolUses: [] })
const use = (id: string): Msg => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, input: { cmd: 'ls' } }] })
const result = (id: string, text: string): Msg => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }] })

test('tokensOf counts text, tool input and tool results at 4 characters a token', () => {
  expect(tokensOf(say('user', 'abcdefgh'))).toBe(2)
  expect(tokensOf(result('a', 'x'.repeat(40)))).toBe(10)
  expect(tokensOf(use('a'))).toBeGreaterThan(0)
})

test('digest is one tab-separated line per message with a cut, flattened preview', () => {
  const lines = digest([say('user', 'hello\n   world'), result('a', 'y'.repeat(500))], 10).split('\n')
  expect(lines[0]).toBe('0\tuser\t~4t\thello worl')
  expect(lines[1]?.split('\t')[3]).toBe('y'.repeat(10))
})

test('parseDrop reads plain and fenced JSON, dedupes, and ignores out-of-range or non-integer entries', () => {
  expect(parseDrop('{"drop":[3,1,3,99,-1,2.5,"4"]}', 10)).toEqual([1, 3])
  expect(parseDrop('Sure:\n```json\n{"drop":[2]}\n```', 10)).toEqual([2])
})

test('parseDrop returns null for anything that is not a drop list', () => {
  expect(parseDrop('no json here', 10)).toBeNull()
  expect(parseDrop('{"drop":"all"}', 10)).toBeNull()
  expect(parseDrop('{"drop":[1,}', 10)).toBeNull()
})

test('applyDrop never drops the first message or the last keepRecent', () => {
  const msgs = [say('user', 'task'), say('assistant', 'a'), say('user', 'b'), say('assistant', 'c'), say('user', 'd')]
  const out = applyDrop(msgs, [0, 1, 3, 4], 2)
  expect(out.dropped).toEqual([1])
  expect(out.kept.map((m) => m.text)).toEqual(['task', 'b', 'c', 'd'])
})

test('applyDrop drops a tool_use and its tool_result together, from either side', () => {
  const msgs = [say('user', 'task'), use('a'), result('a', 'z'.repeat(400)), say('assistant', 'ok'), say('user', 'next'), say('assistant', 'end')]
  expect(applyDrop(msgs, [2], 1).dropped).toEqual([1, 2])
  expect(applyDrop(msgs, [1], 1).dropped).toEqual([1, 2])
  expect(applyDrop(msgs, [1], 1).saved).toBe(tokensOf(msgs[1] as Msg) + tokensOf(msgs[2] as Msg))
})

test('applyDrop keeps a pair whole when one half is protected', () => {
  const msgs = [say('user', 'task'), say('assistant', 'x'), use('a'), result('a', 'out')]
  expect(applyDrop(msgs, [2], 1).dropped).toEqual([])
})
