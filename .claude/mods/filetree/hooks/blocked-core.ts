// Pure logic for the Flightdeck box that holds commands the engine refused: no `$`, so each step is tested directly.
import type { BlockedCommand } from '../types'

export const DEFAULT_BLOCKED: BlockedCommand[] = []
const KEEP = 10

/** The stored list, with anything unreadable dropped. */
export const normalizeBlocked = (stored: unknown): BlockedCommand[] =>
  Array.isArray(stored) ? (stored as BlockedCommand[]).filter(b => typeof b === 'object' && b !== null && typeof b.id === 'string' && typeof b.command === 'string') : DEFAULT_BLOCKED

/** Adds a blocked command unless its call id is already held; the oldest are dropped past `KEEP`. */
export const addBlocked = (list: BlockedCommand[], item: BlockedCommand): BlockedCommand[] => (list.some(b => b.id === item.id) ? list : [...list, item].slice(-KEEP))

/** Changes one held command; an id that is not held changes nothing. */
export const patchBlocked = (list: BlockedCommand[], id: string, patch: Partial<BlockedCommand>): BlockedCommand[] =>
  list.some(b => b.id === id) ? list.map(b => (b.id === id ? { ...b, ...patch } : b)) : list

/** Removes a held command. */
export const dismissBlocked = (list: BlockedCommand[], id: string): BlockedCommand[] => (list.some(b => b.id === id) ? list.filter(b => b.id !== id) : list)

/** Only a command that has not run yet may be started, so a second click cannot run it twice. */
export const isStartable = (list: BlockedCommand[], id: string): boolean => list.find(b => b.id === id)?.status === 'waiting'

/** The last `lines` lines of a command's output, at most `chars` characters, marked when cut. */
export const clipOutput = (text: string, lines = 14, chars = 4000): string => {
  const all = text.replace(/\s+$/, '').split('\n')
  const tail = all.slice(-lines).join('\n')
  const cut = all.length > lines || tail.length > chars
  return (cut ? '… ' : '') + tail.slice(-chars)
}

/** The text offered to the prompt: what was run, what it printed and how it ended. */
export const promptText = (b: BlockedCommand): string =>
  `I ran this command myself, because your attempt was blocked:\n$ ${b.command}\n${b.output === '' ? '(no output)' : b.output}\n(exit ${b.exitCode ?? '?'})\n`
