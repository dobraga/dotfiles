import { expect, test } from 'bun:test'
import { parseOptions } from './config'

test('defaults fill an empty config', () => {
  expect(parseOptions(undefined)).toEqual({ step: 10, keepRecent: 8, model: 'claude-haiku-5-5', enabled: true })
})

test('a value outside the allowed set takes the default', () => {
  expect(parseOptions({ step: '7', keepRecent: 'x', model: '  ', enabled: 'off' })).toEqual({ step: 10, keepRecent: 8, model: 'claude-haiku-5-5', enabled: false })
  expect(parseOptions({ step: '5', keepRecent: '12', model: 'haiku' })).toMatchObject({ step: 5, keepRecent: 12, model: 'haiku' })
})
