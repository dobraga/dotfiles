// Flightdeck state: atoms, readers that tolerate older shapes, and the small writers the hooks share. No drawing here.
import { atom, read, type EngineInterface, update } from 'claude-code'
import { type AgentCard, type Architect, type BgTask, type FileEvent, type Gate, type LogLine, type Loop, type Main, type Receipt, type Roster, type Turn, type Usage, type View } from '../types'
import { DEFAULT_ARCHITECT, DEFAULT_GATE, DEFAULT_MAIN, DEFAULT_ROSTER, DEFAULT_TURN, DEFAULT_USAGE, DEFAULT_VIEW, SCHEMA_VERSION, cardTitle, endConsult, gateSummary, isAdvising, listOf, momentOf, normalize, normalizeCard, normalizeGate, normalizeLog, parseConfig, shorten, startConsult } from './fd-core'
import { type Config } from './fd-core'

// ---------------------------------------------------------------- state

export const fdMeta = atom({ plugin: 'filetree', key: 'fdMeta' } as const, { schemaVersion: SCHEMA_VERSION })
export const fdMain = atom({ plugin: 'filetree', key: 'fdMain' } as const, DEFAULT_MAIN)
export const fdUsage = atom({ plugin: 'filetree', key: 'fdUsage' } as const, DEFAULT_USAGE)
export const fdArchitect = atom({ plugin: 'filetree', key: 'fdArchitect' } as const, DEFAULT_ARCHITECT)
export const fdGate = atom({ plugin: 'filetree', key: 'fdGate' } as const, DEFAULT_GATE)
export const fdAgents = atom({ plugin: 'filetree', key: 'fdAgents' } as const, [])
export const fdLoops = atom({ plugin: 'filetree', key: 'fdLoops' } as const, [])
export const fdTasks = atom({ plugin: 'filetree', key: 'fdTasks' } as const, [])
export const fdFiles = atom({ plugin: 'filetree', key: 'fdFiles' } as const, [])
export const fdLog = atom({ plugin: 'filetree', key: 'fdLog' } as const, [])
export const fdTurn = atom({ plugin: 'filetree', key: 'fdTurn' } as const, DEFAULT_TURN)
export const fdReceipt = atom({ plugin: 'filetree', key: 'fdReceipt' } as const, null)
export const fdView = atom({ plugin: 'filetree', key: 'fdView' } as const, DEFAULT_VIEW)
export const fdRoster = atom({ plugin: 'filetree', key: 'fdRoster' } as const, DEFAULT_ROSTER)

export type ServerBlock = { type: string; id?: string; name?: string; tool_use_id?: string }

// Every read goes through these, so a value saved under an older shape still reads.
export async function getMain($: EngineInterface): Promise<Main> {
  return normalize(DEFAULT_MAIN, await read($, fdMain))
}
export async function getUsage($: EngineInterface): Promise<Usage> {
  return normalize(DEFAULT_USAGE, await read($, fdUsage))
}
export async function getArchitect($: EngineInterface): Promise<Architect> {
  const a = normalize(DEFAULT_ARCHITECT, await read($, fdArchitect))
  return { ...a, consults: listOf(a.consults), ids: listOf(a.ids), seen: listOf(a.seen) }
}
export async function getGate($: EngineInterface): Promise<Gate> {
  return normalizeGate(await read($, fdGate))
}
export async function getCards($: EngineInterface): Promise<AgentCard[]> {
  return listOf<unknown>(await read($, fdAgents)).map(normalizeCard)
}
export async function getLoops($: EngineInterface): Promise<Loop[]> {
  return listOf<Loop>(await read($, fdLoops))
}
export async function getTasks($: EngineInterface): Promise<BgTask[]> {
  return listOf<BgTask>(await read($, fdTasks))
}
export async function getFiles($: EngineInterface): Promise<FileEvent[]> {
  return listOf<FileEvent>(await read($, fdFiles))
}
export async function getLog($: EngineInterface): Promise<LogLine[]> {
  return normalizeLog(await read($, fdLog))
}
export async function getTurn($: EngineInterface): Promise<Turn> {
  return normalize(DEFAULT_TURN, await read($, fdTurn))
}
export async function getView($: EngineInterface): Promise<View> {
  return normalize(DEFAULT_VIEW, await read($, fdView))
}
export async function getRoster($: EngineInterface): Promise<Roster> {
  const r = normalize(DEFAULT_ROSTER, await read($, fdRoster))
  return { architectTypes: listOf(r.architectTypes) }
}

