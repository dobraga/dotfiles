import { expect, test } from 'bun:test'
import { isCompact, parseOptions } from './config'

test('defaults apply when options are missing or mistyped', () => {
  const d = parseOptions(undefined)
  expect(d).toMatchObject({ glyphs: 'auto', showReads: true, showWrites: true, accordion: true, pinRoot: true, showBranch: false, sizeDefault: false, viewerLayout: 'auto', approval: true })
  expect(parseOptions({ glyphs: 3, accordion: {}, activity: 'bogus', viewerLayout: 'huge' })).toEqual(d)
})

test('valid values are honoured', () => {
  const o = parseOptions({ activity: 'writes', accordion: 'off', root: 'cwd', branch: 'on', column: 'size', viewerLayout: 'narrow' })
  expect(o).toMatchObject({ showReads: false, showWrites: true, accordion: false, pinRoot: false, showBranch: true, sizeDefault: true, viewerLayout: 'narrow' })
  expect(parseOptions({ approval: 'off' }).approval).toBe(false)
  expect(parseOptions({ activity: 'none' })).toMatchObject({ showReads: false, showWrites: false })
})

test('isCompact follows the layout and the width', () => {
  expect(isCompact('auto', 59)).toBe(true)
  expect(isCompact('auto', 60)).toBe(false)
  expect(isCompact('wide', 10)).toBe(false)
  expect(isCompact('narrow', 200)).toBe(true)
})
