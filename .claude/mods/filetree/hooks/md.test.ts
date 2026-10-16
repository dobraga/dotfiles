import { expect, test } from 'bun:test'
import { formatTable, splitBlocks } from './md'

test('splitBlocks separates prose, fences, mermaid and tables', () => {
  const text = ['# T', 'para', '```ts', 'const a = 1', '```', '| a | b |', '|---|---|', '| 1 | 2 |', '```mermaid', 'graph TD', '```', 'end'].join('\n')
  const segs = splitBlocks(text)
  expect(segs.map(s => s.kind)).toEqual(['markdown', 'code', 'table', 'mermaid', 'markdown'])
  expect(segs[1]).toEqual({ kind: 'code', text: 'const a = 1', language: 'ts' })
  expect(segs[2]?.text).toBe('| a | b |\n|---|---|\n| 1 | 2 |')
  expect(segs[4]?.text).toBe('end')
})

test('splitBlocks keeps an unterminated fence as code to the end', () => {
  const segs = splitBlocks('```py\nx = 1')
  expect(segs).toEqual([{ kind: 'code', text: 'x = 1', language: 'py' }])
})

test('formatTable draws a grid, strips markup and honours alignment', () => {
  const out = formatTable('| Name | **N** |\n|:--|--:|\n| `a` | 10 |')
  expect(out.split('\n')).toEqual(['┌──────┬────┐', '│ Name │  N │', '├──────┼────┤', '│ a    │ 10 │', '└──────┴────┘'])
})

test('formatTable without a rule row treats every row as body', () => {
  const out = formatTable('| a |\n| b |')
  expect(out.split('\n')).toHaveLength(5)
})
