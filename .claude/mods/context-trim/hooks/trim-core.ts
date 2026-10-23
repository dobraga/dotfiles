// `$`-free core of context-trim: what the model sees, how its answer is read, and which messages may go.

export type Msg = {
  role: 'user' | 'assistant'
  text: string
  toolUses: { tool_use_id: string; input?: unknown }[]
  toolResults?: { tool_use_id: string; text: string }[]
}

export type Trimmed<T> = { kept: T[]; dropped: number[]; saved: number }

/** Rough token estimate (4 characters a token) over everything a message carries. */
export function tokensOf(m: Msg): number {
  const chars =
    m.text.length +
    m.toolUses.reduce((n, u) => n + JSON.stringify(u.input ?? '').length, 0) +
    (m.toolResults ?? []).reduce((n, r) => n + r.text.length, 0)
  return Math.ceil(chars / 4)
}

/** One line per message, `index<TAB>role<TAB>~tokens<TAB>preview`: all the model needs to pick what to drop. */
export function digest(messages: readonly Msg[], previewChars = 200): string {
  return messages
    .map((m, i) => {
      const body = m.text || m.toolResults?.map((r) => r.text).join(' ') || m.toolUses.map((u) => JSON.stringify(u.input ?? '')).join(' ')
      const preview = body.replace(/\s+/g, ' ').trim().slice(0, previewChars)
      return `${i}\t${m.role}\t~${tokensOf(m)}t\t${preview}`
    })
    .join('\n')
}

/** Reads `{ "drop": [index, ...] }` from the model's answer, fenced or not; null when it is not that. */
export function parseDrop(raw: string, count: number): number[] | null {
  const body = raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const drop = (JSON.parse(body.slice(start, end + 1)) as { drop?: unknown }).drop
    if (!Array.isArray(drop)) return null
    const valid = drop.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < count)
    return [...new Set(valid)].sort((a, b) => a - b)
  } catch {
    return null
  }
}

/** Indices joined by a tool_use / tool_result pair, grouped so a pair is dropped or kept whole. */
function pairGroups(messages: readonly Msg[]): number[][] {
  const parent = messages.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)))
  const useAt = new Map<string, number>()
  messages.forEach((m, i) => m.toolUses.forEach((u) => useAt.set(u.tool_use_id, i)))
  messages.forEach((m, i) =>
    m.toolResults?.forEach((r) => {
      const at = useAt.get(r.tool_use_id)
      if (at !== undefined) parent[find(i)] = find(at)
    }),
  )
  const groups = new Map<number, number[]>()
  messages.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]))
  return [...groups.values()]
}

/**
 * Drops the requested messages, with two guards: the first message and the last `keepRecent` never go,
 * and a tool_use goes with its tool_result or not at all (a group touching a protected message stays whole).
 */
export function applyDrop<T extends Msg>(messages: readonly T[], drop: readonly number[], keepRecent: number): Trimmed<T> {
  const asked = new Set(drop)
  const protectedFrom = messages.length - keepRecent
  const gone = new Set<number>()
  for (const group of pairGroups(messages)) {
    const wanted = group.some((i) => asked.has(i))
    const safe = group.every((i) => i > 0 && i < protectedFrom)
    if (wanted && safe) group.forEach((i) => gone.add(i))
  }
  const dropped = [...gone].sort((a, b) => a - b)
  return {
    kept: messages.filter((_, i) => !gone.has(i)),
    dropped,
    saved: dropped.reduce((n, i) => n + tokensOf(messages[i] as Msg), 0),
  }
}