/** A stored shape older than this build's: drop what cannot be read, keep the rest. */
export async function migrate($: EngineInterface) {
  const m = await read($, fdMeta)
  if ((m?.schemaVersion ?? 0) >= SCHEMA_VERSION) return
  await update($, fdLog, list => normalizeLog(list))
  await update($, fdAgents, list => listOf<unknown>(list).map(normalizeCard))
  await update($, fdGate, g => normalizeGate(g))
  await update($, fdMeta, () => ({ schemaVersion: SCHEMA_VERSION }))
}

export async function say($: EngineInterface, who: string, text: string, kind: LogLine['kind'] = 'info', agentId: string | null = null) {
  const line: LogLine = { at: await $.clock.now(), who, text, kind, agentId }
  await update($, fdLog, list => [...normalizeLog(list), line].slice(-60))
}

export async function refreshStatus($: EngineInterface, cfg: Config) {
  if (!cfg.statusLine) return $.ui.status(undefined)
  const [u, a, g, cards] = await Promise.all([getUsage($), getArchitect($), getGate($), getCards($)])
  const running = cards.filter(c => c.status === 'running').length
  const s = gateSummary(g)
  const parts = [
    u.pct !== null ? `ctx ${Math.round(u.pct)}%` : null,
    cards.length > 0 ? `agents ${running}/${cards.length}` : null,
    a.consults.length > 0 || a.ids.length > 0 ? `${cfg.architectLabel.toLowerCase()} ${isAdvising(a) ? 'advising' : a.consults.length}` : null,
    s.deny > 0 ? `denied ${s.deny}` : null,
  ]
  // Only fields with something to say; with none, no status entry at all.
  const shown = parts.filter(Boolean)
  $.ui.status(shown.length > 0 ? shown.join(' · ') : undefined)
}

export async function whoIs($: EngineInterface, agentId: string | undefined) {
  if (!agentId) return 'main'
  const card = (await getCards($)).find(c => c.id === agentId)
  return card ? shorten(cardTitle(card), 14) : 'agent'
}

export async function consultStarted($: EngineInterface, cfg: Config, id: string, via: string) {
  const t = await getTurn($)
  const moment = momentOf(t)
  const at = await $.clock.now()
  await update($, fdArchitect, a => startConsult(normalize(DEFAULT_ARCHITECT, a), { id, at, moment, via }))
  if (moment === 'before done') await update($, fdTurn, x => ({ ...normalize(DEFAULT_TURN, x), isReviewing: true }))
  await say($, cfg.architectLabel.toLowerCase(), cfg.moments ? `${moment} · ${via}` : `consulted · ${via}`, 'consult')
  await refreshStatus($, cfg)
}

