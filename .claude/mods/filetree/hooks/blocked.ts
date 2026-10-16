// What the Flightdeck box does with a command the engine refused: hold it, run it only when the user says so, and hand
// the result to the prompt, then step aside. The engine's refusal is never overridden: the command runs as the user's own, like `!`.
import type { EngineInterface } from 'claude-code'
import { addBlocked, clipOutput, dismissBlocked, isStartable, patchBlocked, promptText } from './blocked-core'
import { getBlocked, updateFdBlocked } from './fd-state'
import type { BlockedCommand } from '../types'

const RUN_TIMEOUT_MS = 120_000

/** Holds a refused Bash command in the box and brings the Flightdeck up so it is seen. Runs nothing. */
export async function holdBlocked($: EngineInterface, item: { id: string; command: string; reason: string }, pane: { id: string; title: string }): Promise<void> {
  const at = await $.clock.now()
  const panes = await $.ui.panes().catch(() => [])
  // Remember whether holding this command is what opens the tab, so answering it can close the tab again.
  const openedPane = !panes.some(p => p.id === pane.id)
  await updateFdBlocked($, list => addBlocked(list, { ...item, at, status: 'waiting', output: '', exitCode: null, openedPane }))
  // Bring the Flightdeck to the front: opening an id that is already up retitles it in place and, with `focus`, selects it.
  const front = panes.some(p => p.id === pane.id && p.isShown && p.isFocused)
  if (!front) {
    const placed = await $.ui.open({ id: pane.id, title: pane.title, columns: 66, rows: 12, focus: true }).catch(() => undefined)
    if (!placed?.isPlaced) $.ui.log(`A command was blocked; open the Flightdeck tab to run it yourself.${placed && !placed.isPlaced ? ` (${placed.reason})` : ''}`)
  }
  $.ui.toast('A command was blocked: you can run it yourself in the Flightdeck tab')
}

/** Forgets a held command and, when it was the last one and it had opened the Flightdeck, closes the tab it opened. */
async function release($: EngineInterface, item: BlockedCommand, pane: { id: string }): Promise<void> {
  await updateFdBlocked($, l => dismissBlocked(l, item.id))
  if (item.openedPane && (await getBlocked($)).length === 0) await $.ui.close({ id: pane.id }).catch(() => undefined)
}

/**
 * Runs the held command exactly as shown, once, in the session's directory; then hands the result to the prompt box and
 * clears the held command, closing the Flightdeck if holding it was what opened it.
 */
export async function runBlocked($: EngineInterface, id: string, pane: { id: string }): Promise<void> {
  const list = await getBlocked($)
  const item = list.find(b => b.id === id)
  if (!item || !isStartable(list, id)) return
  await updateFdBlocked($, l => patchBlocked(l, id, { status: 'running' }))
  let done: BlockedCommand
  try {
    const cwd = await $.session.cwd()
    const run = await $.process.run(['sh', '-c', item.command], { cwd, timeoutMs: RUN_TIMEOUT_MS })
    const output = clipOutput([run.stdout, run.stderr].filter(Boolean).join('\n'))
    done = { ...item, status: run.exitCode === 0 ? 'done' : 'failed', output, exitCode: run.exitCode }
  } catch (err) {
    done = { ...item, status: 'failed', output: err instanceof Error ? err.message : String(err), exitCode: null }
  }
  const filled = await $.prompt.fill({ text: promptText(done), mode: 'append' }).catch(() => undefined)
  if (filled?.isFilled) {
    $.ui.toast(`Ran it (exit ${done.exitCode ?? '?'}); the result is in the prompt box`)
    await release($, done, pane)
  } else {
    // The result has nowhere to go: keep it in the box so it is not lost.
    await updateFdBlocked($, l => patchBlocked(l, id, { status: done.status, output: done.output, exitCode: done.exitCode }))
    $.ui.toast('Ran it, but the prompt box could not take the result; it is in the Flightdeck.')
  }
}

/** Forgets a held command without running it. */
export async function dismissBlockedCommand($: EngineInterface, id: string, pane: { id: string }): Promise<void> {
  const item = (await getBlocked($)).find(b => b.id === id)
  if (item) await release($, item, pane)
}
