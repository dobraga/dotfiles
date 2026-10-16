import { expect, test } from 'bun:test'
import { gitActions, readOnly } from './git'

test('readOnly accepts inspection commands only', () => {
  expect(readOnly('ls -la')).toBe(true)
  expect(readOnly('rm -rf build')).toBe(false)
})

test('gitActions finds commit in a chained command', () => {
  expect(gitActions('git add . && git commit -m x').some(a => a.verb === 'commit')).toBe(true)
  expect(gitActions('echo hi')).toEqual([])
})
