// `$`-free helpers lifted out of register.tsx so each one is tested directly.
import type { GitAction } from './git'
import type { Seg } from './rows'
import { inside } from './tree'
import type { FileTree } from '../types'

export type Pending = { actions: GitAction[]; ids: number[]; command: string; head: string }
export type Outcome = { state: 'done' | 'failed'; label: string; detail: string }

/** Drops the keys a row segment leaves undefined, so the renderer sees only what is set. */
export function clean(segs: Seg[]): Seg[] {
  for (const seg of segs) for (const k of Object.keys(seg) as (keyof Seg)[]) if (seg[k] === undefined) delete seg[k]
  return segs
}

/** A dimmed variant of a `#rrggbb` colour: 30% of the way from the dark background (#262626) to the colour. */
export function faint(hex: string): string {
  const v = parseInt(hex.slice(1), 16)
  const ch = (shift: number) => Math.round(0x26 + (((v >> shift) & 255) - 0x26) * 0.3)
  return `#${[16, 8, 0].map(x => ch(x).toString(16).padStart(2, '0')).join('')}`
}

/** Directories that are loaded and open: the ones whose children are on screen. */
export function openDirs(t: FileTree): string[] {
  const open = new Set(t.expanded)
  return t.nodes.filter(n => n.kind === 'dir' && n.loaded && open.has(n.id)).map(n => n.id)
}

/** Every action of a Bash call marked failed. */
export function failAll(p: Pending): Outcome[] {
  return p.actions.map(a => ({ state: 'failed', label: `${a.verb} failed`, detail: '' }))
}

/** The actions whose outcome was not a failure. */
export function proven(p: Pending | null, results: Outcome[]): GitAction[] {
  return p ? p.actions.filter((_, i) => results[i]?.state !== 'failed') : []
}

/** A filesystem root (`/` or a drive letter). */
export function rootOfDisk(root: string): boolean {
  return root === '/' || /^[A-Za-z]:\/$/.test(root)
}

/** `~`-relative form of a path under `home`; the path itself otherwise. */
export function shortenHome(path: string, home: string): string {
  return home && inside(home, path) ? `~${path.slice(home.length)}` : path
}

/** A media path as a safe cache file name. */
export const cacheName = (path: string): string => path.replace(/[^A-Za-z0-9]+/g, '_').slice(-120)

/** `m:ss` for a number of seconds. */
export const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
