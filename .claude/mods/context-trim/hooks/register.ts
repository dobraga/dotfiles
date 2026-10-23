import type { Register } from 'claude-code'
import { parseOptions } from './config'
import { applyDrop, digest, parseDrop } from './trim-core'

const PROMPT = (lines: string) => `You prune the transcript of a coding-agent session to free context. Each line below is one message: index, role, ~tokens, preview.
Pick the messages that no longer help the work: large tool outputs already acted on, dead ends, retried attempts, repeated listings, chatter. Keep decisions, the user's requests and constraints, file paths and facts still needed, and anything unresolved.
When unsure, keep the message. Answer with JSON only: {"drop":[indices]}

${lines}`

export const register: Register = (on, options) => {
  const opts = parseOptions(options)
  if (!opts.enabled) return

  let lastBucket = 0
  let isRunning = false
  let hasHookRun = false

  // Answers a plugin compaction with the transcript minus what the model picked: no summary, nothing sent to the summarizer.
  // Any failure vetoes the compaction instead of calling `next(e)`, which would summarize the whole conversation.
  on('session.compact', { trigger: 'plugin' }, async ($, e) => {
    hasHookRun = true
    if (e.messages.length <= opts.keepRecent + 1) return { skip: 'context-trim: transcript too short to trim' }

    const asked = await $.model.complete({ model: opts.model, prompt: PROMPT(digest(e.messages)), effort: 'low', timeoutMs: 45000 })
    if (!asked.isAnswered) return { skip: `context-trim: judge failed (${asked.reason})` }

    const drop = parseDrop(asked.text, e.messages.length)
    if (!drop) return { skip: 'context-trim: judge answer was not a drop list' }

    const trimmed = applyDrop(e.messages, drop, opts.keepRecent)
    if (trimmed.dropped.length === 0) return { skip: 'context-trim: nothing safe to drop' }

    $.ui.toast(`context-trim: dropped ${trimmed.dropped.length} messages, ~${trimmed.saved} tokens`)
    return { messages: trimmed.kept }
  })

  on('turn.complete', async ($, e, next) => {
    const { context } = await $.session.usage()
    const bucket = Math.floor((context.percent ?? 0) / opts.step)
    if (bucket < lastBucket) lastBucket = bucket

    if (opts.enabled && bucket > lastBucket && !isRunning) {
      const previous = lastBucket
      lastBucket = bucket
      isRunning = true
      hasHookRun = false

      // `compact` rejects while a turn runs, so it waits for this hook to return.
      $.clock.after(0, () => {
        $.session
          .compact()
          .then((r) => {
            // The engine runs every hook but the calling plugin's own; if ours was skipped, a summary
            // compaction just happened and the mod stops itself rather than repeat it.
            if (r.skip === undefined && !hasHookRun) {
              opts.enabled = false
              $.ui.toast('context-trim: its own hook is not reached by its own compact call; the mod is off until it is split in two plugins')
            } else if (r.skip !== undefined && r.skip.startsWith('context-trim:')) {
              $.ui.toast(r.skip)
            }
          })
          .catch(() => {
            lastBucket = previous
          })
          .finally(() => {
            isRunning = false
          })
      })
    }

    return next(e)
  })
}
