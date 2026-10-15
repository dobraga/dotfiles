import { atom, read, type BuiltinToolResults, type EngineInterface, type Register, type RenderNode, type Timer, update } from 'claude-code'
import { openCommand } from './open'

import type { Activity, FileNode, FileTree, RepoRow, Theme, ViewMode } from '../types'
import { BRANCH_ICON, chainOf, type GitAction, gitActions, readOnly, readTargets, resolve, TONES } from './git'
import type { RowSpec, RowsProps, Seg } from './rows'
import { CHEVRON_CLOSED, CHEVRON_OPEN, fileIcon, GIT_COLOR, iconColor as typeColor } from './icons'
import {
  ancestorsOf,
  type Change,
  DEFAULT_THEME,
  dirname,
  emptyTree,
  formatSize,
  inside,
  isAbsolute,
  join,
  mapper,
  parseGit,
  parseNumstat,
  parseTheme,
  posix,
  relative,
  dropBelow,
  useDrives,
  rollCounts,
  replaceChildren,
  rollUp,
  stamp,
  toNodes,
  underAny,
  visibleRows,
} from './tree'

const TREE = { plugin: 'filetree', key: 'tree' } as const
const THEME = { plugin: 'filetree', key: 'theme' } as const
const ACTIVITY = { plugin: 'filetree', key: 'activity' } as const
const PANE = 'filetree'
const SHIMMER = Object.fromEntries(Object.entries(TONES).map(([k, v]) => [k, { bright: v.bright, dim: v.dim }]))
const BRANCH_ROW = '#branch'
const FLASH_MS = 2700
const RUNNING_MAX_MS = 600_000
const NO_REPO_DEPTH = 4
const DOUBLE_MS = 450
const FIND_LIMIT = 200
const READ_REVEAL_LIMIT = 12
const SEARCH_REVEAL_LIMIT = 60
const ACTIVITY_TTL_MS = 45_000
const ADD_COLOR = '#98c379'
const DEL_COLOR = '#e06c75'
const THEME_FILE = '.local/state/omarchy/current/theme/colors.toml'
const THEME_POLL_MS = 2000
const FONT_SCRIPT =
  'if command -v fc-list >/dev/null 2>&1; then f=$(fc-list ":charset=$1" file | head -n1 | cut -d: -f1); ' +
  'else f=$(ls "$HOME"/Library/Fonts/*Nerd* /Library/Fonts/*Nerd* 2>/dev/null | head -n1); fi; ' +
  '[ -n "$f" ] || { echo missing; exit 0; }; m=$(stat -c %Z "$f" 2>/dev/null || stat -f %c "$f"); p=$PPID; ' +
  'while [ -n "$p" ] && [ "$p" -gt 1 ]; do c=$(ps -o comm= -p "$p" 2>/dev/null); c=$(basename "$c" 2>/dev/null | tr -d " "); case "$c" in ' +
  'ghostty|kitty|alacritty|Alacritty|foot|footclient|wezterm-gui|konsole|gnome-terminal-|xterm|urxvt|st|Terminal|iTerm2) ' +
  'e=$(ps -o etime= -p "$p" 2>/dev/null | awk -F\'[-:]\' \'{n=NF; s=$n+60*$(n-1); if (n>2) s+=3600*$(n-2); if (n>3) s+=86400*$(n-3); print s}\'); [ -n "$e" ] && [ $(( $(date +%s) - e )) -lt "$m" ] && echo stale || echo ok; exit 0;; esac; ' +
  'p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " "); done; echo ok'
const PRUNE = ['.git', 'node_modules', 'target', '.venv', '__pycache__', 'dist', '.next']
const HOME_PRUNE = ['Library', 'AppData', '.Trash']
const SIZE_TIMEOUT_MS = 15_000
const SIZE_JOBS = 2
const SIZE_WALK_LIMIT = 50_000

let blink: Timer | null = null
let themePoll: Timer | null = null
let themeMtime: number | null = null
let generation = 0
let lastPress = { key: '', at: 0 }
let noNerd = false
let glyphSetting = 'auto'
let follow = true
let followClaude = true
// One folder open at a time (setting: accordion)
let accordion = true
// Root stays where Claude was opened instead of following `cd` (setting: root)
let pinRoot = true
// Branch line above the tree (setting: branch)
let showBranch = false
let scanning: Promise<void> | null = null
let scanJobs: Job[] = []
let gitRun: Promise<void> | null = null
let gitNext: Promise<void> | null = null
let queuedReads: string[] = []
let showReads = true
let showWrites = true
let searchIndex: { root: string; paths: Promise<string[]> } | null = null
let activityId = 0
let pointer = true
let view = { from: 0, max: 0 }
let lastSync = 0
let noDock = false
let home = ''
let platform: Promise<'linux' | 'darwin' | 'win32'> | null = null
let dirty: { root: string; files: Record<string, Change> } = { root: '', files: {} }
let markId = 0
let listSeq = 0
let lastRoot = ''
let sizeDefault = false
let sizeEpoch = 0
let sizeActive = 0
let sizeQueue: string[] = []
const sizing = new Set<string>()
const listLatest = new Map<string, number>()
const unreadable = new Set<string>()
const background = new Map<string, Background>()

function osName($: EngineInterface): Promise<'linux' | 'darwin' | 'win32'> {
  platform ??= (async () => {
    if ((await $.env.get('OS')) === 'Windows_NT') return 'win32'
    try {
      return (await $.process.run(['uname', '-s'], { timeoutMs: 3_000 })).stdout.trim() === 'Darwin' ? 'darwin' : 'linux'
    } catch {
      return 'linux'
    }
  })()
  return platform
}

async function cwdOf($: EngineInterface): Promise<string> {
  return posix(await $.session.cwd())
}

function clean(segs: Seg[]): Seg[] {
  for (const seg of segs) for (const k of Object.keys(seg) as (keyof Seg)[]) if (seg[k] === undefined) delete seg[k]
  return segs
}

function faint(hex: string): string {
  const v = parseInt(hex.slice(1), 16)
  const ch = (shift: number) => Math.round(0x26 + (((v >> shift) & 255) - 0x26) * 0.3)
  return `#${[16, 8, 0].map(x => ch(x).toString(16).padStart(2, '0')).join('')}`
}

async function get($: EngineInterface): Promise<FileTree> {
  return { ...emptyTree(''), ...(await $.state.get(TREE)).value }
}

async function put($: EngineInterface, fn: (t: FileTree) => FileTree): Promise<void> {
  await update($, TREE, cur => fn({ ...emptyTree(''), ...cur }))
}

function patch($: EngineInterface, fn: (t: FileTree) => Partial<FileTree>) {
  return put($, t => ({ ...t, ...fn(t) }))
}

async function activities($: EngineInterface): Promise<Activity[]> {
  return (await $.state.get(ACTIVITY)).value ?? []
}

async function setActivities($: EngineInterface, fn: (list: Activity[]) => Activity[]): Promise<void> {
  await update($, ACTIVITY, cur => fn(cur ?? []).slice(-6))
}

