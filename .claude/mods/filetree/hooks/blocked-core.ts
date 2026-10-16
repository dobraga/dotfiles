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

/** Only a command that has not started may be approved, so a second click cannot run it twice. */
export const isStartable = (list: BlockedCommand[], id: string): boolean => list.find(b => b.id === id)?.status === 'waiting'
