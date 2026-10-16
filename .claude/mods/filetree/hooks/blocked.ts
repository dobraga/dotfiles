// What the Flightdeck box does with a command the engine refused: hold it, run it only when the user says so, and hand
// the result to the prompt. The engine's refusal is never overridden: the command runs as the user's own, like `!`.
import type { EngineInterface } from 'claude-code'
import { addBlocked, clipOutput, dismissBlocked, isStartable, patchBlocked, promptText } from './blocked-core'
import { getBlocked, updateFdBlocked } from './fd-state'

const RUN_TIMEOUT_MS = 120_000

/** Holds a refused Bash command in the box and brings the Flightdeck up so it is seen. Runs nothing. */
export async function holdBlocked($: EngineInterface, item: { id: string; command: string; reason: string }, pane: { id: string; title: string }): Promise<void> {
  const at = await $.clock.now()
  await updateFdBlocked($, list => addBlocked(list, { ...item, at, status: 'waiting', output: '', exitCode: null }))
  const isUp = (await $.ui.panes().catch(() => [])).some(p => p.id === pane.id && p.isPlaced)
  if (!isUp) {
    const placed = await $.ui.open({ id: pane.id, title: pane.title, columns: 66, rows: 12, focus: true }).catch(() => undefined)
    if (!placed?.isPlaced) $.ui.log('A command was blocked; open the Flightdeck tab to run it yourself.')
  }
  $.ui.toast('A command was blocked: you can run it yourself in the Flightdeck tab')
}

/** Runs the held command exactly as shown, once, in the session's directory. */
export async function runBlocked($: EngineInterface, id: string): Promise<void> {
  const list = await getBlocked($)
  const item = list.find(b => b.id === id)
  if (!item || !isStartable(list, id)) return
  await updateFdBlocked($, l => patchBlocked(l, id, { status: 'running' }))
  try {
    const cwd = await $.session.cwd()
    const run = await $.process.run(['sh', '-c', item.command], { cwd, timeoutMs: RUN_TIMEOUT_MS })
    const output = clipOutput([run.stdout, run.stderr].filter(Boolean).join('\n'))
    await updateFdBlocked($, l => patchBlocked(l, id, { status: run.exitCode === 0 ? 'done' : 'failed', output, exitCode: run.exitCode }))
  } catch (err) {
    await updateFdBlocked($, l => patchBlocked(l, id, { status: 'failed', output: err instanceof Error ? err.message : String(err), exitCode: null }))
  }
}

/** Puts what was run and what it printed in the prompt box; the user reads and sends it. */
export async function sendBlockedToPrompt($: EngineInterface, id: string): Promise<void> {
  const item = (await getBlocked($)).find(b => b.id === id)
  if (!item) return
  const filled = await $.prompt.fill({ text: promptText(item), mode: 'append' })
  if (!filled.isFilled) $.ui.toast('The prompt box could not take the result; it is still in the Flightdeck.')
}

/** Forgets a held command. */
export async function dismissBlockedCommand($: EngineInterface, id: string): Promise<void> {
  await updateFdBlocked($, l => dismissBlocked(l, id))
}