async function list($: EngineInterface, dir: string): Promise<FileNode[] | null> {
  try {
    const entries = await $.fs.list(dir)
    const resolved = await Promise.all(
      entries.map(async e => {
        if (!e.isLink) return { name: e.name, kind: e.kind, mtimeMs: e.mtimeMs, size: e.size, isLink: false }
        try {
          const target = await $.fs.stat(join(dir, e.name))
          return target.kind === 'dir'
            ? { name: e.name, kind: 'dir' as const, mtimeMs: target.mtimeMs, size: 0, isLink: false }
            : { name: e.name, kind: 'file' as const, mtimeMs: target.mtimeMs, size: target.size, isLink: true }
        } catch {
          return { name: e.name, kind: 'other' as const, mtimeMs: 0, size: 0, isLink: true }
        }
      }),
    )
    unreadable.delete(dir)
    return toNodes(dir, resolved)
  } catch (err) {
    if (!(await exists($, dir))) return []
    if (!unreadable.has(dir)) {
      unreadable.add(dir)
      $.ui.toast(`could not list ${shortPath(dir)}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }
}

async function loadDirs($: EngineInterface, dirs: string[]): Promise<Map<string, FileNode[]>> {
  const root = (await get($)).root
  const seq = ++listSeq
  for (const dir of dirs) listLatest.set(dir, seq)
  const results = await Promise.all(dirs.map(async dir => [dir, await list($, dir)] as const))
  const listed = new Map<string, FileNode[]>()
  for (const [dir, kids] of results) {
    if (listLatest.get(dir) !== seq) continue
    listLatest.delete(dir)
    if (kids) listed.set(dir, kids)
  }
  await patch($, t => (t.root === root ? { nodes: replaceChildren(t.nodes, listed) } : {}))
  return listed
}

async function git($: EngineInterface, cwd: string, args: string[], timeoutMs = 20_000) {
  return $.process.run(['git', '--no-optional-locks', '-C', cwd, ...args], { timeoutMs, env: { GIT_OPTIONAL_LOCKS: '0' } })
}

async function detectRepo($: EngineInterface): Promise<void> {
  const t = await get($)
  if (!t.root) return
  let top = ''
  let prefix = ''
  try {
    const run = await git($, t.root, ['rev-parse', '--show-prefix', '--show-toplevel'], 5_000)
    const [p = '', tl = ''] = run.exitCode === 0 ? run.stdout.split('\n') : []
    prefix = p.trim()
    top = tl.trim()
  } catch {
    top = ''
  }
  await patch($, cur => (cur.root === t.root ? { top, prefix } : {}))
}

async function readGit($: EngineInterface): Promise<void> {
  const t = await get($)
  if (!t.root || !t.top) return
  const root = t.root
  try {
    const status = await git($, root, ['status', '--porcelain=v1', '-b', '-z', '--ignored=traditional', '--untracked-files=normal', '--', '.'])
    if (status.exitCode !== 0) return
    const parsed = parseGit(status.stdout, root, t.prefix)
    const diff: Record<string, [number, number]> = {}
    const head = await git($, root, ['diff', 'HEAD', '--numstat', '-z', '--', '.'])
    if (head.exitCode === 0) parseNumstat(head.stdout, root, t.prefix, diff)
    const files = { ...parsed.files }
    if (parsed.untrackedDirs.length) {
      const others = await git($, root, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...parsed.untrackedDirs.map(d => d.slice(root.length + 1) || '.')])
      if (others.exitCode === 0) for (const rel of others.stdout.split('\0').filter(Boolean)) files[join(root, rel)] = 'new'
    }
    for (const path of Object.keys(diff)) if (files[path] === 'new') delete diff[path]
    dirty = { root, files }
    await patch($, cur =>
      cur.root === root
        ? {
            git: parsed.git,
            ignored: parsed.ignored,
            untrackedDirs: parsed.untrackedDirs,
            branch: parsed.branch,
            counts: rollCounts(files, root),
            diff: rollUp(diff, root),
          }
        : {},
    )
  } catch {
    return
  }
}

function refreshGit($: EngineInterface): Promise<void> {
  if (!gitRun) {
    gitRun = readGit($).finally(() => {
      gitRun = null
    })
    return gitRun
  }
  const rerun = () => {
    gitNext = null
    return refreshGit($)
  }
  gitNext ??= gitRun.then(rerun, rerun)
  return gitNext
}

async function reset($: EngineInterface, root: string, focus = false): Promise<void> {
  const prev = await get($)
  generation += 1
  blink?.cancel()
  blink = null
  lastRoot = root
  searchIndex = null
  sizeEpoch += 1
  sizeQueue = []
  await put($, () => ({ ...emptyTree(root), showHidden: prev.showHidden, showSize: prev.root ? prev.showSize : sizeDefault }))
  const title = `Files: ${root.split('/').pop() || root}`
  if (focus) await $.ui.open({ id: PANE, title, focus: true })
  else if (!noDock) await $.ui.open({ id: PANE, title })
  await loadDirs($, [root])
  await detectRepo($)
  await refreshGit($)
}

async function revealPaths($: EngineInterface, paths: string[]): Promise<void> {
  const tried = new Set<string>()
  for (let pass = 0; pass < 32; pass++) {
    const t = await get($)
    const loaded = new Set(t.nodes.filter(n => n.loaded).map(n => n.id))
    if (t.nodes.some(n => n.parent === t.root)) loaded.add(t.root)
    const need = new Set<string>()
    for (const p of paths) {
      for (const dir of [t.root, ...ancestorsOf(p, t.root).reverse()]) {
        if (!loaded.has(dir)) {
          if (!tried.has(dir)) need.add(dir)
          break
        }
      }
    }
    if (need.size === 0) return
    for (const dir of need) tried.add(dir)
    await loadDirs($, [...need])
  }
}

function pruneArgs(root: string, ignored: string[] = []): string[] {
  const names = broad(root) ? [...PRUNE, ...HOME_PRUNE] : PRUNE
  return ['(', ...names.flatMap((name, i) => (i === 0 ? ['-name', name] : ['-o', '-name', name])), ...ignored.flatMap(p => ['-o', '-path', p]), ')', '-prune', '-o']
}

async function newer($: EngineInterface, paths: string[], sinceMs: number): Promise<string[]> {
  const stats = await Promise.all(
    paths.map(async p => {
      try {
        return (await $.fs.stat(p)).mtimeMs > sinceMs ? p : ''
      } catch {
        return ''
      }
    }),
  )
  return stats.filter(Boolean)
}

function broad(root: string): boolean {
  return root === home || root === '/' || /^[A-Za-z]:\/$/.test(root)
}

function rootOfDisk(root: string): boolean {
  return root === '/' || /^[A-Za-z]:\/$/.test(root)
}

async function changedSince($: EngineInterface, root: string, since: Since, depth: number, ignored: string[] = []): Promise<string[]> {
  if (rootOfDisk(root)) return []
  const test = since.mark ? ['-newer', since.mark] : ['-newermt', `@${(since.ms / 1000).toFixed(3)}`]
  try {
    const run = await $.process.run(['find', '-H', root, '-xdev', ...(depth ? ['-maxdepth', String(depth)] : []), ...pruneArgs(root, ignored.filter(p => inside(root, p)).slice(0, 40)), ...test, '-print0'], { timeoutMs: 8_000 })
    return run.stdout.split('\0').filter(p => p && p !== root)
  } catch {
    return []
  }
}

async function changedInRepo($: EngineInterface, root: string, since: Since, before: Record<string, Change>, ignored: string[]): Promise<{ hits: string[]; gone: string[] }> {
  if (since.os !== 'win32') return { hits: await changedSince($, root, since, 0, ignored), gone: [] }
  if (dirty.root !== root) return { hits: [], gone: [] }
  const entries = Object.entries(dirty.files)
  const gone = entries.filter(([p, c]) => c === 'del' && before[p] !== 'del').map(([p]) => p)
  const live = entries.filter(([, c]) => c !== 'del').map(([p]) => p)
  return { hits: await newer($, live.slice(0, 4_000), since.ms), gone }
}

type Since = { ms: number; mark: string; os: 'linux' | 'darwin' | 'win32' }

async function sinceNow($: EngineInterface, writes: boolean): Promise<Since> {
  const ms = await $.clock.now()
  const os = await osName($)
  if (os !== 'darwin' || !writes) return { ms, mark: '', os }
  const mark = `${((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')}/filetree-${await $.session.id()}-${++markId}.mark`
  try {
    await $.process.run(['touch', mark], { timeoutMs: 3_000 })
    return { ms, mark, os }
  } catch {
    return { ms, mark: '', os }
  }
}

async function walkSize($: EngineInterface, dir: string): Promise<number> {
  let total = 0
  let seen = 0
  let level = [dir]
  while (level.length) {
    const next: string[] = []
    for (const d of level) {
      let entries
      try {
        entries = await $.fs.list(d)
      } catch {
        continue
      }
      for (const e of entries) {
        if (++seen > SIZE_WALK_LIMIT) return -1
        if (e.kind === 'dir' && !e.isLink) next.push(join(d, e.name))
        else if (e.kind === 'file') total += e.size
      }
    }
    level = next
  }
  return total
}

async function dirSize($: EngineInterface, dir: string): Promise<number> {
  if (rootOfDisk(dir)) return -1
  if ((await osName($)) === 'win32') return walkSize($, dir)
  try {
    const run = await $.process.run(['du', '-skxH', dir], { timeoutMs: SIZE_TIMEOUT_MS })
    const kb = Number(run.stdout.trim().split(/\s/)[0] || NaN)
    return Number.isFinite(kb) ? kb * 1024 : -1
  } catch {
    return -1
  }
}

function pumpSizes($: EngineInterface): void {
  while (sizeActive < SIZE_JOBS && sizeQueue.length) {
    const dir = sizeQueue.shift() ?? ''
    const epoch = sizeEpoch
    sizing.add(dir)
    sizeActive += 1
    void dirSize($, dir)
      .then(async bytes => {
        if (epoch === sizeEpoch) return patch($, cur => (inside(cur.root, dir) ? { dirSizes: { ...cur.dirSizes, [dir]: bytes } } : {}))
        const cur = await get($)
        if (cur.showSize && inside(cur.root, dir) && !(dir in cur.dirSizes) && !sizeQueue.includes(dir)) sizeQueue.push(dir)
      })
      .catch(() => undefined)
      .finally(() => {
        sizing.delete(dir)
        sizeActive -= 1
        pumpSizes($)
      })
  }
}

function wantSizes($: EngineInterface, dirs: string[]): void {
  for (const dir of dirs) if (!sizing.has(dir) && !sizeQueue.includes(dir)) sizeQueue.push(dir)
  pumpSizes($)
}

async function staleSizes($: EngineInterface, paths?: string[]): Promise<void> {
  sizeEpoch += 1
  sizeQueue = []
  await patch($, cur => {
    if (!paths) return { dirSizes: {} }
    const keep: Record<string, number> = {}
    for (const [dir, bytes] of Object.entries(cur.dirSizes)) if (!paths.some(p => inside(dir, p))) keep[dir] = bytes
    return { dirSizes: keep }
  })
}

function openDirs(t: FileTree): string[] {
  const open = new Set(t.expanded)
  return t.nodes.filter(n => n.kind === 'dir' && n.loaded && open.has(n.id)).map(n => n.id)
}

function keepTop(cur: FileTree, expanded: string[]): Partial<FileTree> {
  if (followClaude) return { scroll: null }
  const top = visibleRows(cur)[cur.scroll ?? view.from]?.node.id
  const at = top ? visibleRows({ ...cur, expanded }).findIndex(r => r.node.id === top) : -1
  return at < 0 ? {} : { scroll: at }
}

async function flash($: EngineInterface, tones: Record<string, string>): Promise<void> {
  const unique = Object.keys(tones)
  if (unique.length === 0) return
  const mine = ++generation
  const root = (await get($)).root
  blink?.cancel()
  blink = null
  await patch($, cur => {
    if (cur.root !== root) return {}
    const open = new Set(cur.expanded)
    const bright = new Set([...(cur.flashOn ? cur.flash.filter(id => !unique.includes(id)) : []), ...unique])
    const dim = new Set<string>()
    const all: Record<string, string> = cur.flashOn ? { ...cur.flashTones } : {}
    if (cur.flashOn) {
      for (const id of cur.flashDim) dim.add(id)
    }
    for (const id of unique) {
      const tone = tones[id] ?? 'orange'
      all[id] = tone
      if (id === BRANCH_ROW) continue
      const chain = ancestorsOf(id, cur.root)
      if (!chain.some(a => !open.has(a))) continue
      for (const a of chain) {
        if (!open.has(a)) {
          dim.add(a)
          all[a] = all[a] ?? tone
        }
        open.add(a)
      }
    }
    for (const id of bright) dim.delete(id)
    return {
      flash: [...bright],
      flashDim: [...dim],
      flashOn: true,
      flashTones: all,
      expanded: [...open],
      ...keepTop(cur, [...open]),
    }
  })
  if (generation !== mine) return
  blink = $.clock.after(FLASH_MS, () => {
    if (generation !== mine) return
    blink = null
    void patch($, cur => (generation === mine ? { flash: [], flashDim: [], flashOn: false, flashTones: {} } : {}))
  })
}

async function followCwd($: EngineInterface): Promise<boolean> {
  if (!follow) return false
  const t = await get($)
  if (pinRoot && t.root) return false
  const cwd = await cwdOf($)
  if (t.root === cwd) return false
  await reset($, cwd)
  return true
}

type Pending = { actions: GitAction[]; ids: number[]; command: string; head: string }
type Job = { actions: GitAction[]; since: Since; initRepo: boolean; readOnly: boolean }
type Background = { p: Pending | null; job: Job; reads: string[] }
type GitOperation = NonNullable<BuiltinToolResults['Bash']['gitOperation']>
type Outcome = { state: 'done' | 'failed'; label: string; detail: string }

const PROOF: Record<string, (op: GitOperation) => boolean> = {
  push: op => Boolean(op.push),
  merge: op => op.branch?.action === 'merged',
  rebase: op => op.branch?.action === 'rebased',
  'pr create': op => op.pr?.action === 'created',
  'pr merge': op => op.pr?.action === 'merged',
  'pr comment': op => op.pr?.action === 'commented',
}

async function startGit($: EngineInterface, actions: GitAction[]): Promise<number[]> {
  const now = await $.clock.now()
  const ids = actions.map(() => ++activityId)
  await setActivities($, cur => [
    ...cur.filter(a => a.state === 'running' || now - a.at < ACTIVITY_TTL_MS),
    ...actions.map((a, i) => ({
      id: ids[i] ?? 0,
      kind: a.kind,
      label: a.running,
      state: 'running' as const,
      detail: '',
      at: now,
      tone: a.tone,
      nerd: a.icon.nerd,
      plain: a.icon.plain,
    })),
  ])
  return ids
}

async function headOf($: EngineInterface, cwd: string): Promise<string> {
  try {
    const run = await git($, cwd, ['rev-parse', 'HEAD'], 5_000)
    return run.exitCode === 0 ? run.stdout.trim() : ''
  } catch {
    return ''
  }
}

async function outcomes($: EngineInterface, p: Pending, ok: boolean, op: GitOperation | undefined): Promise<Outcome[]> {
  const chain = chainOf(p.command)
  const after = p.actions.some(a => a.verb === 'commit') && !op?.commit ? await headOf($, (await get($)).root || (await cwdOf($))) : ''
  return p.actions.map(a => {
    if (a.verb === 'commit') {
      const sha = op?.commit?.sha || (after && after !== p.head ? after : '')
      return sha ? { state: 'done', label: a.done, detail: sha.slice(0, 7) } : { state: 'failed', label: `${a.verb} failed`, detail: '' }
    }
    if ((op && PROOF[a.verb]?.(op)) || (ok && chain.and)) return { state: 'done', label: a.done, detail: '' }
    if (!ok && chain.and && chain.size === 1) return { state: 'failed', label: `${a.verb} failed`, detail: '' }
    return { state: 'done', label: `ran ${a.kind}`, detail: '' }
  })
}

async function finishGit($: EngineInterface, p: Pending, results: Outcome[]): Promise<void> {
  const now = await $.clock.now()
  await setActivities($, cur =>
    cur.map(a => {
      const i = p.ids.indexOf(a.id)
      const result = i < 0 ? undefined : results[i]
      return result ? { ...a, ...result, at: now } : a
    }),
  )
  $.clock.after(ACTIVITY_TTL_MS + 500, () => void setActivities($, cur => cur.filter(a => a.state === 'running' || a.at > now)))
}

function failAll(p: Pending): Outcome[] {
  return p.actions.map(a => ({ state: 'failed', label: `${a.verb} failed`, detail: '' }))
}

function proven(p: Pending | null, results: Outcome[]): GitAction[] {
  return p ? p.actions.filter((_, i) => results[i]?.state !== 'failed') : []
}

function taskEnds(text: string): [string, string][] {
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].flatMap(m => {
    const id = /<task-id>([^<]*)<\/task-id>/.exec(m[1] ?? '')?.[1]?.trim()
    const status = /<status>([^<]*)<\/status>/.exec(m[1] ?? '')?.[1]?.trim()
    return id && status ? [[id, status] as [string, string]] : []
  })
}

async function settleBackground($: EngineInterface, text: string): Promise<void> {
  if (background.size === 0 || !text.includes('<task-notification>')) return
  for (const [id, status] of taskEnds(text)) {
    const task = background.get(id)
    if (!task) continue
    background.delete(id)
    const ok = status === 'completed'
    const results = task.p ? await outcomes($, task.p, ok, undefined) : []
    if (task.p) await finishGit($, task.p, results)
    if (showReads) queuedReads.push(...task.reads)
    scheduleScan($, { ...task.job, actions: proven(task.p, results) })
  }
}

async function gitPaths($: EngineInterface, root: string, prefix: string, committed: boolean): Promise<string[]> {
  const map = mapper(root, prefix)
  try {
    const run = committed
      ? await git($, root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'], 5_000)
      : await git($, root, ['diff', '--cached', '--name-only', '-z'], 5_000)
    return run.exitCode === 0 ? run.stdout.split('\0').filter(Boolean).flatMap(rel => map(rel) ?? []) : []
  } catch {
    return []
  }
}

async function gitDir($: EngineInterface, cwd: string): Promise<string> {
  for (let dir = cwd, i = 0; i < 64; i++) {
    try {
      const dot = join(dir, '.git')
      const st = await $.fs.stat(dot)
      if (st.kind === 'dir') return dot
      const ref = /^gitdir:\s*(.+)$/m.exec(String(await $.fs.read(dot)))?.[1]?.trim()
      if (ref) return resolve(dir, ref, home)
    } catch {
      const up = dirname(dir)
      if (up === dir) return ''
      dir = up
      continue
    }
    return ''
  }
  return ''
}

async function sync($: EngineInterface, force = false): Promise<void> {
  const now = await $.clock.now()
  if (!force && now - lastSync < 2_000) return
  lastSync = now
  searchIndex = null
  const t = await get($)
  if (!t.root) return
  await loadDirs($, [t.root, ...openDirs(t)])
  if (t.top) await refreshGit($)
}

async function copyPath($: EngineInterface, id: string, absolute: boolean, surface?: string): Promise<void> {
  const t = await get($)
  const text = !absolute && id !== t.root && inside(t.root, id) ? id.slice(t.root.endsWith('/') ? t.root.length : t.root.length + 1) : id
  const done = await $.ui.copy({ text, ...(surface ? { surface: surface as 'terminal' } : {}) })
  $.ui.toast(done.isCopied ? `Copied ${text}` : 'Could not copy the path')
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    await $.fs.stat(path)
    return true
  } catch {
    return false
  }
}

async function afterBash($: EngineInterface, jobs: Job[]): Promise<void> {
  const reads = queuedReads
  queuedReads = []
  if (await followCwd($)) return
  const t = await get($)
  if (!t.root) return
  const actions = jobs.flatMap(j => j.actions)
  const writers = jobs.filter(j => !j.readOnly)
  const since = (writers.length ? writers : jobs).reduce((a, j) => (j.since.ms < a.ms ? j.since : a), (writers[0] ?? jobs[0])?.since ?? { ms: 0, mark: '', os: 'linux' as const })
  const writes = !jobs.every(j => j.readOnly)
  const before = dirty.root === t.root ? dirty.files : {}
  if (jobs.some(j => j.initRepo)) await detectRepo($)
  else if (!t.top && (await exists($, join(t.root, '.git')))) await detectRepo($)
  const probed = await get($)
  if (probed.top && (writes || probed.top !== t.top)) await refreshGit($)
  if (writes) {
    searchIndex = null
    await staleSizes($)
  }
  const fresh = await get($)
  const ignored = new Set(fresh.ignored)
  const tones: Record<string, string> = {}
  if (writes) {
    const found = fresh.top
      ? await changedInRepo($, t.root, since, before, fresh.ignored)
      : { hits: since.os === 'win32' ? [] : await changedSince($, t.root, since, NO_REPO_DEPTH), gone: [] }
    const hits = found.hits.filter(x => inside(t.root, x) && !underAny(x, ignored, t.root)).slice(0, FIND_LIMIT)
    await revealPaths($, hits)
    const loaded = await get($)
    const dirs = [...new Set([loaded.root, ...openDirs(loaded), ...hits.map(dirname), ...found.gone.map(dirname)])].filter(d => inside(loaded.root, d))
    const listed = await loadDirs($, dirs)
    if (!fresh.top && since.os === 'win32')
      for (const kids of listed.values()) for (const n of kids) if (n.mtime > since.ms && hits.length < FIND_LIMIT) hits.push(n.id)
    await patch($, cur => {
      const ids = new Set(cur.nodes.map(n => n.id))
      return { expanded: cur.expanded.filter(id => ids.has(id)) }
    })
    const present = new Set((await get($)).nodes.map(n => n.id))
    const touchTone = actions.find(a => !['commit', 'push', 'add'].includes(a.verb))?.tone ?? 'orange'
    if (showWrites) for (const id of hits) if (present.has(id)) tones[id] = touchTone
  }
  if (showReads) {
    const found: string[] = []
    for (const r of reads) {
      if (found.length >= READ_REVEAL_LIMIT) break
      if (r !== t.root && inside(t.root, r) && !underAny(r, ignored, t.root) && (await exists($, r))) found.push(r)
    }
    if (found.length) {
      await revealPaths($, found)
      const shown = new Set((await get($)).nodes.map(n => n.id))
      for (const r of found) if (shown.has(r) && !tones[r]) tones[r] = 'purple'
    }
  }
  if (showWrites && actions.length) {
    const final = await get($)
    const committed = actions.some(a => a.verb === 'commit')
    if ((committed || actions.some(a => a.verb === 'add')) && final.top) {
      const paths = (await gitPaths($, final.root, final.prefix, committed)).filter(x => !underAny(x, ignored, final.root)).slice(0, READ_REVEAL_LIMIT)
      await revealPaths($, paths)
      const shown = new Set((await get($)).nodes.map(n => n.id))
      for (const x of paths) if (shown.has(x)) tones[x] = 'green'
    }
    const pushLike = actions.find(a => ['push', 'pull', 'fetch', 'checkout', 'switch', 'branch', 'merge', 'rebase', 'tag'].includes(a.verb) || a.kind.startsWith('gh '))
    if (pushLike) tones[BRANCH_ROW] = pushLike.tone
    else if (committed) tones[BRANCH_ROW] = 'green'
  }
  await flash($, tones)
}

function scheduleScan($: EngineInterface, job: Job): void {
  scanJobs.push(job)
  if (scanning) return
  scanning = (async () => {
    while (scanJobs.length) {
      const jobs = scanJobs
      scanJobs = []
      try {
        await afterBash($, jobs)
      } finally {
        const marks = jobs.map(j => j.since.mark).filter(Boolean)
        if (marks.length) await $.process.run(['rm', '-f', ...marks], { timeoutMs: 3_000 }).catch(() => undefined)
      }
    }
  })().finally(() => {
    scanning = null
  })
}

async function touched($: EngineInterface, paths: string[], tone: string, show: boolean): Promise<void> {
  if (await followCwd($)) return
  const t = await get($)
  if (!t.root) return
  const within = paths.map(posix).filter(p => inside(t.root, p))
  if (within.length === 0) return
  if (tone !== 'purple') {
    searchIndex = null
    await staleSizes($, within)
    await revealPaths($, within.map(dirname))
    await loadDirs($, [...new Set(within.map(dirname))].filter(d => inside(t.root, d)))
    await refreshGit($)
  } else await revealPaths($, within)
  if (!show) return
  const tones: Record<string, string> = {}
  for (const p of within) tones[p] = tone
  await flash($, tones)
}

async function reveal($: EngineInterface, paths: string[]): Promise<void> {
  if (await followCwd($)) return
  await revealPaths($, paths)
  await patch($, cur => {
    const open = new Set(cur.expanded)
    for (const p of paths) for (const a of ancestorsOf(p, cur.root)) open.add(a)
    return { expanded: [...open], cursor: paths[paths.length - 1] ?? cur.cursor, scroll: null }
  })
}

async function walk($: EngineInterface, root: string, depth: number, limit: number): Promise<string[]> {
  const out: string[] = []
  let level = [root]
  for (let d = 0; d < depth && level.length && out.length < limit; d++) {
    const next: string[] = []
    for (const dir of level) {
      for (const n of (await list($, dir)) ?? []) {
        if (n.kind === 'dir') {
          if (!PRUNE.includes(n.name)) next.push(n.id)
        } else out.push(n.id)
      }
      if (out.length >= limit) break
    }
    level = next
  }
  return out
}

async function listAll($: EngineInterface, t: FileTree): Promise<string[] | null> {
  try {
    if (!t.top && (await osName($)) === 'win32') return await walk($, t.root, rootOfDisk(t.root) ? 3 : 6, 20_000)
    const run = t.top
      ? await git($, t.root, ['ls-files', '-co', '--exclude-standard', '-z'], 10_000)
      : await $.process.run(['find', '-H', t.root, '-xdev', '-maxdepth', rootOfDisk(t.root) ? '3' : '6', ...pruneArgs(t.root), '-type', 'f', '-print0'], { timeoutMs: 10_000 })
    if (t.top && run.exitCode !== 0) return null
    const paths = run.stdout.split('\0').filter(Boolean)
    if (run.isStdoutTruncated) paths.pop()
    return paths.map(p => (isAbsolute(p) ? p : join(t.root, p)))
  } catch {
    return null
  }
}

function indexPaths($: EngineInterface, t: FileTree): Promise<string[]> {
  if (searchIndex?.root !== t.root) {
    const index: { root: string; paths: Promise<string[]> } = {
      root: t.root,
      paths: listAll($, t).then(paths => {
        if (paths === null && searchIndex === index) searchIndex = null
        return paths ?? []
      }),
    }
    searchIndex = index
  }
  return searchIndex.paths
}

async function search($: EngineInterface, query: string): Promise<string[]> {
  if (!(await get($)).query.trim()) searchIndex = null
  await patch($, () => ({ query }))
  const q = query.trim().toLowerCase()
  if (!q) return []
  const t = await get($)
  const hits = (await indexPaths($, t)).filter(p => relative(t.root, p).toLowerCase().includes(q)).slice(0, SEARCH_REVEAL_LIMIT)
  if ((await get($)).query !== query) return []
  await revealPaths($, hits)
  const shown = await get($)
  const ids = new Set(shown.nodes.map(n => n.id))
  const stale = [...new Set(hits.filter(p => !ids.has(p)).map(dirname))].filter(d => inside(shown.root, d))
  if (stale.length) await loadDirs($, stale)
  return hits
}

async function jump($: EngineInterface, query: string): Promise<void> {
  const hits = (await search($, query)).slice(0, 10)
  await patch($, cur => {
    const open = new Set(cur.expanded)
    for (const p of hits) for (const a of ancestorsOf(p, cur.root)) open.add(a)
    return { query: '', expanded: [...open], cursor: hits[0] ?? cur.cursor, scroll: null }
  })
}

async function fontState($: EngineInterface, charset: string): Promise<'ok' | 'stale' | 'missing'> {
  try {
    const out = (await $.process.run(['sh', '-c', FONT_SCRIPT, 'sh', charset], { timeoutMs: 5_000 })).stdout.trim()
    return out === 'stale' || out === 'missing' ? out : 'ok'
  } catch {
    return 'missing'
  }
}

async function finePointerOk($: EngineInterface): Promise<boolean> {
  if (!(await $.env.get('HERDR_ENV'))) return true
  try {
    const out = (await $.process.run([(await $.env.get('HERDR_BIN_PATH')) || 'herdr', '--version'], { timeoutMs: 3_000 })).stdout
    const [major = 0, minor = 0, fix = 0] = (/(\d+)\.(\d+)\.(\d+)/.exec(out) ?? []).slice(1).map(Number)
    return major * 1e6 + minor * 1e3 + fix >= 9_001
  } catch {
    return false
  }
}

async function openFile($: EngineInterface, path: string): Promise<void> {
  const { argv, init } = openCommand(await osName($), path)
  try {
    const run = await $.process.run(argv, init)
    if (run.exitCode !== 0) $.ui.toast(`could not open ${path} with ${argv[0]}: ${run.stderr.trim().split('\n')[0] || `exit ${run.exitCode}`}`)
  } catch {
    $.ui.toast(`could not open ${path} with ${argv[0]}`)
  }
}

async function toggle($: EngineInterface, n: FileNode): Promise<void> {
  if (n.kind === 'dir' && !(await get($)).expanded.includes(n.id)) await loadDirs($, [n.id])
  await patch($, t => {
    const open = new Set(t.expanded)
    if (n.kind === 'dir') {
      if (open.has(n.id)) open.delete(n.id)
      // Accordion: opening a folder closes every other one, keeping only the path down to it
      else if (accordion) {
        open.clear()
        for (const a of ancestorsOf(n.id, t.root)) open.add(a)
        open.add(n.id)
      } else open.add(n.id)
    }
    return { expanded: [...open], cursor: n.id, selected: n.kind === 'dir' ? t.selected : n.id }
  })
}

async function press($: EngineInterface, n: FileNode): Promise<void> {
  const now = await $.clock.now()
  const isDouble = lastPress.key === n.id && now - lastPress.at < DOUBLE_MS
  lastPress = { key: isDouble ? '' : n.id, at: now }
  if (!isDouble) {
    await toggle($, n)
    // The click above can take a while (viewer opens); time the second click from when it finished
    lastPress.at = await $.clock.now()
    return
  }
  // Double click: a file opens in the viewer; a folder was already toggled by the first click
  if (n.kind !== 'dir') await show($)
}

async function openNode($: EngineInterface, n: FileNode): Promise<void> {
  if (n.kind === 'dir') {
    follow = false
    await reset($, n.id)
  } else await openFile($, n.id)
}

async function loadTheme($: EngineInterface): Promise<void> {
  const path = `${(await $.env.get('HOME')) ?? ''}/${THEME_FILE}`
  try {
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'file') throw new Error('no theme file')
    if (stat.mtimeMs === themeMtime) return
    await $.state.set(THEME, parseTheme(String(await $.fs.read(path))))
    themeMtime = stat.mtimeMs
  } catch {
    if (themeMtime === 0) return
    await $.state.set(THEME, DEFAULT_THEME)
    themeMtime = 0
  }
}

function shortPath(path: string): string {
  return home && inside(home, path) ? `~${path.slice(home.length)}` : path
}

// ---- file viewer, repo branches, pull/push (merged from the file-viewer mod) ----
const VIEWER_PANE = 'file-viewer'
// Fixed tab: the repos with changes, opened with the session (the viewer's own Repos view shows the same list)
const REPOS_PANE = 'repos'
const TITLE = 'File viewer'
const MAX_CHARS = 90000
const RENDER_TIMEOUT_MS = 10000
const mode = atom({ plugin: 'filetree', key: 'mode' } as const, 'diff' as ViewMode)
const auto = atom({ plugin: 'filetree', key: 'auto' } as const, false)
// A path given to `/view <path>`; shown instead of the filetree selection until the next selection there
const SCROLL_STEP = 20
const GUTTER = 7
// Columns scrolled off to the left in the File and Diff views
// First row shown (the mod scrolls vertically itself so the header stays put)
const row = atom({ plugin: 'filetree', key: 'row' } as const, 0)
const col = atom({ plugin: 'filetree', key: 'col' } as const, 0)
// True while the viewer pane is open; the band reads it because a render hook cannot call $.ui.panes()
// One tab at a time: opening the viewer closes the file tree; closing the viewer brings the tree back
const single = atom({ plugin: 'filetree', key: 'single' } as const, false)
const isOpen = atom({ plugin: 'filetree', key: 'isOpen' } as const, false)
const target = atom({ plugin: 'filetree', key: 'target' } as const, '')

// Diagram sources already drawn this session, by source text
const diagrams = new Map<string, string>()

// Last row the header-fixed window can start at, as of the last pane draw; the wheel and arrows clamp to it
let lastMaxRow = 0
const WHEEL_ROWS = 3
// Fallback when the pane's height is unknown: screen rows the pane body never gets (prompt, frame)
const CHROME_ROWS = 12
// Rows the pane draws above the content: the controls and the hint line
const HEADER_ROWS = 2
// bodyRows reads ~10 rows short of the room the pane really has (measured: 11 leaves the last line cut off, 0 leaves rows empty)
const EXTRA_ROWS = 10
// Blank rows under the window so the tree is always taller than the pane and the engine keeps raising ui.scroll
const SPACER_ROWS = 12

// Repos directly under the working directory, with their branch (shown in the viewer's Repos view)
const REFRESH_MS = 30000
// Branches repos normally sit on; anything else (a feature branch) is highlighted
const BASE_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'staging', 'production'])
const repos = atom({ plugin: 'filetree', key: 'repos' } as const, [] as RepoRow[])
// Repos view: the repo whose changed files are listed ('' = the repo list), and whether clean repos are listed too
const repoPick = atom({ plugin: 'filetree', key: 'repoPick' } as const, '')
const allRepos = atom({ plugin: 'filetree', key: 'allRepos' } as const, false)
// Repos tab: the changed file whose diff is drawn inside the tab itself ('' = the file list)
const repoFile = atom({ plugin: 'filetree', key: 'repoFile' } as const, '')
const MAX_DIFF_LINES = 600

type ChangedFile = { path: string; letter: string; add: number; del: number }

// `git status --porcelain=v2 --branch`: "# branch.head <name>", "# branch.ab +<ahead> -<behind>", then one line per changed path
const inspectRepo = async ($: EngineInterface, name: string, path = name): Promise<RepoRow> => {
  const run = await $.process.run(['git', '-C', path, 'status', '--porcelain=v2', '--branch'], { timeoutMs: 10000 })
  const repo: RepoRow = { name, path, branch: '?', dirty: 0, ahead: 0, behind: 0 }
  if (run.exitCode !== 0) return repo
  for (const line of run.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) repo.branch = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.ab ')) {
      const [ahead, behind] = line.slice('# branch.ab '.length).split(' ')
      repo.ahead = Math.abs(Number(ahead))
      repo.behind = Math.abs(Number(behind))
    } else if (line !== '' && !line.startsWith('#')) repo.dirty += 1
  }

  return repo
}