export async function consultEnded($: EngineInterface, cfg: Config, advice: string | null, id?: string) {
  const at = await $.clock.now()
  const first = advice?.split('\n').find(l => l.trim()) ?? null
  const text = first ? shorten(first.replace(/^[#>*\s-]+/, ''), 160) : null
  await update($, fdArchitect, a => endConsult(normalize(DEFAULT_ARCHITECT, a), at, text, id))
  await update($, fdTurn, t => ({ ...normalize(DEFAULT_TURN, t), isReviewing: false }))
  await say($, cfg.architectLabel.toLowerCase(), text ? `advice: ${shorten(text, 60)}` : 'advice returned', 'consult')
  await refreshStatus($, cfg)
}

export async function noteAdvice($: EngineInterface, cfg: Config, advice: string) {
  await update($, fdArchitect, x => ({ ...normalize(DEFAULT_ARCHITECT, x), lastAdvice: advice }))
  await say($, cfg.architectLabel.toLowerCase(), `advice: ${shorten(advice, 60)}`, 'consult')
}

export async function isArchitectType($: EngineInterface, cfg: Config, type: string) {
  return cfg.architect.test(type) || (await getRoster($)).architectTypes.includes(type)
}

export async function resetAll($: EngineInterface) {
  await update($, fdMain, m => ({ ...DEFAULT_MAIN, model: normalize(DEFAULT_MAIN, m).model, mode: normalize(DEFAULT_MAIN, m).mode }))
  await update($, fdArchitect, () => DEFAULT_ARCHITECT)
  await update($, fdGate, () => DEFAULT_GATE)
  await update($, fdAgents, () => [])
  await update($, fdLoops, () => [])
  await update($, fdLog, () => [])
  await update($, fdTasks, () => [])
  await update($, fdFiles, () => [])
  await update($, fdTurn, () => DEFAULT_TURN)
  await update($, fdReceipt, () => null)
  await update($, fdView, () => DEFAULT_VIEW)
  // The context gauge waits for the next measurement rather than showing the pre-clear fill.
  await update($, fdUsage, x => ({ ...normalize(DEFAULT_USAGE, x), pct: null, tokens: null }))
}

/** The session's cost read fresh, not from the last measurement: the receipt subtracts two of these. */
export async function costNow($: EngineInterface): Promise<number | null> {
  const u = await $.session.usage().catch(() => null)
  return u?.cost?.usd ?? null
}

export async function noteMode($: EngineInterface, mode: string | undefined) {
  if (mode) await update($, fdMain, m => (normalize(DEFAULT_MAIN, m).mode === mode ? normalize(DEFAULT_MAIN, m) : { ...normalize(DEFAULT_MAIN, m), mode }))
}


// The tab replaces the standalone pane and the status entry.
export const configOf = (options: Readonly<Record<string, unknown>>): Config => ({ ...parseConfig(options), openOnStart: false, statusLine: false })

// The validator reads a state write only when the atom is defined in the file that writes it, so other modules write through these.
export async function updateFdTasks($: EngineInterface, fn: (current: BgTask[]) => BgTask[]): Promise<void> {
  await update($, fdTasks, fn)
}
export async function updateFdFiles($: EngineInterface, fn: (current: FileEvent[]) => FileEvent[]): Promise<void> {
  await update($, fdFiles, fn)
}
export async function updateFdRoster($: EngineInterface, fn: (current: Roster) => Roster): Promise<void> {
  await update($, fdRoster, fn)
}
export async function updateFdTurn($: EngineInterface, fn: (current: Turn) => Turn): Promise<void> {
  await update($, fdTurn, fn)
}
export async function updateFdMain($: EngineInterface, fn: (current: Main) => Main): Promise<void> {
  await update($, fdMain, fn)
}
export async function updateFdAgents($: EngineInterface, fn: (current: AgentCard[]) => AgentCard[]): Promise<void> {
  await update($, fdAgents, fn)
}
export async function updateFdLoops($: EngineInterface, fn: (current: Loop[]) => Loop[]): Promise<void> {
  await update($, fdLoops, fn)
}
export async function updateFdUsage($: EngineInterface, fn: (current: Usage) => Usage): Promise<void> {
  await update($, fdUsage, fn)
}
export async function updateFdGate($: EngineInterface, fn: (current: Gate) => Gate): Promise<void> {
  await update($, fdGate, fn)
}
export async function updateFdArchitect($: EngineInterface, fn: (current: Architect) => Architect): Promise<void> {
  await update($, fdArchitect, fn)
}
export async function updateFdReceipt($: EngineInterface, fn: (current: Receipt | null) => Receipt | null): Promise<void> {
  await update($, fdReceipt, fn)
}
export async function updateFdView($: EngineInterface, fn: (current: View) => View): Promise<void> {
  await update($, fdView, fn)
}
export async function getReceipt($: EngineInterface): Promise<Receipt | null> {
  return (await read($, fdReceipt)) ?? null
}
