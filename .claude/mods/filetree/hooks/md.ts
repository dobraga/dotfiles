// Pure markdown helpers for the preview: nothing here touches `$`, so each is tested directly.
// `scroll` blocks (mermaid, code fences, tables) slide sideways; `markdown` blocks keep the engine's own wrapping
export type Segment = { kind: 'markdown' | 'mermaid' | 'code' | 'table'; text: string; language?: string }

export const splitBlocks = (text: string): Segment[] => {
  const segments: Segment[] = []
  let prose: string[] = []
  const flush = (): void => {
    if (prose.length > 0) segments.push({ kind: 'markdown', text: prose.join('\n') })
    prose = []
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fence = /^\s*```\s*([\w+-]*)/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) body.push(lines[i++] ?? '')
      flush()
      const language = fence[1] ?? ''
      segments.push(language === 'mermaid' ? { kind: 'mermaid', text: body.join('\n') } : { kind: 'code', text: body.join('\n'), language })
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? '')) rows.push(lines[i++] ?? '')
      i--
      flush()
      segments.push({ kind: 'table', text: rows.join('\n') })
    } else prose.push(line)
  }
  flush()

  return segments
}

// Markdown table -> box-drawing grid; column alignment comes from the `:---:` row, inline markup is stripped
export const formatTable = (text: string): string => {
  const cells = (row: string): string[] =>
    row
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(c => c.trim().replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2').replace(/`([^`]+)`/g, '$1'))
  const rows = text.split('\n').map(cells)
  const rule = rows[1]
  const hasRule = rule !== undefined && rule.every(c => /^:?-{1,}:?$/.test(c))
  const align = (hasRule ? rule : []).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'))
  const body = hasRule ? [rows[0] ?? [], ...rows.slice(2)] : rows
  const count = body.reduce((n, r) => Math.max(n, r.length), 0)
  const widths = Array.from({ length: count }, (_, c) => body.reduce((n, r) => Math.max(n, (r[c] ?? '').length), 1))
  const pad = (value: string, c: number): string => {
    const room = (widths[c] ?? 1) - value.length
    const how = align[c] ?? 'left'
    if (how === 'right') return ' '.repeat(room) + value
    if (how === 'center') return ' '.repeat(Math.floor(room / 2)) + value + ' '.repeat(room - Math.floor(room / 2))
    return value + ' '.repeat(room)
  }
  const line = (l: string, m: string, r: string): string => l + widths.map(w => '─'.repeat(w + 2)).join(m) + r
  const row = (r: string[]): string => '│ ' + widths.map((_, c) => pad(r[c] ?? '', c)).join(' │ ') + ' │'
  const out = [line('┌', '┬', '┐')]
  body.forEach((r, i) => {
    out.push(row(r))
    if (i === 0 && body.length > 1) out.push(line('├', '┼', '┤'))
  })
  out.push(line('└', '┴', '┘'))

  return out.join('\n')
}