const refreshRepos = async ($: EngineInterface): Promise<void> => {
  const names: string[] = []
  for (const entry of await $.fs.list('.')) {
    if (entry.kind === 'dir' && !entry.name.startsWith('.') && (await $.fs.exists(`${entry.name}/.git`))) names.push(entry.name)
  }
  const rows = await Promise.all(names.sort().map(name => inspectRepo($, name)))
  // The folder itself, when it is a repo, is the main one and stays pinned first
  if (await $.fs.exists('.git')) rows.unshift(await inspectRepo($, (await cwdOf($)).split('/').pop() || '.', '.'))
  await update($, repos, () => rows)
}

// Pull (fast-forward only) and push (never forced) one repo, then re-read it; the result goes to a toast
const gitAction = async ($: EngineInterface, repo: RepoRow, verb: 'pull' | 'push'): Promise<void> => {
  const { name, path } = repo
  $.ui.toast(`${verb === 'pull' ? 'Pulling' : 'Pushing'} ${name}...`)
  const argv = verb === 'pull' ? ['git', '-C', path, 'pull', '--ff-only'] : ['git', '-C', path, 'push']
  try {
    const run = await $.process.run(argv, { timeoutMs: 120000 })
    const out = (run.exitCode === 0 ? run.stdout || run.stderr : run.stderr || run.stdout).trim().split('\n').filter(l => l !== '')
    $.ui.toast(`${name}: ${run.exitCode === 0 ? `${verb} ok` : `${verb} failed`}${out.length > 0 ? ` - ${out[out.length - 1]}` : ''}`)
  } catch (err) {
    $.ui.toast(`${name}: ${verb} failed - ${String(err)}`)
  }
  await refreshRepos($)
}

