// The mod's `userConfig` values, parsed in one place: an unknown or mistyped value takes the default.
export type Options = { step: number; keepRecent: number; model: string; enabled: boolean }

type Raw = Readonly<Record<string, unknown>> | undefined

const count = (raw: Raw, key: string, allowed: readonly number[], fallback: number): number => {
  const n = Number(raw?.[key])
  return allowed.includes(n) ? n : fallback
}

export const parseOptions = (raw: Raw): Options => {
  const model = raw?.model
  return {
    step: count(raw, 'step', [5, 10, 15, 20, 25], 10),
    keepRecent: count(raw, 'keepRecent', [4, 8, 12, 16], 8),
    model: typeof model === 'string' && model.trim() ? model.trim() : 'claude-haiku-5-5',
    enabled: raw?.enabled !== 'off',
  }
}
