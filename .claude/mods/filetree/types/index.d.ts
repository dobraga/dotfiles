export type FileNode = {
  id: string
  parent: string
  name: string
  kind: 'dir' | 'file' | 'link'
  hidden: boolean
  mtime: number
  size: number
  loaded: boolean
}

export type Branch = {
  head: string
  upstream: string
  ahead: number
  behind: number
}

export type Activity = {
  id: number
  kind: string
  label: string
  state: 'running' | 'done' | 'failed'
  detail: string
  at: number
  tone: string
  nerd: string
  plain: string
}

export type FileTree = {
  root: string
  nodes: FileNode[]
  expanded: string[]
  cursor: string
  selected: string
  query: string
  showHidden: boolean
  showSize: boolean
  dirSizes: Record<string, number>
  git: Record<string, string>
  diff: Record<string, [number, number]>
  ignored: string[]
  untrackedDirs: string[]
  top: string
  prefix: string
  branch: Branch | null
  counts: Record<string, [number, number, number]>
  scroll: number | null
}

export type Theme = {
  fg: string
  accent: string
  muted: string
  urgent: string
  selection: string
  bg: string
}

export type ViewMode = 'diff' | 'file' | 'rendered' | 'repos'

export type RepoRow = {
  name: string
  path: string
  branch: string
  dirty: number
  ahead: number
  behind: number
}

// ---- Flightdeck types (ported from scasella/claude-flightdeck, MIT) ----
export type Moment = 'before a plan' | 'error repeats' | 'before done'

export type Bucket = 'file' | 'shell' | 'other'

/** rule: settings allowed it. ask: put to the decider, outcome pending. cleared: asked, then ran. deny: refused. */
export type Verdict = 'rule' | 'ask' | 'cleared' | 'deny'

export type Main = {
  model: string
  effort: string
  mode: string
  steps: number
  isRunning: boolean
  /** The main loop's last answered request: time to its first piece of response, and output tokens
   *  per second from that piece to the stop. Null until one is measured, absent in older state. */
  speed?: { ttftMs: number; tokPerS: number | null } | null
}

export type Usage = {
  pct: number | null
  tokens: number | null
  window: number
  costUsd: number | null
  /** `resetsAt`: when the window resets, in ms since the epoch; null when the API gave no time,
   *  absent in state saved before it was kept. */
  limits: { kind: string; pct: number; resetsAt?: number | null }[]
  compactions: number
  lastCompactAt: number | null
}

export type Consult = { id: string; at: number; endAt: number | null; moment: Moment; via: string }

export type Architect = { consults: Consult[]; ids: string[]; seen: string[]; lastAdvice: string }

export type Check = {
  id: string
  tool: string
  bucket: Bucket
  verdict: Verdict
  inSubagent: boolean
  detail: string
  at: number
}

export type Tally = { rule: number; ask: number; cleared: number; deny: number }

export type Gate = { recent: Check[]; totals: Record<Bucket, Tally> }

/** A background shell or monitor seen starting; `endedAt` is null while it runs. */
export type BgTask = {
  id: string
  kind: 'shell' | 'monitor'
  label: string
  startedAt: number
  endedAt: number | null
  status: string
}

/** A file Claude read, wrote or touched with git, as the Flightdeck `files` panel lists it. `verb` is the git verb for kind 'git'. */
export type FileEvent = {
  path: string
  kind: 'read' | 'write' | 'git'
  verb: string
  at: number
}

export type ToolNote = { tool: string; text: string; isError: boolean }

export type AgentCard = {
  id: string
  type: string
  model: string
  description: string
  status: string
  spawnedAt: number
  endedAt: number | null
  /** The agent's context now: input + cache read + cache write of its latest step. */
  ctx: number
  /** Output tokens summed over its steps. */
  out: number
  steps: number
  lastStop: string | null
  tools: ToolNote[]
  answer: string
}

/** A model loop whose id matches no card: a workflow agent, a compaction or a memory fork. */
export type Loop = { id: string; steps: number; firstAt: number; lastAt: number; isDone: boolean }

export type LogLine = {
  at: number
  who: string
  text: string
  agentId: string | null
  kind: 'info' | 'error' | 'consult' | 'done'
}

export type Turn = {
  edits: number
  errorStreak: number
  errors: number
  isReviewing: boolean
  startedAt: number
  costAtStart: number | null
}

export type Receipt = {
  durationMs: number
  agents: number
  edits: number
  errors: number
  costDelta: number | null
  reason: string
}

export type Layout = 'auto' | 'compact' | 'wide' | 'mini'

export type View = { expanded: string | null; gateOpen: Bucket | null; layout: Layout | null }

export type Roster = { architectTypes: string[] }

declare module 'claude-code' {
  interface PluginState {
    filetree: {
      tree: FileTree
      theme: Theme
      activity: Activity[]
      // file viewer (merged into hooks/register.tsx)
      mode: ViewMode
      repoPick: string
      repoFile: string
      allRepos: boolean
      auto: boolean
      single: boolean
      isOpen: boolean
      target: string
      col: number
      row: number
      repos: RepoRow[]
      playPid: number
      playStart: number
      playDuration: number
      videoPos: number
      tick: number
      // Flightdeck tab (ported from scasella/claude-flightdeck)
      fdMeta: { schemaVersion: number }
      fdMain: Main
      fdUsage: Usage
      fdArchitect: Architect
      fdGate: Gate
      fdAgents: AgentCard[]
      fdLoops: Loop[]
      fdTasks: BgTask[]
      fdFiles: FileEvent[]
      fdLog: LogLine[]
      fdTurn: Turn
      fdReceipt: Receipt | null
      fdView: View
      fdRoster: Roster
    }
  }
}