// Files changed in one repo (staged, unstaged and untracked), with their +N -N against HEAD
const changedFiles = async ($: EngineInterface, repo: RepoRow): Promise<ChangedFile[]> => {
  const cwd = await cwdOf($)
  const abs = repo.path === '.' ? cwd : `${cwd}/${repo.path}`
  const [status, numstat] = await Promise.all([
    $.process.run(['git', '--no-optional-locks', '-C', abs, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 10000 }),
    $.process.run(['git', '--no-optional-locks', '-C', abs, 'diff', 'HEAD', '--numstat', '-z'], { timeoutMs: 10000 }),
  ])
  if (status.exitCode !== 0) return []
  const counts: Record<string, [number, number]> = {}
  if (numstat.exitCode === 0) parseNumstat(numstat.stdout, abs, '', counts)
  const { files } = parseGit(status.stdout, abs, '')
  const letters: Record<Change, string> = { new: 'A', mod: 'M', del: 'D' }

  return Object.entries(files)
    .map(([path, change]) => ({ path, letter: letters[change], add: counts[path]?.[0] ?? 0, del: counts[path]?.[1] ?? 0 }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

// Repo list and, once one is picked, its changed files; `inViewer` adds the Diff/File buttons and the file-tree hint
const reposView = async ($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], path: string, inViewer: boolean): Promise<RenderNode> => {
  const { Box, Text, Button } = $.ui.resolve(e)
  const everyRepo = await read($, repos)
  const showAll = await read($, allRepos)
  const rows = showAll ? everyRepo : everyRepo.filter(r => r.dirty > 0)
  const nameWidth = rows.reduce((n, r) => Math.max(n, r.name.length), 0)
  const pickedPath = await read($, repoPick)
  const picked = everyRepo.find(r => r.path === pickedPath)
  const header = (
    <Box>
      {inViewer && path && <Button label="Diff" hotkey="d" onPress={() => void update($, mode, () => 'diff')} />}
      {inViewer && path && <Text> </Text>}
      {inViewer && path && <Button label="File" hotkey="f" onPress={() => void update($, mode, () => 'file')} />}
      {inViewer && path && <Text> </Text>}
      {inViewer && <Button label="Repos" hotkey="r" onPress={() => void update($, mode, () => 'repos')} />}
      {inViewer && <Text> </Text>}
      <Button label="Refresh" onPress={() => void refreshRepos($)} />
      {!picked && <Text> </Text>}
      {!picked && <Button label={showAll ? 'Changed only' : 'All'} hotkey="a" onPress={() => void update($, allRepos, current => !current)} />}
      {!picked && <Text dimColor> {showAll ? `${everyRepo.length} repos` : `${rows.length} of ${everyRepo.length} repos with changes`}</Text>}
    </Box>
  )

  if (picked) {
    const cwd = await cwdOf($)
    const base = picked.path === '.' ? cwd : `${cwd}/${picked.path}`
    const pickedFile = inViewer ? '' : await read($, repoFile)

    // The Repos tab draws the diff itself, so nothing has to open or focus another pane
    if (pickedFile) {
      const run = await $.process.run(['git', '--no-optional-locks', '-C', parentDir(pickedFile), 'diff', 'HEAD', '--no-color', '--', pickedFile], { timeoutMs: 10000 })
      const isDiff = run.exitCode === 0 && run.stdout.trim() !== ''
      const text = isDiff ? run.stdout : await $.fs.read(pickedFile).catch(() => '')
      const all = text.split('\n')
      const lines = all.slice(0, MAX_DIFF_LINES)

      return (
        <Box flexDirection="column">
          {header}
          <Box>
            <Button label="← Files" hotkey="b" onPress={() => void update($, repoFile, () => '')} />
            <Text dimColor> {pickedFile.slice(base.length + 1)} · {isDiff ? 'diff vs HEAD' : 'untracked: full file'}{all.length > lines.length ? ` · first ${lines.length} of ${all.length} lines` : ''}</Text>
          </Box>
          {lines.map(line => (
            <Text wrap="truncate-end" color={line.startsWith('@@') ? 'cyan' : isDiff && line.startsWith('+') ? 'green' : isDiff && line.startsWith('-') ? 'red' : undefined}>
              {line === '' ? ' ' : line}
            </Text>
          ))}
        </Box>
      )
    }

    const files = await changedFiles($, picked)
    const open = (file: ChangedFile) =>
      void (async () => {
        if (!inViewer) return void (await update($, repoFile, () => file.path))
        await update($, target, () => file.path)
        await update($, col, () => 0)
        await update($, row, () => 0)
        await update($, mode, () => 'diff')
      })()

    return (
      <Box flexDirection="column">
        {header}
        <Box>
          <Button label="← Repos" hotkey="b" onPress={() => void update($, repoPick, () => '')} />
          <Text> {picked.name} </Text>
          <Text color={BASE_BRANCHES.has(picked.branch) ? undefined : 'yellow'} dimColor={BASE_BRANCHES.has(picked.branch)}>
            {picked.branch}
          </Text>
          <Text dimColor> · {files.length} changed files</Text>
        </Box>
        {files.length === 0 && <Text dimColor>No changes in this repo.</Text>}
        {files.map(f => (
          <Box>
            <Text color={GIT_COLOR[f.letter === 'A' ? '?' : f.letter]}>{f.letter} </Text>
            <Button key={`file-${f.path}`} plain label={f.path.slice(base.length + 1)} onPress={() => open(f)} />
            {f.add > 0 && <Text color="green"> +{f.add}</Text>}
            {f.del > 0 && <Text color="red"> -{f.del}</Text>}
          </Box>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {header}
      {rows.length === 0 && (
        <Text dimColor>
          {everyRepo.length > 0 ? 'No repos with changes. Press "a" to list all.' : 'No git repos directly under this folder.'}
        </Text>
      )}
      {inViewer && rows.length > 0 && !path && <Text dimColor>Select a file in the file tree to preview it.</Text>}
      {rows.map(r => (
        <Box>
          <Button key={`open-${r.path}`} plain label={r.name.padEnd(nameWidth)} onPress={() => void update($, repoPick, () => r.path)} />
          <Text> </Text>
          <Text color={BASE_BRANCHES.has(r.branch) ? undefined : 'yellow'} dimColor={BASE_BRANCHES.has(r.branch)}>
            {r.branch}
          </Text>
          {r.dirty > 0 && <Text color="red"> ●{r.dirty}</Text>}
          {r.ahead > 0 && <Text color="green"> ↑{r.ahead}</Text>}
          {r.behind > 0 && <Text color="cyan"> ↓{r.behind}</Text>}
          {r.behind > 0 && <Text> </Text>}
          {r.behind > 0 && <Button key={`pull-${r.name}`} plain label="pull" onPress={() => void gitAction($, r, 'pull')} />}
          {r.ahead > 0 && <Text> </Text>}
          {r.ahead > 0 && <Button key={`push-${r.name}`} plain label="push" onPress={() => void gitAction($, r, 'push')} />}
        </Box>
      ))}
    </Box>
  )
}

const parentDir = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/'

const show = async ($: EngineInterface): Promise<void> => {
  const placed = await $.ui.open({ id: VIEWER_PANE, title: TITLE, focus: true })
  await update($, isOpen, () => true)
  if (await read($, single)) await $.ui.close({ id: 'filetree' }).catch(() => undefined)
  if (!placed.isPlaced) $.ui.toast(`File viewer not shown: ${placed.reason}`)
}

// Mermaid -> text via ~/.claude/file-viewer-tools/render.mjs (beautiful-mermaid)
const drawDiagram = async ($: EngineInterface, source: string): Promise<string> => {
  const cached = diagrams.get(source)
  if (cached !== undefined) return cached
  const home = (await $.env.get('HOME')) ?? ''
  const run = await $.process.run(['node', `${home}/.claude/file-viewer-tools/render.mjs`], {
    stdin: source,
    timeoutMs: RENDER_TIMEOUT_MS,
  })
  const text = run.exitCode === 0 ? run.stdout : `mermaid render failed: ${run.stderr.trim().split('\n')[0] || `exit ${run.exitCode}`}\n\n${source}`
  diagrams.set(source, text)

  return text
}

// `scroll` blocks (mermaid, code fences, tables) slide sideways; `markdown` blocks keep the engine's own wrapping
type Segment = { kind: 'markdown' | 'mermaid' | 'code' | 'table'; text: string; language?: string }

const splitBlocks = (text: string): Segment[] => {
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
const formatTable = (text: string): string => {
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


// Media: images (converted to PNG with sips), audio (afplay) and video (a poster frame from ffmpeg, seekable) in the viewer
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|aiff?)$/i
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi)$/i
const MEDIA_CACHE = '/tmp/file-viewer-cache'
const VIDEO_STEP = 5
const playPid = atom({ plugin: 'filetree', key: 'playPid' } as const, 0)
const playStart = atom({ plugin: 'filetree', key: 'playStart' } as const, 0)
const playDuration = atom({ plugin: 'filetree', key: 'playDuration' } as const, 0)
const videoPos = atom({ plugin: 'filetree', key: 'videoPos' } as const, 0)
const tick = atom({ plugin: 'filetree', key: 'tick' } as const, 0)
let ticker: Timer | undefined

const cacheName = (path: string): string => path.replace(/[^A-Za-z0-9]+/g, '_').slice(-120)
// Terminals that draw real images through the terminal's own protocol (iTerm2, WezTerm, Ghostty, Kitty); others get the text-cell picture
const supportsImages = async ($: EngineInterface): Promise<boolean> => {
  const program = (await $.env.get('TERM_PROGRAM')) ?? ''
  if (/^(iTerm\.app|WezTerm|ghostty)$/i.test(program)) return true

  return Boolean(await $.env.get('KITTY_WINDOW_ID')) || (await $.env.get('TERM')) === 'xterm-kitty'
}

const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

const mediaDuration = async ($: EngineInterface, path: string): Promise<number> => {
  const run = await $.process.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeoutMs: 15000 })
  const seconds = Number(run.stdout.trim())

  return run.exitCode === 0 && Number.isFinite(seconds) ? seconds : 0
}

// A PNG for the terminal to draw (png stays as is), and its pixel size
const imageFile = async ($: EngineInterface, path: string): Promise<{ file: string; width: number; height: number } | undefined> => {
  let file = path
  if (!/\.png$/i.test(path)) {
    file = `${MEDIA_CACHE}/${cacheName(path)}.png`
    await $.process.run(['mkdir', '-p', MEDIA_CACHE])
    if (!(await $.fs.exists(file))) {
      const made = await $.process.run(['sips', '-s', 'format', 'png', path, '--out', file], { timeoutMs: 30000 })
      if (made.exitCode !== 0) return undefined
    }
  }
  const info = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeoutMs: 15000 })
  const width = Number(/pixelWidth:\s*(\d+)/.exec(info.stdout)?.[1])
  const height = Number(/pixelHeight:\s*(\d+)/.exec(info.stdout)?.[1])

  return width > 0 && height > 0 ? { file, width, height } : undefined
}

const videoFrame = async ($: EngineInterface, path: string, at: number): Promise<string | undefined> => {
  const file = `${MEDIA_CACHE}/${cacheName(path)}_${Math.round(at)}.png`
  await $.process.run(['mkdir', '-p', MEDIA_CACHE])
  if (!(await $.fs.exists(file))) {
    const run = await $.process.run(['ffmpeg', '-y', '-v', 'error', '-ss', String(at), '-i', path, '-frames:v', '1', file], { timeoutMs: 30000 })
    if (run.exitCode !== 0) return undefined
  }

  return file
}

const stopAudio = async ($: EngineInterface): Promise<void> => {
  const pid = await read($, playPid)
  ticker?.cancel()
  ticker = undefined
  if (pid > 0) await $.process.run(['kill', String(pid)]).catch(() => undefined)
  await update($, playPid, () => 0)
}

const startAudio = async ($: EngineInterface, path: string, duration: number): Promise<void> => {
  await stopAudio($)
  // afplay reads the sound of mp4/mov/m4v itself; other containers get their audio pulled out into a cached m4a first
  let playable = path
  if (VIDEO_EXT.test(path) && !/\.(mp4|mov|m4v)$/i.test(path)) {
    playable = `${MEDIA_CACHE}/${cacheName(path)}.m4a`
    await $.process.run(['mkdir', '-p', MEDIA_CACHE])
    if (!(await $.fs.exists(playable))) {
      $.ui.toast('Extracting the audio...')
      const made = await $.process.run(['ffmpeg', '-y', '-v', 'error', '-i', path, '-vn', '-c:a', 'aac', playable], { timeoutMs: 600000 })
      if (made.exitCode !== 0) return $.ui.toast(`Could not extract the audio of ${path}`)
    }
  }
  const run = await $.process.run(['sh', '-c', 'afplay "$1" >/dev/null 2>&1 & echo $!', 'sh', playable], { timeoutMs: 10000 })
  const pid = Number(run.stdout.trim())
  if (!(pid > 0)) return $.ui.toast(`Could not play ${path}`)
  await update($, playPid, () => pid)
  await update($, playStart, () => Date.now())
  await update($, playDuration, () => duration)
  // Redraw once a second for the elapsed time; stop the bookkeeping when the clip has run its length
  ticker = $.clock.every(1000, async () => {
    if (duration > 0 && Date.now() - (await read($, playStart)) > duration * 1000 + 500) await stopAudio($)
    else await update($, tick, n => n + 1)
  })
}

// A picture as cells: each cell is a braille glyph (2x4 dots) coloured with the bright dots' average on the average of the dark ones,
// which is four times the detail of half-blocks in the same space
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

const pictureCells = async ($: EngineInterface, file: string, columns: number, rows: number): Promise<string | undefined> => {
  const wide = columns * 2
  const tall = rows * 4
  const raw = `${MEDIA_CACHE}/${cacheName(file)}_${wide}x${tall}.rgb`
  if (!(await $.fs.exists(raw))) {
    const run = await $.process.run(
      ['ffmpeg', '-y', '-v', 'error', '-i', file, '-vf', `scale=${wide}:${tall}:flags=lanczos`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw],
      { timeoutMs: 30000 },
    )
    if (run.exitCode !== 0) return undefined
  }
  const { base64 } = await $.fs.read(raw, { as: 'bytes' })
  const rgb = Uint8Array.fromBase64(base64)
  const cells = new Uint32Array(columns * rows * 3)
  const pack = (r: number, g: number, b: number): number => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      const dots: { x: number; y: number; r: number; g: number; b: number; lum: number }[] = []
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 2; x++) {
          const i = ((cy * 4 + y) * wide + cx * 2 + x) * 3
          const r = rgb[i] ?? 0
          const g = rgb[i + 1] ?? 0
          const b = rgb[i + 2] ?? 0
          dots.push({ x, y, r, g, b, lum: 0.299 * r + 0.587 * g + 0.114 * b })
        }
      }
      const mean = dots.reduce((n, d) => n + d.lum, 0) / dots.length
      const lit = dots.filter(d => d.lum >= mean)
      const dark = dots.filter(d => d.lum < mean)
      const avg = (group: typeof dots): number => {
        const n = Math.max(1, group.length)

        return pack(group.reduce((t, d) => t + d.r, 0) / n, group.reduce((t, d) => t + d.g, 0) / n, group.reduce((t, d) => t + d.b, 0) / n)
      }
      const k = (cy * columns + cx) * 3
      if (dark.length === 0) {
        // flat cell: a blank braille on the average colour
        cells[k] = 0x2800
        cells[k + 1] = avg(lit)
        cells[k + 2] = avg(lit)
      } else {
        cells[k] = 0x2800 + lit.reduce((bits, d) => bits | (BRAILLE_BITS[d.y]?.[d.x] ?? 0), 0)
        cells[k + 1] = avg(lit)
        cells[k + 2] = avg(dark)
      }
    }
  }

  return new Uint8Array(cells.buffer).toBase64()
}

