import type { EngineInterface } from 'claude-code'

// delta (https://github.com/dandavison/delta) draws the git diff: syntax colors, word-level highlights, line numbers.
// The mod installs it itself (prebuilt release into ~/.local/bin) and falls back to the plain diff while it is missing.
const VERSION = '0.18.2'

export type Span = { t: string; c?: string; bg?: string; b?: boolean; i?: boolean; s?: boolean }

const ANSI = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]/g

const BASIC = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5']
const BRIGHT = ['#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff']

const hex = (n: number): string => n.toString(16).padStart(2, '0')

// xterm 256-color index -> hex
const palette = (n: number): string => {
  if (n < 8) return BASIC[n] ?? '#000000'
  if (n < 16) return BRIGHT[n - 8] ?? '#ffffff'
  if (n >= 232) {
    const g = 8 + (n - 232) * 10

    return `#${hex(g)}${hex(g)}${hex(g)}`
  }
  const i = n - 16
  const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40)

  return `#${hex(level(Math.floor(i / 36)))}${hex(level(Math.floor(i / 6) % 6))}${hex(level(i % 6))}`
}

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

// One line of SGR-colored text -> styled spans. Only color, bold, italic and strikethrough are kept; other escapes are dropped.
export function parseAnsi(line: string): Span[] {
  const spans: Span[] = []
  let style: Omit<Span, 't'> = {}
  let last = 0

  const push = (text: string) => {
    if (text !== '') spans.push({ t: text, ...style })
  }

  for (const m of line.matchAll(ANSI)) {
    push(line.slice(last, m.index))
    last = (m.index ?? 0) + m[0].length
    if (m[1] === undefined) continue

    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number)
    for (let k = 0; k < codes.length; k++) {
      const code = codes[k] ?? 0
      if (code === 0) style = {}
      else if (code === 1) style = { ...style, b: true }
      else if (code === 3) style = { ...style, i: true }
      else if (code === 9) style = { ...style, s: true }
      else if (code === 22) style = { ...style, b: undefined }
      else if (code === 23) style = { ...style, i: undefined }
      else if (code === 29) style = { ...style, s: undefined }
      else if (code >= 30 && code <= 37) style = { ...style, c: BASIC[code - 30] }
      else if (code >= 90 && code <= 97) style = { ...style, c: BRIGHT[code - 90] }
      else if (code >= 40 && code <= 47) style = { ...style, bg: BASIC[code - 40] }
      else if (code >= 100 && code <= 107) style = { ...style, bg: BRIGHT[code - 100] }
      else if (code === 39) style = { ...style, c: undefined }
      else if (code === 49) style = { ...style, bg: undefined }
      else if (code === 38 || code === 48) {
        const key = code === 38 ? 'c' : 'bg'
        if (codes[k + 1] === 2) {
          style = { ...style, [key]: `#${hex(codes[k + 2] ?? 0)}${hex(codes[k + 3] ?? 0)}${hex(codes[k + 4] ?? 0)}` }
          k += 4
        } else if (codes[k + 1] === 5) {
          style = { ...style, [key]: palette(codes[k + 2] ?? 0) }
          k += 2
        }
      }
    }
  }
  push(line.slice(last))

  return spans
}

// Drop the first `offset` visible characters (horizontal scroll)
export function sliceSpans(spans: Span[], offset: number): Span[] {
  if (offset <= 0) return spans
  let skip = offset
  const out: Span[] = []
  for (const s of spans) {
    if (skip >= s.t.length) skip -= s.t.length
    else {
      out.push(skip > 0 ? { ...s, t: s.t.slice(skip) } : s)
      skip = 0
    }
  }

  return out
}

const BIN = (home: string): string => `${home}/.local/bin`

let ready: Promise<string | null> | null = null

// Path of a working delta binary, installing it first when missing; null when it cannot be had. Runs the install once per session.
export function ensureDelta($: EngineInterface, home: string): Promise<string | null> {
  ready ??= (async () => {
    const found = await $.process.run(['sh', '-c', `command -v delta || { [ -x "${BIN(home)}/delta" ] && echo "${BIN(home)}/delta"; }`], { timeoutMs: 5000 }).catch(() => null)
    const path = found?.stdout.trim().split('\n')[0]
    if (found?.exitCode === 0 && path) return path

    const os = (await $.process.run(['uname', '-s'], { timeoutMs: 5000 })).stdout.trim()
    const arch = (await $.process.run(['uname', '-m'], { timeoutMs: 5000 })).stdout.trim()
    const cpu = arch === 'arm64' || arch === 'aarch64' ? 'aarch64' : 'x86_64'
    const target = os === 'Darwin' ? `${cpu}-apple-darwin` : os === 'Linux' ? `${cpu}-unknown-linux-gnu` : ''
    if (!target) return null

    const dir = `delta-${VERSION}-${target}`
    const url = `https://github.com/dandavison/delta/releases/download/${VERSION}/${dir}.tar.gz`
    const script = `set -e; mkdir -p "${BIN(home)}"; tmp=$(mktemp -d); curl -fsSL "${url}" | tar -xz -C "$tmp"; install -m 755 "$tmp/${dir}/delta" "${BIN(home)}/delta"; rm -rf "$tmp"`
    const run = await $.process.run(['sh', '-c', script], { timeoutMs: 120_000 }).catch(() => null)
    if (run?.exitCode !== 0) return null
    $.ui.toast('delta installed in ~/.local/bin')

    return `${BIN(home)}/delta`
  })()

  return ready
}

// `git diff HEAD` for one file through delta; null when delta is missing or produced nothing
export async function deltaDiff($: EngineInterface, bin: string | null, dir: string, path: string, width: number): Promise<string | null> {
  if (!bin) return null
  const script = `git -C "$1" diff HEAD --no-color -- "$2" | "$3" --paging=never --line-numbers --file-style=omit --width="$4"`
  const run = await $.process.run(['sh', '-c', script, '_', dir, path, bin, String(width)], { timeoutMs: 15_000 }).catch(() => null)

  return run?.exitCode === 0 && run.stdout.trim() !== '' ? run.stdout : null
}
