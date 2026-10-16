// The mod's `userConfig` values, parsed in one place: an unknown or mistyped value takes the default.
export type ViewerLayout = 'auto' | 'wide' | 'narrow'

export type Options = {
  glyphs: string
  showReads: boolean
  showWrites: boolean
  accordion: boolean
  pinRoot: boolean
  showBranch: boolean
  sizeDefault: boolean
  viewerLayout: ViewerLayout
  approval: boolean
}

type Raw = Readonly<Record<string, unknown>> | undefined

const pick = <T extends string>(raw: Raw, key: string, allowed: readonly T[], fallback: T): T => {
  const v = raw?.[key]
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

export const parseOptions = (raw: Raw): Options => {
  const activity = pick(raw, 'activity', ['reads and writes', 'writes', 'reads', 'none'], 'reads and writes')
  return {
    glyphs: pick(raw, 'glyphs', ['auto', 'nerd', 'plain'], 'auto'),
    showReads: activity.includes('reads'),
    showWrites: activity.includes('writes'),
    accordion: pick(raw, 'accordion', ['on', 'off'], 'on') === 'on',
    pinRoot: pick(raw, 'root', ['launch', 'cwd'], 'launch') === 'launch',
    showBranch: pick(raw, 'branch', ['on', 'off'], 'off') === 'on',
    sizeDefault: pick(raw, 'column', ['date', 'size'], 'date') === 'size',
    viewerLayout: pick(raw, 'viewerLayout', ['auto', 'wide', 'narrow'], 'auto'),
    approval: pick(raw, 'approval', ['on', 'off'], 'on') === 'on',
  }
}

/** Header buttons collapse to their hotkeys on a narrow viewer. */
export const isCompact = (layout: ViewerLayout, columns: number): boolean => layout === 'narrow' || (layout === 'auto' && columns < 60)