export const register: Register = (on, options) => {
  on('turn.complete', async ($, e, next) => {
    void refreshRepos($)

    return next(e)
  })

  on('command.run', { command: 'repos' }, async $ => {
    await refreshRepos($)
    const placed = await $.ui.open({ id: REPOS_PANE, title: 'Repos', focus: true })

    return { text: placed.isPlaced ? 'Repos tab opened.' : `Repos tab not shown: ${placed.reason}` }
  })

  on('state.set', { plugin: 'filetree', key: 'tree' }, async ($, e, next) => {
    const done = await next(e)
    const picked = e.value.selected
    if (picked && picked !== e.previous?.selected) {
      await update($, target, () => '')
      await stopAudio($)
      await update($, videoPos, () => 0)
      if ((await read($, mode)) === 'repos') await update($, mode, () => 'diff')
      await update($, col, () => 0)
      await update($, row, () => 0)
      if (await read($, auto)) void show($)
    }

    return done
  })

  // filetree opens a double-clicked file with `open -- <path>` (macOS); swap it for a no-op and show the pane instead
  on('process.run', async ($, e, next) => {
    if (e.argv[0] !== 'open' || e.argv[1] !== '--' || e.argv.length !== 3) return next(e)
    void show($)

    return next({ ...e, argv: ['true'] })
  })

  on('command.run', { command: 'view' }, async ($, e) => {
    if (e.args.trim() === 'single') {
      const next = !(await read($, single))
      await update($, single, () => next)

      return { text: `Single tab: ${next ? 'on (the viewer replaces the file tree, closing it brings the tree back)' : 'off'}.` }
    }
    if (e.args.trim() === 'auto') {
      const next = !(await read($, auto))
      await update($, auto, () => next)

      return { text: `Auto-open on file select: ${next ? 'on' : 'off'}.` }
    }
    // `/view path[:line]` shows that file; relative paths resolve against the filetree root
    const given = e.args.trim().replace(/:\d+(:\d+)?$/, '')
    if (given) {
      const root = (await read($, TREE))?.root ?? ''
      const full = given.startsWith('/') ? given : `${root.replace(/\/$/, '')}/${given.replace(/^\.\//, '')}`
      if (!(await $.fs.exists(full))) return { text: `File not found: ${full}` }
      await update($, target, () => full)
      await update($, col, () => 0)
      await update($, row, () => 0)
      await show($)

      return { text: `File viewer: ${full}` }
    }
    await show($)

    return { text: 'File viewer opened. Select a file in filetree, or run /view <path>.' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === VIEWER_PANE) {
      await update($, isOpen, () => false)
      // Closing the viewer in single-tab mode hands the tab back to the file tree
      if (await read($, single)) {
        const t = await read($, TREE)
        const folder = (t?.root ?? '').split('/').pop() || t?.root || ''
        void $.ui.open({ id: 'filetree', title: `Files: ${folder}` }).catch(() => undefined)
      }
    }

    return closed
  })

  // The wheel and arrow keys: the engine would scroll the header away, so move our own rows instead and leave its window alone
  on('ui.scroll', { component: 'Pane', requestId: VIEWER_PANE }, async ($, e) => {
    const rows = e.pointer ? e.by * WHEEL_ROWS : e.by
    await update($, row, current => Math.max(0, Math.min(current + rows, lastMaxRow)))

    return {}
  })

  // The repos' branches under filetree's own tree ("Files: <folder>"). filetree sizes its rows from scroll.bodyRows, so give it
  // that much less room, then draw our block under what it returns.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const rows = await read($, repos)
    if (e.surface !== 'terminal' || rows.length < 2) return next(e)

    const taken = rows.length + 1
    const inner = await next({ ...e, props: { ...e.props, scroll: { ...e.props.scroll, bodyRows: Math.max(5, e.props.scroll.bodyRows - taken) } } })
    const { Box, Text, Button } = $.ui.resolve(e)
    const nameWidth = rows.reduce((n, r) => Math.max(n, r.name.length), 0)

    return (
      <Box flexDirection="column">
        {inner}
        <Text dimColor>{'─'.repeat(Math.max(8, e.props.bodyColumns))}</Text>
        {rows.map(r => (
          <Box>
            <Text wrap="truncate-end">{r.name.padEnd(nameWidth)} </Text>
            <Text wrap="truncate-end" color={BASE_BRANCHES.has(r.branch) ? undefined : 'yellow'} dimColor={BASE_BRANCHES.has(r.branch)}>
              {r.branch}
            </Text>
            {r.dirty > 0 && <Text color="red"> ●{r.dirty}</Text>}
            {r.ahead > 0 && <Text color="green"> ↑{r.ahead}</Text>}
            {r.behind > 0 && <Text color="cyan"> ↓{r.behind}</Text>}
            {r.behind > 0 && <Text> </Text>}
            {r.behind > 0 && <Button key={`pull-${r.name}`} plain label="pull" onPress={() => void gitAction($, r, 'pull')} />}
            {r.ahead > 0 && <Text> </Text>}
            {r.ahead > 0 && <Button key={`push-${r.name}`} plain label="push" onPress={() => void gitAction($, r, 'push')} />}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: REPOS_PANE }, async ($, e) => reposView($, e, '', false))

  on('ui.render', { component: 'Pane', requestId: VIEWER_PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Markdown, Raster, Image } = $.ui.resolve(e)
    const t = await read($, TREE)
    const chosen = await read($, mode)
    const path = (await read($, target)) || (t?.selected ?? '')
    const isMermaid = /\.(mmd|mermaid)$/i.test(path)
    const isRenderable = isMermaid || /\.(md|markdown|mdx)$/i.test(path)
    const view = chosen === 'rendered' && !isRenderable ? 'file' : chosen

    if (chosen === 'repos' || !path) return reposView($, e, path, true)

    const mediaKind = IMAGE_EXT.test(path) ? 'image' : AUDIO_EXT.test(path) ? 'audio' : VIDEO_EXT.test(path) ? 'video' : undefined
    if (mediaKind) {
      const name = t && path.startsWith(t.root) ? path.slice(t.root.length).replace(/^\//, '') : path
      const pid = await read($, playPid)
      const started = await read($, playStart)
      await read($, tick)
      const duration = mediaKind === 'image' ? 0 : await mediaDuration($, path)
      const at = Math.max(0, Math.min(await read($, videoPos), Math.max(0, duration - 1)))
      const isPlaying = pid > 0
      const elapsed = isPlaying ? Math.min(duration || Infinity, (Date.now() - started) / 1000) : 0
      const seek = (to: number) => void update($, videoPos, () => Math.max(0, Math.min(to, Math.max(0, duration - 1))))
      const room = Math.max(3, (e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 30) - CHROME_ROWS) - HEADER_ROWS + EXTRA_ROWS - 3)
      const columns = Math.max(10, Math.min(e.props.bodyColumns ?? 80, 255))

      let picture: RenderNode = <Text dimColor> </Text>
      if (mediaKind !== 'audio') {
        const source = mediaKind === 'image' ? await imageFile($, path) : await (async () => {
          const frame = await videoFrame($, path, at)

          return frame ? imageFile($, frame) : undefined
        })()
        if (!source) picture = <Text dimColor>Cannot draw this {mediaKind} (needs sips/ffmpeg).</Text>
        else {
          // half-block cells make a cell column 1 pixel wide and 2 tall: fit the picture in the room, keeping its proportions
          let cols = Math.min(columns, 512)
          let rows = Math.max(1, Math.round((cols * source.height) / source.width / 2))
          if (rows > room) {
            rows = room
            cols = Math.max(1, Math.min(512, Math.floor((rows * 2 * source.width) / source.height)))
          }
          if (await supportsImages($)) {
            // the terminal draws the real picture; a cell is about twice as tall as wide
            const realCols = Math.min(255, Math.min(columns, Math.floor((room * 2 * source.width) / source.height)))
            const realRows = Math.max(1, Math.min(255, Math.round((realCols * source.height) / source.width / 2)))
            picture = <Image source={{ file: source.file, format: 'png' }} columns={realCols} rows={realRows} alt={name} />
          } else {
          const cells = await pictureCells($, source.file, cols, Math.min(rows, 256))
          picture = cells ? <Raster key="media-picture" columns={cols} rows={Math.min(rows, 256)} cells={cells} /> : <Text dimColor>Cannot draw this {mediaKind} (needs ffmpeg).</Text>
          }
        }
      } else if (duration > 0) {
        const filled = Math.round((Math.min(elapsed, duration) / duration) * 30)
        picture = <Text>{'█'.repeat(filled) + '░'.repeat(30 - filled)}</Text>
      }

      return (
        <Box flexDirection="column">
          <Box>
            {mediaKind !== 'image' && !isPlaying && <Button label="▶ Play" hotkey="p" onPress={() => void startAudio($, path, duration)} />}
            {mediaKind !== 'image' && isPlaying && <Button label="■ Stop" hotkey="x" onPress={() => void stopAudio($)} />}
            {mediaKind !== 'image' && <Text> </Text>}
            {mediaKind === 'video' && <Button label="◀ 5s" hotkey="h" onPress={() => seek(at - VIDEO_STEP)} />}
            {mediaKind === 'video' && <Text> </Text>}
            {mediaKind === 'video' && <Button label="5s ▶" hotkey="l" onPress={() => seek(at + VIDEO_STEP)} />}
            {mediaKind === 'video' && <Text> </Text>}
            <Button label="Open" hotkey="o" onPress={() => void $.process.run(['open', path])} />
            {mediaKind !== 'audio' && <Text> </Text>}
            {mediaKind !== 'audio' && (
              <Button label="Quick Look" hotkey="q" onPress={() => void $.process.run(['sh', '-c', 'qlmanage -p "$1" >/dev/null 2>&1 &', 'sh', path])} />
            )}
            <Text> </Text>
            <Button label="Repos" hotkey="r" onPress={() => void update($, mode, () => 'repos')} />
            <Text dimColor>
              {' '}
              {name} · {mediaKind}
              {mediaKind === 'video' ? ` · ${clock(at)} / ${clock(duration)}` : ''}
              {mediaKind === 'audio' ? ` · ${isPlaying ? `${clock(elapsed)} / ` : ''}${clock(duration)}` : ''}
            </Text>
          </Box>
          {picture}
          {Array.from({ length: SPACER_ROWS }, () => (
            <Text> </Text>
          ))}
        </Box>
      )
    }

    let body = ''
    let isDiff = false
    try {
      if (view === 'diff') {
        const dir = parentDir(path)
        const run = await $.process.run(['git', '-C', dir, 'diff', 'HEAD', '--no-color', '--', path])
        if (run.exitCode === 0 && run.stdout.trim()) {
          body = run.stdout
          isDiff = true
        }
      }
      if (!isDiff) body = await $.fs.read(path)
    } catch (err) {
      return <Text dimColor>Cannot show {path}: {String(err)}</Text>
    }

    const note =
      view === 'diff' && !isDiff ? 'no changes vs HEAD (or untracked): showing full file' : isDiff ? 'diff vs HEAD' : view === 'rendered' ? 'rendered' : 'full file'
    const cut = body.length > MAX_CHARS
    const source = cut ? body.slice(0, MAX_CHARS) : body
    const name = t && path.startsWith(t.root) ? path.slice(t.root.length).replace(/^\//, '') : path

    // Rows of text to scroll through. Vertical scroll is the mod's own (the engine would scroll the header away): only a window of
    // rows is drawn, under a header that stays put. File and diff rows are exact; prose rows are estimated from the pane width.
    const width = e.props.bodyColumns ?? 80
    const room = Math.max(10, width - GUTTER)
    // The engine's own window height. The spacer rows below keep the tree taller than it, so it cannot shrink with our window.
    const budget = Math.max(3, (e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 30) - CHROME_ROWS) - HEADER_ROWS + EXTRA_ROWS)
    const segments: Segment[] = view !== 'rendered' ? [] : isMermaid ? [{ kind: 'mermaid', text: source }] : splitBlocks(source)
    const drawn = await Promise.all(segments.map(s => (s.kind === 'mermaid' ? drawDiagram($, s.text) : Promise.resolve(s.kind === 'table' ? formatTable(s.text) : s.text))))
    const lines = source.split('\n')

    // Widest line that scrolls sideways (prose wraps instead)
    const wide = view === 'rendered' ? drawn.filter((_, i) => segments[i]?.kind !== 'markdown').flatMap(d => d.split('\n')) : lines
    const maxOffset = Math.max(0, wide.reduce((n, l) => Math.max(n, l.length), 0) - room)
    const offset = Math.min(await read($, col), maxOffset)
    const slice = (line: string): string => (isDiff ? (line.startsWith('@@') || line.length === 0 ? line : line[0] + line.slice(1 + offset)) : line.slice(offset))

    type Item = { rows: number; node: RenderNode }
    const items: Item[] = []
    if (view === 'rendered') {
      segments.forEach((seg, i) => {
        const text = drawn[i] ?? ''
        if (seg.kind === 'markdown') {
          for (const para of text.split(/\n\s*\n/)) {
            if (para.trim() === '') continue
            const rows = para.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / width)), 1)
            items.push({ rows, node: <Markdown text={para} /> })
          }
        } else {
          text.split('\n').forEach((row, n) => {
            const shown = slice(row) === '' ? ' ' : slice(row)
            items.push({
              rows: 1,
              node: seg.kind === 'code' ? <Code source={shown} language={seg.language || undefined} wrap="truncate-end" /> : <Text wrap="truncate-end" bold={seg.kind === 'table' && n === 1}>{shown}</Text>,
            })
          })
        }
      })
    }
    const total = view === 'rendered' ? items.reduce((n, it) => n + it.rows, 0) : lines.length
    const maxRow = Math.max(0, total - budget)
    lastMaxRow = maxRow
    const top = Math.min(await read($, row), maxRow)

    let content = <Code source={lines.slice(top, top + budget).map(slice).join('\n')} path={path} startLine={top + 1} wrap="truncate-end" />
    if (isDiff) {
      content = (
        <Box flexDirection="column">
          {lines.slice(top, top + budget).map(line => (
            <Text wrap="truncate-end" color={line.startsWith('@@') ? 'cyan' : line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : undefined}>
              {slice(line) === '' ? ' ' : slice(line)}
            </Text>
          ))}
        </Box>
      )
    } else if (view === 'rendered') {
      const visible: RenderNode[] = []
      let seen = 0
      for (const it of items) {
        if (seen + it.rows > top && seen < top + budget) visible.push(it.node)
        seen += it.rows
      }
      content = <Box flexDirection="column">{visible}</Box>
    }

    const moveTo = (to: number) => void update($, col, () => Math.max(0, Math.min(to, maxOffset)))
    const moveRow = (to: number) => void update($, row, () => Math.max(0, Math.min(to, maxRow)))

    return (
      <Box flexDirection="column">
        <Box>
          <Button label="Diff" hotkey="d" onPress={() => void update($, mode, () => 'diff')} />
          <Text> </Text>
          <Button label="File" hotkey="f" onPress={() => void update($, mode, () => 'file')} />
          {isRenderable && <Text> </Text>}
          {isRenderable && <Button label="Preview" hotkey="p" onPress={() => void update($, mode, () => 'rendered')} />}
          <Text> </Text>
          <Button label="Repos" hotkey="r" onPress={() => void update($, mode, () => 'repos')} />
          <Text> </Text>
          <Button label="▲" hotkey="w" onPress={() => moveRow(top - budget)} />
          <Text> </Text>
          <Button label="▼" hotkey="s" onPress={() => moveRow(top + budget)} />
          {maxOffset > 0 && (
            <Box>
              <Text> </Text>
              <Button label="|◀" hotkey="0" onPress={() => moveTo(0)} />
              <Text> </Text>
              <Button label="◀" hotkey="h" onPress={() => moveTo(offset - SCROLL_STEP)} />
              <Text> </Text>
              <Button label="▶" hotkey="l" onPress={() => moveTo(offset + SCROLL_STEP)} />
            </Box>
          )}
          <Text dimColor> {name} · {note}{cut ? ' · truncated' : ''} · {Math.min(top + 1, total)}-{Math.min(top + budget, total)}/{total}{offset > 0 ? ` · col ${offset + 1}` : ''}</Text>
        </Box>
        <Text dimColor>{e.props.isFocused ? 'wheel/arrows scroll, w/s pages, h/l sideways' : 'click inside this pane to focus it'}</Text>
        {content}
        {Array.from({ length: SPACER_ROWS }, () => (
          <Text> </Text>
        ))}
      </Box>
    )
  })

  glyphSetting = typeof options?.glyphs === 'string' ? options.glyphs : 'auto'
  const activity = typeof options?.activity === 'string' ? options.activity : 'reads and writes'
  showReads = activity.includes('reads')
  showWrites = activity.includes('writes')
  followClaude = options?.follow !== 'off'
  accordion = options?.accordion !== 'off'
  pinRoot = options?.root !== 'cwd'
  showBranch = options?.branch === 'on'
  sizeDefault = options?.column === 'size'
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'view',
      description: 'Open the file viewer; "/view <path>" shows a file, "/view auto" toggles opening it when a file is selected in filetree, "/view single" keeps one tab open',
    })
    await $.command.register({ name: 'repos', description: 'Open the Repos tab: every repo in this folder with its branch and changes' })
    await refreshRepos($)
    $.clock.every(REFRESH_MS, () => void refreshRepos($))
    await $.command.register({ name: 'filetree', description: 'Show the file tree; args: [path] (no path = cwd)' })
    const windows = (await $.env.get('OS')) === 'Windows_NT'
    useDrives(windows)
    home = posix(((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '').replace(/[\\/]+$/, ''))
    activityId = Math.max(activityId, ...(await activities($)).map(a => a.id))
    void (async () => {
      pointer = await finePointerOk($)
      try {
        const remote = Boolean((await $.env.get('SSH_CONNECTION')) || (await $.env.get('SSH_TTY')))
        noNerd = !remote && (windows || (await fontState($, 'f04eb')) !== 'ok')
      } catch {
        noNerd = true
      }
      await loadTheme($)
      themePoll?.cancel()
      themePoll = themeMtime ? $.clock.every(THEME_POLL_MS, () => void loadTheme($)) : null
      const t = await get($)
      if (t.flashOn) await patch($, () => ({ flash: [], flashDim: [], flashOn: false, flashTones: {} }))
      await setActivities($, cur => cur.map(a => (a.state === 'running' ? { ...a, state: 'failed', label: `${a.kind} interrupted` } : a)))
      const cwd = await cwdOf($)
      if (!t.root || t.nodes.length === 0 || (follow && t.root !== cwd)) await reset($, cwd)
      else if (!noDock) await $.ui.open({ id: PANE, title: `Files: ${t.root.split('/').pop() || t.root}` })
      if (!noDock) await $.ui.open({ id: REPOS_PANE, title: 'Repos' })
    })()
    return next(e)
  })

  on('command.run', { command: 'filetree' }, async ($, e) => {
    if (!e.presentation.isFullscreen) return { text: 'filetree shows in the sidebar, which needs the fullscreen layout. Run /tui fullscreen, then /filetree.' }
    if (e.presentation.columns < 110) return { text: 'filetree shows in the sidebar, which needs a terminal at least 110 columns wide. Widen it, then run /filetree.' }
    noDock = false
    const arg = (e.args ?? '').trim()
    const cwd = await cwdOf($)
    follow = !arg
    const root = arg ? resolve(cwd, arg, home) : cwd
    await reset($, root, true)
    return { text: `File tree on ${shortPath(root)}${follow ? ' (follows the cwd)' : ''}.` }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Edit' && e.tool !== 'Write' && e.tool !== 'NotebookEdit' && e.tool !== 'Bash') return next(e)
    const command = e.tool === 'Bash' ? e.command : ''
    const cwd = e.tool === 'Bash' ? await cwdOf($) : ''
    const actions = gitActions(command)
    const quiet = !actions.length && readOnly(command)
    const since = await sinceNow($, e.tool === 'Bash' && !quiet)
    const before = actions.some(a => a.verb === 'commit') ? await get($) : null
    const head = before?.top ? await headOf($, before.root) : ''
    const pending: Pending | null = actions.length ? { actions, ids: await startGit($, actions), command, head } : null
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } catch (err) {
      if (pending) await finishGit($, pending, failAll(pending))
      if (since.mark) void $.process.run(['rm', '-f', since.mark], { timeoutMs: 3_000 }).catch(() => undefined)
      throw err
    }
    if (pending && result.deny) {
      const ids = pending.ids
      void setActivities($, cur => cur.filter(a => !ids.includes(a.id)))
    }
    if (result.deny || (result.isError && e.tool !== 'Bash')) {
      if (since.mark) void $.process.run(['rm', '-f', since.mark], { timeoutMs: 3_000 }).catch(() => undefined)
      return result
    }
    if (e.tool === 'Bash') {
      const out: Partial<BuiltinToolResults['Bash']> = !result.isError && result.result && typeof result.result === 'object' ? result.result : {}
      const reads = showReads ? readTargets(command, cwd, typeof out.stdout === 'string' ? out.stdout : '', home) : []
      const job: Job = { actions: [], since, initRepo: actions.some(a => a.init), readOnly: quiet || result.isReadOnly === true }
      if (out.backgroundTaskId) background.set(out.backgroundTaskId, { p: pending, job, reads })
      else void (async () => {
        const results = pending ? await outcomes($, pending, !result.isError, out.gitOperation) : []
        if (pending) await finishGit($, pending, results)
        queuedReads.push(...reads)
        scheduleScan($, { ...job, actions: proven(pending, results) })
      })()
      if (follow && /(^|[;&|\s])(cd|pushd|popd)(\s|$)/.test(command)) $.clock.after(400, () => void followCwd($))
    } else {
      const file =
        'file_path' in e && typeof e.file_path === 'string'
          ? e.file_path
          : 'notebook_path' in e && typeof e.notebook_path === 'string'
            ? e.notebook_path
            : ''
      if (file) void touched($, [file], 'orange', showWrites)
    }
    return result
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny || result.isError || e.tool !== 'Read' || !showReads) return result
    void touched($, [posix(e.file_path)], 'purple', true)
    return result
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'rows' || !e.data || typeof e.data !== 'object') return next(e)
    const data = e.data as { press?: unknown; key?: unknown; ctrl?: unknown; shift?: unknown; scrollTo?: unknown; copy?: unknown }
    void sync($)
    const t = await get($)
    if (typeof data.copy === 'string') {
      await copyPath($, data.copy, Boolean(data.shift), e.surface)
      return {}
    }
    if (typeof data.scrollTo === 'number') {
      const to = Math.round(Math.max(0, Math.min(1, data.scrollTo)) * view.max)
      if (to !== t.scroll) await patch($, () => ({ scroll: to }))
      return {}
    }
    if (typeof data.press === 'string') {
      const n = t.nodes.find(x => x.id === data.press)
      if (!n) return {}
      if (t.scroll === null) await patch($, () => ({ scroll: view.from }))
      if (data.ctrl || data.shift) await openNode($, n)
      else await press($, n)
      return {}
    }
    if (typeof data.key !== 'string') return {}
    const rows = visibleRows(t)
    const at = rows.findIndex(r => r.node.id === t.cursor)
    const cur = rows[at]?.node
    const move = (d: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + d))]
      return target ? patch($, () => ({ cursor: target.node.id, scroll: null })) : Promise.resolve()
    }
    if (data.key === 'up' || data.key === 'k') await move(-1)
    else if (data.key === 'down' || data.key === 'j') await move(1)
    else if (data.key === 'pageup') await move(-10)
    else if (data.key === 'pagedown') await move(10)
    else if (data.key === 'home') await move(-rows.length)
    else if (data.key === 'end') await move(rows.length)
    else if (cur && (data.key === 'y' || data.key === 'Y')) await copyPath($, cur.id, data.key === 'Y' || Boolean(data.shift), e.surface)
    else if (cur && (data.key === 'right' || data.key === 'l') && cur.kind === 'dir' && !t.expanded.includes(cur.id)) await toggle($, cur)
    else if (cur && (data.key === 'left' || data.key === 'h')) {
      if (cur.kind === 'dir' && t.expanded.includes(cur.id)) await toggle($, cur)
      else if (cur.parent !== t.root) await patch($, () => ({ cursor: cur.parent }))
    } else if (cur && data.key === 'return') await (cur.kind !== 'dir' ? openNode($, cur) : toggle($, cur))
    else if (cur && data.key === ' ') await toggle($, cur)
    return {}
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') {
      void (async () => {
        await loadTheme($)
        const root = follow || !lastRoot ? await cwdOf($) : lastRoot
        const t = await get($)
        if (t.root !== root || t.nodes.length === 0) await reset($, root)
      })()
    }
    const gd = await gitDir($, posix(e.cwd))
    return gd ? { ...result, watchPaths: [...(result.watchPaths ?? []), join(gd, 'index'), join(gd, 'HEAD')] } : result
  })

  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    void followCwd($)
    return result
  })

  on('classic.FileChanged', async ($, e, next) => {
    const result = await next(e)
    if (/[\\/]\.git[\\/]|[\\/](index|HEAD)$/.test(e.file_path)) $.clock.after(300, () => void sync($, true))
    return result
  })

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    void sync($)
    return result
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = await get($)
    const to = Math.max(0, Math.min(view.max, (t.scroll ?? view.from) + Math.sign(e.by) * Math.max(3, Math.abs(e.by))))
    if (to !== t.scroll) await patch($, () => ({ scroll: to }))
    return {}
  })

  on('prompt.submit', async ($, e, next) => {
    void settleBackground($, e.text)
    if (!(await followCwd($))) void sync($)
    const t = await get($)
    const context = [...(e.context ?? [])]
    if (t.selected && (await exists($, t.selected))) context.push(`The user has this file selected in the file tree; "this" or "it" in the prompt likely refers to it: ${t.selected}`)
    const mentions = [...e.text.matchAll(/@([^\s"'`]+)/g)]
      .map(m => (m[1] ?? '').replace(/[.,;:!?)]+$/, ''))
      .filter(Boolean)
      .map(p => resolve(t.root, p, home))
      .filter(p => inside(t.root, p))
    if (mentions.length) {
      void (async () => {
        const found: string[] = []
        for (const p of mentions) {
          try {
            await $.fs.stat(p)
            found.push(p.replace(/\/$/, ''))
          } catch {
            continue
          }
        }
        if (found.length) await reveal($, found)
      })()
    }
    return next(context.length ? { ...e, context } : e)
  })

  on('prompt.attachment', async ($, e, next) => {
    void settleBackground($, e.text)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    if (e.surface === 'terminal' && e.props.placement === 'inline') {
      noDock = true
      void $.ui.close({ id: PANE }).catch(() => undefined)
      const { Box: Empty } = $.ui.resolve(e)
      return <Empty />
    }
    const unicode = glyphSetting === 'plain' || (glyphSetting === 'auto' && (noNerd || e.surface === 'desktop'))
    const { Box, Text, Button, Input, Client } = $.ui.resolve(e)
    const t = await get($)
    const theme: Theme = (await $.state.get(THEME)).value ?? DEFAULT_THEME
    const now = await $.clock.now()
    const live = (await activities($)).filter(a => now - a.at < (a.state === 'running' ? RUNNING_MAX_MS : ACTIVITY_TTL_MS))
    const latest = [...live].reverse().find(a => a.state === 'running') ?? live[live.length - 1]
    const bright = new Set(t.flashOn ? t.flash : [])
    const dimmed = new Set(t.flashOn ? t.flashDim : [])
    const ignored = new Set(t.ignored)
    const untracked = new Set(t.untrackedDirs)
    const width = Math.max(24, e.props.bodyColumns)
    const rows = visibleRows(t)
    const fixed = 2 + (t.top ? (showBranch && t.branch ? 1 : 0) : 1) + (t.selected || latest ? 1 : 0)
    const room = Math.max(5, (e.props.scroll?.bodyRows ?? 40) - fixed)
    const isLit = (id: string) => bright.has(id) || dimmed.has(id)
    const focus = followClaude && t.flashOn ? ([...t.flash].reverse().find(id => id !== BRANCH_ROW) ?? t.cursor) : t.cursor
    const at = Math.max(0, rows.findIndex(r => r.node.id === focus))
    const lit = followClaude && t.flashOn ? rows.findIndex(r => isLit(r.node.id)) : -1
    const cap = Math.max(1, Math.floor(room / 3))
    let from = Math.max(0, Math.min(lit >= 0 && at - lit < room - 2 ? Math.max(0, lit - 1) : at - Math.floor(room / 2), rows.length - room))
    let pinned = followClaude && t.flashOn ? rows.slice(0, from).filter(r => isLit(r.node.id)).slice(-cap) : []
    if (pinned.length) {
      const rest = Math.max(3, room - pinned.length)
      from = Math.max(0, Math.min(at - Math.floor(rest / 2), rows.length - rest))
      pinned = rows.slice(0, from).filter(r => isLit(r.node.id)).slice(-cap)
    }
    const max = Math.max(0, rows.length - room)
    if (t.scroll !== null) {
      from = Math.max(0, Math.min(t.scroll, max))
      pinned = []
    }
    view = { from, max }
    const shown = rows.slice(from, from + room - pinned.length)
    if (t.showSize) wantSizes($, [...pinned, ...shown].filter(r => r.node.kind === 'dir' && !(r.node.id in t.dirSizes)).map(r => r.node.id))
    const totals: [number, number] = t.top ? (t.diff[t.root] ?? [0, 0]) : [0, 0]
    const countSegs = (c: [number, number, number] | undefined): Seg[] => {
      if (!c) return []
      const out: Seg[] = []
      if (c[0] > 0) out.push({ t: ` ?:${c[0]}`, c: GIT_COLOR['?'] ?? ADD_COLOR })
      if (c[1] > 0) out.push({ t: ` M:${c[1]}`, c: GIT_COLOR.M ?? '#e5c07b' })
      if (c[2] > 0) out.push({ t: ` D:${c[2]}`, c: theme.urgent })
      return out
    }
    const rootCounts = t.top ? countSegs(t.counts[t.root]) : []
    const header = t.top ? [t.top.split('/').pop() ?? t.top, t.prefix.replace(/\/$/, '')].filter(Boolean).join('/') : t.root.split('/').pop() || t.root

    const rowSpec = (r: (typeof rows)[number]): RowSpec => {
      const n = r.node
      const own = t.git[n.id]
      const status = own ?? (underAny(dirname(n.id), untracked, t.root) ? '?' : undefined)
      const isIgnored = !status && underAny(n.id, ignored, t.root)
      const gitColor = status === 'D' || status === 'U' ? theme.urgent : status ? (GIT_COLOR[status] ?? theme.muted) : undefined
      const isBright = bright.has(n.id)
      const isDim = !isBright && dimmed.has(n.id)
      const tone = t.flashTones[n.id] ?? 'orange'
      const iconColor = typeColor(n) ?? (isIgnored || n.hidden ? theme.muted : (gitColor ?? (n.kind === 'dir' ? theme.accent : theme.muted)))
      const nameColor = isIgnored ? theme.muted : (gitColor ?? (n.hidden ? theme.muted : theme.fg || undefined))
      const loc = t.diff[n.id]
      const meta = t.showSize
        ? n.kind === 'dir'
          ? n.id in t.dirSizes
            ? formatSize(t.dirSizes[n.id] ?? -1)
            : '…'
          : n.kind === 'file' || (n.kind === 'link' && n.size > 0)
            ? formatSize(n.size)
            : ''
        : loc
          ? ''
          : n.kind === 'file'
            ? stamp(n.mtime)
            : ''
      const locText = loc ? `${loc[0] ? ` +${loc[0]}` : ''}${loc[1] ? ` -${loc[1]}` : ''}` : ''
      const dirCounts = n.kind === 'dir' ? countSegs(t.counts[n.id]) : []
      const badge = dirCounts.length ? '' : status ? ` ${status}` : isIgnored ? (unicode ? ' ⊘' : ' \u{f05e}') : '  '
      const countsText = dirCounts.map(c => c.t).join('')
      const cols = Math.max(4, width - r.depth * 2 - 6 - (meta ? meta.length + 1 : 0) - locText.length - badge.length - countsText.length)
      const name = n.name.length > cols ? n.name.slice(0, cols - 1) + '…' : n.name
      const caret = n.kind === 'dir' ? (unicode ? (r.open ? '▾' : '▸') : r.open ? CHEVRON_OPEN : CHEVRON_CLOSED) + ' ' : '  '
      const isRepo = n.kind === 'dir' && n.id === t.top
      const glyph = unicode ? (n.kind === 'dir' ? '■' : '·') : fileIcon(n, r.open, isRepo)
      const lit = isBright || isDim
      const left: Seg[] = [
        { t: '  '.repeat(r.depth) },
        { t: caret, c: theme.muted },
        lit ? { t: glyph + ' ', sh: tone, dim: isDim, one: true } : { t: glyph + ' ', c: iconColor },
        lit ? { t: name, sh: tone, dim: isDim, b: isBright } : { t: name, c: nameColor, b: n.id === t.selected, s: status === 'D' && n.kind !== 'dir' },
      ]
      const right: Seg[] = []
      if (meta) right.push({ t: ` ${meta}`, c: theme.muted })
      if (loc && loc[0] > 0) right.push({ t: ` +${loc[0]}`, c: ADD_COLOR })
      if (loc && loc[1] > 0) right.push({ t: ` -${loc[1]}`, c: DEL_COLOR })
      right.push(...dirCounts)
      if (badge) right.push({ t: badge, c: status ? gitColor : theme.muted, b: true })
      return { id: n.id, left: clean(left), right: clean(right) }
    }

    const note = (text: string): RowSpec => ({ id: '', left: [{ t: text, c: theme.muted }], right: [] })
    const specs: RowSpec[] = [
      ...(rows.length === 0 ? [note('empty')] : []),
      ...pinned.map(rowSpec),
      ...(pinned.length > 0 ? [note('  ⋮')] : []),
      ...shown.map(rowSpec),
    ]
    const barSize = Math.max(1, Math.round((specs.length * shown.length) / Math.max(1, rows.length)))
    const bar =
      rows.length > shown.length + pinned.length
        ? { pos: max ? Math.round((from / max) * (specs.length - barSize)) : 0, size: barSize, thumb: theme.accent, track: theme.muted }
        : undefined

    const branchRow = () => {
      if (!showBranch || !t.top || !t.branch) return null
      const b = t.branch
      const isFlash = bright.has(BRANCH_ROW)
      const tone = t.flashTones[BRANCH_ROW] ?? 'teal'
      const label = b.head
      return (
        <Box flexDirection="row" height={1} overflow="hidden">
          <Box flexDirection="row" flexShrink={0}>
            <Text color={isFlash ? (TONES[tone]?.solid ?? theme.accent) : theme.accent}>{(unicode ? BRANCH_ICON.plain : BRANCH_ICON.nerd) + ' '}</Text>
            <Text bold color={isFlash ? (TONES[tone]?.solid ?? (theme.fg || undefined)) : theme.fg || undefined}>
              {label}
            </Text>
            {b.ahead > 0 && <Text color={TONES.teal?.solid}>{` ↑${b.ahead}`}</Text>}
            {b.behind > 0 && <Text color={TONES.blue?.solid}>{` ↓${b.behind}`}</Text>}
          </Box>
          {b.upstream && (
            <Box flexShrink={1} overflow="hidden">
              <Text color={theme.muted} wrap="truncate-end">
                {` ${b.upstream}`}
              </Text>
            </Box>
          )}
          <Box flexGrow={1} />
          <Box flexDirection="row" flexShrink={0}>
            {totals[0] > 0 && <Text color={ADD_COLOR}>{` +${totals[0]}`}</Text>}
            {totals[1] > 0 && <Text color={DEL_COLOR}>{` -${totals[1]}`}</Text>}
            {rootCounts.map(c => (
              <Text color={c.c}>{c.t}</Text>
            ))}
            {rootCounts.length === 0 && totals[0] === 0 && totals[1] === 0 && <Text color={theme.muted}> clean</Text>}
          </Box>
        </Box>
      )
    }

    const chip = (a: Activity) => {
      const tone = a.state === 'failed' ? 'red' : a.tone
      const color = TONES[tone]?.solid ?? theme.accent
      const icon = unicode ? a.plain : a.nerd
      const hash = a.state === 'done' && a.kind === 'git commit' ? a.detail.split(' ')[0] ?? '' : ''
      return (
        <Box flexDirection="row" marginLeft={2}>
          <Text color={color}>{icon + ' '}</Text>
          <Text bold={a.state === 'running'} color={color}>
            {a.state === 'running' ? `${a.label}…` : a.label}
          </Text>
          {hash && <Text color={theme.muted}>{` ${hash}`}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" minHeight={Math.max(1, e.props.scroll?.bodyRows ?? 1)} backgroundColor={theme.bg || undefined}>
        <Box flexDirection="row">
          <Text bold color={theme.accent} wrap="truncate-start">
            {header}
          </Text>
          <Box flexGrow={1} />
          <Box flexDirection="row" gap={2}>
            <Button
              key="up"
              plain
              dimColor
              label={unicode ? '↑' : '\u{f005d}'}
              onPress={() =>
                void (async () => {
                  follow = false
                  await reset($, dirname(t.root))
                })()
              }
            />
            <Button
              key="cwd"
              plain
              dimColor={!follow}
              label={unicode ? '⌂' : '\u{f02dc}'}
              onPress={() =>
                void (async () => {
                  follow = true
                  await reset($, await cwdOf($))
                })()
              }
            />
            <Button
              key="refresh"
              plain
              dimColor
              label={unicode ? '↻' : '\u{f0450}'}
              onPress={() =>
                void (async () => {
                  const cur = await get($)
                  searchIndex = null
                  await staleSizes($)
                  await loadDirs($, [cur.root, ...cur.expanded])
                  await detectRepo($)
                  await refreshGit($)
                  await refreshRepos($)
                  const synced = await read($, repos)
                  $.ui.toast(`Synced ${synced.length} repos: ${synced.map(r => `${r.name} (${r.branch})`).join(', ')}`)
                  if (cur.query.trim()) await search($, cur.query)
                })()
              }
            />
            <Button
              key="hidden"
              plain
              dimColor={!t.showHidden}
              label={unicode ? (t.showHidden ? '◉' : '○') : t.showHidden ? '\u{f0208}' : '\u{f0209}'}
              onPress={() => void patch($, cur => ({ showHidden: !cur.showHidden }))}
            />
            <Button
              key="size"
              plain
              dimColor={!t.showSize}
              label={unicode ? 'Σ' : '\u{f02ca}'}
              onPress={() => void patch($, cur => ({ showSize: !cur.showSize }))}
            />
            <Button key="collapse" plain dimColor label={unicode ? '⊟' : '\u{eac5}'} onPress={() => void patch($, cur => ({ expanded: [], nodes: dropBelow(cur.nodes, cur.nodes.filter(x => x.parent === cur.root && x.kind === 'dir').map(x => x.id)) }))} />
            {t.selected && (
              <Button key="unselect" plain label={unicode ? '⊘' : '\u{f0777}'} onPress={() => void patch($, () => ({ selected: '' }))} />
            )}
            <Text> </Text>
          </Box>
        </Box>
        {branchRow()}
        {!t.top && <Text color={theme.muted}>{unicode ? '± ' : '\u{e702} '}no git repo · git status starts after git init</Text>}
        <Box flexDirection="row">
          <Box flexGrow={1}>
            <Input
              key="q"
              label="/ "
              placeholder="search"
              submitLabel="jump"
              autoFocus
              value={t.query}
              onInput={(v: string) => void search($, v)}
              onSubmit={(v: string) => void jump($, v)}
            />
          </Box>
          {t.query ? <Button key="clear" plain dimColor label={unicode ? '×' : '\u{f0156}'} onPress={() => void search($, '')} /> : null}
        </Box>
        <Client
          key="rows"
          module="./rows.tsx"
          props={{ rows: specs, active: t.cursor, activeBg: theme.selection, hoverBg: faint(theme.selection), tones: SHIMMER, pointer, ...(bar ? { bar } : {}) } satisfies RowsProps}
        />
        <Box flexGrow={1} />
        {(t.selected || latest) && (
          <Box flexDirection="row">
            {t.selected ? (
              <Box flexShrink={1}>
                <Text dimColor wrap="truncate-start">
                  selected: {t.selected !== t.root && inside(t.root, t.selected) ? t.selected.slice(t.root.endsWith('/') ? t.root.length : t.root.length + 1) : shortPath(t.selected)}
                </Text>
              </Box>
            ) : null}
            <Box flexGrow={1} />
            {latest && chip(latest)}
          </Box>
        )}
      </Box>
    )
  })
}
