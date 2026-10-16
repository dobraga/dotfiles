// The Flightdeck tab body: every panel, laid out from fd-state's readers and fd-core's reducers.
import { type EngineInterface } from 'claude-code'
import { type AgentCard, type Bucket, type Check, type FileEvent, type LogLine } from '../types'
import { DEFAULT_VIEW, cardTitle, consultTimeline, fitLegend, fmtClock, fmtDuration, fmtTimer, fmtUsd, plural, gateSummary, gauge, isAdvising, isLoopActive, kTokens, lanes, limitLabel, fmtResetIn, fmtSpeed, logRows, normalize, PALETTES, SVG_COLORS, prettyModel, shorten } from './fd-core'
import { type Panel } from './fd-core'
import { configOf, getArchitect, getCards, getFiles, getGate, getLog, getLoops, getMain, getReceipt, getTasks, getTurn, getUsage, getView, updateFdView } from './fd-state'

// ---------------------------------------------------------------- drawing

type PaneEvent = Parameters<EngineInterface['ui']['resolve']>[0]

/** What the tab needs from the file tree, passed in so this module never imports register.tsx. */
export type FlightdeckHost = {
  treeRoot: () => Promise<string>
  showFile: (f: FileEvent) => Promise<void>
  shortPath: (path: string) => string
}

/** The Flightdeck tab's body. */
export async function renderFlightdeck($: EngineInterface, e: PaneEvent, options: Readonly<Record<string, unknown>>, host: FlightdeckHost) {
  const cfg = configOf(options)
  const C = PALETTES[cfg.palette]
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const hasClient = 'Client' in els
  const [m, u, a, g, cards, lp, tasks, files, treeRoot, lines, t, r, v, now] = await Promise.all([
    getMain($),
    getUsage($),
    getArchitect($),
    getGate($),
    getCards($),
    getLoops($),
    getTasks($),
    getFiles($),
    host.treeRoot(),
    getLog($),
    getTurn($),
    getReceipt($),
    getView($),
    $.clock.now(),
  ])
  const W = Math.max(40, e.props.bodyColumns)
  const layout = v.layout ?? cfg.layout
  const isWide = layout === 'wide' || (layout === 'auto' && W >= 110)
  const colW = isWide ? Math.floor((W - 2) / 2) : W
  const modelName = prettyModel(m.model)
  const viewed = e.props.view?.agentId ?? null
  const advising = isAdvising(a)
  const running = cards.filter(c => c.status === 'running')
  const showArchitect = a.consults.length > 0 || a.ids.length > 0
  const motion = cfg.motion && hasClient
  // A panel with nothing to show yet takes no room: most sessions never spawn an agent.
  const isEmpty: Record<Panel, boolean> = {
    main: false,
    architect: !showArchitect,
    gate: g.recent.length === 0 && gateSummary(g).total === 0,
    agents: cards.length === 0,
    loops: lp.length === 0,
    files: files.length === 0,
    shell: tasks.length === 0,
    receipt: !m.isRunning && !r,
    log: false,
  }
  const panels = cfg.panels.filter(p => !isEmpty[p])
  const decider = m.mode === 'auto' ? 'classifier' : 'you'

  // A connector between panels: animated while its flow is live, a dim line otherwise.
  const rail = (key: string, active: boolean, color: string, width: number, marks: number[] = [], isMerge = false) =>
    motion ? (
      <els.Client
        key={key}
        module="./fd-rail.tsx"
        width={width}
        height={1}
        props={{ active, width, color, dim: C.faint, marks, isMerge }}
      />
    ) : (
      <Text color={C.faint}>{'─'.repeat(Math.max(1, width))}</Text>
    )

  // A start time of 0 is unknown (state saved before it was recorded): no clock, not decades.
  const clock = (key: string, since: number, endAt: number | null, color: string) =>
    since <= 0 ? (
      <Text color={color}>—</Text>
    ) : hasClient ? (
      <els.Client key={key} module="./fd-elapsed.tsx" props={{ since, now, endAt, color }} />
    ) : (
      <Text color={color}>{fmtTimer((endAt ?? now) - since)}</Text>
    )

  // ---- main
  const effortN = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 }[m.effort] ?? 0
  const ctxGauge = u.pct !== null ? gauge(u.pct, 10) : null
  const mainPanel = (w: number) => (
    <Box flexDirection="column" borderStyle="round" borderColor={C.main} paddingX={1} width={w}>
      <Box justifyContent="space-between">
        <Text color={C.main} bold>
          {modelName} · main
        </Text>
        <Text color={m.isRunning ? C.main : C.dim}>{m.isRunning ? '● working' : '○ idle'}</Text>
      </Box>
      <Text wrap="truncate">
        <Text dimColor>effort </Text>
        <Text color={C.main}>{'▮'.repeat(effortN) + '▯'.repeat(4 - effortN)} </Text>
        <Text color={C.main} bold>
          {m.effort || '—'}
        </Text>
        {m.mode ? <Text dimColor>{`   mode ${m.mode}`}</Text> : null}
        <Text dimColor>{`   ${m.steps} req`}</Text>
      </Text>
      {ctxGauge ? (
        <Text wrap="truncate">
          <Text dimColor>ctx </Text>
          <Text color={u.pct !== null && u.pct >= 80 ? C.warn : C.main}>{ctxGauge.on}</Text>
          <Text color={C.faint}>{ctxGauge.off}</Text>
          <Text bold>{` ${Math.round(u.pct ?? 0)}%`}</Text>
          {u.tokens !== null ? <Text dimColor>{` ${kTokens(u.tokens)}/${kTokens(u.window)}`}</Text> : null}
          {u.compactions > 0 ? <Text color={C.amber}>{`  ⟲${u.compactions}`}</Text> : null}
        </Text>
      ) : null}
      {u.costUsd !== null || u.limits.length > 0 ? (
        <Text wrap="truncate">
          {u.costUsd !== null ? <Text color={C.text}>{`${fmtUsd(u.costUsd)}   `}</Text> : null}
          {u.limits.slice(0, 2).map(l => {
            const lg = gauge(l.pct, 5)
            // The time to each reset where the line has room for it: both windows fit from 56 columns,
            // so a wide pane's half column (59 at 120) has them and a 40-column pane keeps its gauges.
            const resetIn = w >= 56 ? fmtResetIn(l.resetsAt, now) : ''
            return (
              <Text wrap="truncate">
                <Text dimColor>{`${limitLabel(l.kind)} `}</Text>
                <Text color={l.pct >= 80 ? C.warn : C.main}>{lg.on}</Text>
                <Text color={C.faint}>{lg.off}</Text>
                <Text dimColor>{` ${Math.round(l.pct)}%${resetIn ? ` ↻${resetIn}` : ''}  `}</Text>
              </Text>
            )
          })}
        </Text>
      ) : null}
      {m.speed ? <Text dimColor wrap="truncate">{`last req  ${fmtSpeed(m.speed)}`}</Text> : null}
    </Box>
  )

  // ---- architect
  const lastConsult = a.consults[a.consults.length - 1]
  const architectPanel = (w: number) => {
    const tl = consultTimeline(a, now, Math.max(8, w - 4))
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={C.arch} paddingX={1} width={w}>
        <Box justifyContent="space-between">
          <Text color={C.arch} bold>
            {cfg.architectLabel} · {advising ? 'advising' : 'on call'}
          </Text>
          <Text>
            <Text dimColor>consults </Text>
            <Text color={C.arch} bold>
              {a.consults.length}
            </Text>
          </Text>
        </Box>
        <Text color={C.arch}>{tl}</Text>
        {lastConsult ? (
          <Text dimColor wrap="truncate">
            {advising
              ? `consulting since ${fmtClock(lastConsult.at)}`
              : `last ${fmtDuration(now - (lastConsult.endAt ?? lastConsult.at))} ago · took ${fmtDuration((lastConsult.endAt ?? now) - lastConsult.at)}`}
          </Text>
        ) : (
          <Text dimColor>not consulted yet</Text>
        )}
        {cfg.moments ? (
          <Box flexWrap="wrap" columnGap={2}>
            {(['before a plan', 'error repeats', 'before done'] as const).map(mo => {
              const isOn = lastConsult?.moment === mo
              return (
                <Text color={isOn ? C.arch : C.dim} bold={isOn}>
                  {isOn ? '◆' : '◇'} {mo}
                </Text>
              )
            })}
            <Text color={C.faint}>(inferred)</Text>
          </Box>
        ) : null}
        {a.lastAdvice ? (
          <Text color={C.arch} wrap="truncate">
            » {a.lastAdvice}
          </Text>
        ) : null}
      </Box>
    )
  }

  // ---- gate
  const s = gateSummary(g)
  const verdictColor = (c: Check) =>
    c.verdict === 'rule' ? C.gate : c.verdict === 'cleared' ? C.cleared : c.verdict === 'ask' ? C.amber : C.warn
  const gatePanel = (w: number) => {
    const strip = g.recent.slice(-Math.max(8, w - 4))
    const open = v.gateOpen
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={C.gate} paddingX={1} width={w}>
        <Box justifyContent="space-between">
          <Text color={C.gate} bold>
            {cfg.gateLabel} · permissions
          </Text>
          <Text dimColor>{`${s.total} checks`}</Text>
        </Box>
        <Box>
          {strip.length === 0 ? <Text color={C.faint}>no checks yet</Text> : null}
          {strip.map(c => (
            <Text color={verdictColor(c)} dimColor={c.inSubagent}>
              {c.verdict === 'deny' ? '✗' : '■'}
            </Text>
          ))}
        </Box>
        <Text wrap="truncate">
          <Text color={C.gate}>■</Text>
          <Text dimColor>{` ${s.rule} allowed  `}</Text>
          <Text color={C.cleared}>■</Text>
          <Text dimColor>{` ${s.cleared} ${decider}  `}</Text>
          {s.ask > 0 ? <Text color={C.amber}>{`■ ${s.ask} pending  `}</Text> : null}
          <Text color={s.deny > 0 ? C.warn : C.dim}>{`✗ ${s.deny} denied`}</Text>
          {w >= 80 && g.recent.some(c => c.inSubagent) ? <Text color={C.faint}>{'  dim: in subagents'}</Text> : null}
        </Text>
        <Box columnGap={2}>
          {(['file', 'shell', 'other'] as const).map((b: Bucket) => {
            const tl = g.totals[b]
            const n = tl.rule + tl.ask + tl.cleared + tl.deny
            return (
              <Button
                key={`gate-${b}`}
                plain
                hotkey={b[0]}
                label={`${b} ${n}${open === b ? ' ▾' : ''}`}
                dimColor={n === 0}
                onPress={() => updateFdView($, x => ({ ...normalize(DEFAULT_VIEW, x), gateOpen: normalize(DEFAULT_VIEW, x).gateOpen === b ? null : b }))}
              />
            )
          })}
        </Box>
        {open
          ? g.recent
              .filter(c => c.bucket === open)
              .slice(-5)
              .map(c => (
                <Text wrap="truncate">
                  <Text color={verdictColor(c)}>{c.verdict === 'deny' ? '✗ ' : '■ '}</Text>
                  <Text color={C.dim}>{`${(c.verdict === 'rule' ? 'allowed' : c.verdict === 'cleared' ? decider : c.verdict === 'ask' ? 'pending' : 'denied').padEnd(10)} `}</Text>
                  <Text dimColor={c.inSubagent}>{shorten(c.detail, Math.max(10, w - 18))}</Text>
                </Text>
              ))
          : null}
      </Box>
    )
  }

  // ---- agents: cards up to the limit, swimlanes beyond it
  const statusColor = (c: AgentCard) => (c.status === 'failed' ? C.warn : c.status === 'done' ? C.gate : C.agent)
  const glyph = (c: AgentCard) => (c.status === 'running' ? '◐' : c.status === 'done' ? '✓' : c.status === 'failed' ? '✗' : '■')
  const expandOnPress = (id: string) => () =>
    updateFdView($, x => ({ ...normalize(DEFAULT_VIEW, x), expanded: normalize(DEFAULT_VIEW, x).expanded === id ? null : id }))

  const agentsPanel = (w: number) => {
    const shown = cards.slice(-6)
    // Inner width after the border and padding. Fixed columns: glyph, type, clock; the detail and the title (hotkey hint "1: " included) share the rest.
    const inner = w - 4
    const clockW = 7
    const typeW = Math.min(12, shown.reduce((n, c) => Math.max(n, c.type.length), 4) + 2)
    const detailW = inner >= 62 ? Math.min(32, inner - 2 - typeW - clockW - 24) : 0
    const titleW = inner - 2 - typeW - detailW - clockW
    const detailOf = (c: AgentCard): { text: string; color: string } => {
      if (c.lastStop === 'max_tokens') return { text: 'max_tokens', color: C.warn }
      if (c.status === 'running') {
        const t = c.tools[c.tools.length - 1]
        return t ? { text: t.text, color: t.isError ? C.warn : C.text } : { text: 'starting…', color: C.faint }
      }
      return { text: c.steps > 0 ? `${kTokens(c.ctx)} ctx · ${kTokens(c.out)} out · ${plural(c.steps, 'step')}` : '', color: C.faint }
    }
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={C.agent} borderDimColor={running.length === 0} paddingX={1} width={w}>
        <Box justifyContent="space-between">
          <Text color={C.agent} bold>
            {`agents · ${running.length} running`}
          </Text>
          <Text dimColor>{`${cards.length} total${cards.length > 0 ? ' · 1-' + shown.length + ' expand' : ''}`}</Text>
        </Box>
        {cards.length > shown.length ? <Text color={C.faint}>{`+${cards.length - shown.length} earlier`}</Text> : null}
        {shown.map((c, i) => {
          const isViewed = viewed === c.id
          const live = c.status === 'running'
          const d = detailOf(c)
          return (
            <Box flexDirection="row" height={1} overflow="hidden">
              <Box width={2} flexShrink={0}>
                <Text color={c.lastStop === 'max_tokens' ? C.warn : statusColor(c)} bold={isViewed}>{isViewed ? '▶' : glyph(c)}</Text>
              </Box>
              <Box width={titleW} flexShrink={0}>
                <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={shorten(cardTitle(c), Math.max(4, titleW - 3))} onPress={expandOnPress(c.id)} />
              </Box>
              <Box width={typeW} flexShrink={0}>
                <Text color={live ? C.agent : C.faint} wrap="truncate">
                  {c.type}
                </Text>
              </Box>
              {detailW > 0 ? (
                <Box width={detailW} flexShrink={0}>
                  <Text color={d.color} wrap="truncate">
                    {d.text}
                  </Text>
                </Box>
              ) : null}
              <Box width={clockW} flexShrink={0} justifyContent="flex-end">
                {clock(`card-clock-${c.id}`, c.spawnedAt, c.endedAt, live ? C.text : C.faint)}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  }

  const expandedCard = cards.find(c => c.id === v.expanded)
  const expandedPanel = (w: number) =>
    expandedCard ? (
      <Box flexDirection="column" borderStyle="single" borderColor={C.agent} paddingX={1} width={w}>
        <Text bold wrap="wrap">
          {expandedCard.description || expandedCard.type}
        </Text>
        <Text dimColor wrap="truncate">{`${expandedCard.type} · ${prettyModel(expandedCard.model)} · ${expandedCard.status} · ${expandedCard.steps} steps`}</Text>
        {expandedCard.tools.length === 0 ? <Text color={C.faint}>no tool calls yet</Text> : null}
        {expandedCard.tools.map(n => (
          <Text color={n.isError ? C.warn : C.text} wrap="truncate">
            {`${n.isError ? '✗' : '·'} ${n.text}`}
          </Text>
        ))}
        {expandedCard.answer ? (
          <Text dimColor wrap="wrap">
            {`» ${shorten(expandedCard.answer, 240)}`}
          </Text>
        ) : null}
      </Box>
    ) : null

  // ---- other loops (workflow agents, forks): ids that match no card
  const loopsPanel = (w: number) => {
    if (lp.length === 0) return null
    const active = lp.filter(l => isLoopActive(l, now)).length
    const dots = lp.slice(-Math.max(4, w - 38))
    return (
      <Box width={w}>
        <Text bold>other loops </Text>
        <Text dimColor>{`${lp.length} seen · ${active} active  `}</Text>
        {dots.map(l => (
          <Text color={isLoopActive(l, now) ? C.agent : l.isDone ? C.dim : C.faint}>{isLoopActive(l, now) ? '●' : l.isDone ? '✓' : '○'}</Text>
        ))}
      </Box>
    )
  }

  // ---- files: what Claude read, wrote and committed, newest first
  const filesPanel = (w: number) => {
    const root = treeRoot
    const open = v.filesOpen
    const strip = files.slice(-Math.max(8, w - 4))
    const count = (k: FileEvent['kind']) => files.filter(f => f.kind === k).length
    const shown = open ? files.filter(f => f.kind === open).slice(-6).reverse() : []
    const color = (k: FileEvent['kind']) => (k === 'read' ? C.arch : k === 'write' ? C.amber : C.gate)
    const toggle = (k: FileEvent['kind']) => updateFdView($, x => ({ ...normalize(DEFAULT_VIEW, x), filesOpen: normalize(DEFAULT_VIEW, x).filesOpen === k ? null : k }))
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={C.amber} paddingX={1} width={w}>
        <Box justifyContent="space-between">
          <Text color={C.amber} bold>
            files · claude
          </Text>
          <Text dimColor>{`${files.length} touched`}</Text>
        </Box>
        <Box>
          {strip.map(f => (
            <Text color={color(f.kind)}>■</Text>
          ))}
        </Box>
        <Box columnGap={2}>
          {(['read', 'write', 'git'] as const).map(k => (
            <Box>
              <Text color={color(k)}>■ </Text>
              <Button key={`files-${k}`} plain label={`${k === 'write' ? 'written' : k} ${count(k)}${open === k ? ' ▾' : ''}`} dimColor={count(k) === 0} onPress={() => toggle(k)} />
            </Box>
          ))}
        </Box>
        {shown.map(f => (
          <Box>
            <Box width={9} flexShrink={0}>
              <Text color={C.faint}>{fmtClock(f.at)}</Text>
            </Box>
            {f.kind === 'git' && f.verb ? (
              <Box width={8} flexShrink={0}>
                <Text color={color(f.kind)}>{f.verb}</Text>
              </Box>
            ) : null}
            <Button
              key={`file-${f.kind}-${f.path}`}
              plain
              label={shorten(root && f.path.startsWith(`${root}/`) ? f.path.slice(root.length + 1) : host.shortPath(f.path), Math.max(8, w - 22))}
              onPress={() => void host.showFile(f)}
            />
          </Box>
        ))}
      </Box>
    )
  }

  // ---- shell: background shells and monitors, running first
  const shellPanel = (w: number) => {
    const live = tasks.filter(x => x.endedAt === null)
    const shown = [...live, ...tasks.filter(x => x.endedAt !== null).reverse()].slice(0, 6)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={C.agent} borderDimColor={live.length === 0} paddingX={1} width={w}>
        <Box justifyContent="space-between">
          <Text color={C.agent} bold>
            shell · background
          </Text>
          <Text dimColor>{`${live.length} running`}</Text>
        </Box>
        {shown.map(x => (
          <Box>
            <Box width={2} flexShrink={0}>
              <Text color={x.endedAt === null ? C.agent : x.status === 'completed' ? C.gate : C.warn}>{x.endedAt === null ? '●' : x.status === 'completed' ? '✓' : '✗'}</Text>
            </Box>
            <Box width={9} flexShrink={0}>
              <Text color={C.dim}>{x.kind}</Text>
            </Box>
            <Box width={8} flexShrink={0}>
              <Text color={C.faint}>{fmtDuration((x.endedAt ?? now) - x.startedAt)}</Text>
            </Box>
            <Text color={x.endedAt === null ? C.text : C.dim} wrap="truncate">
              {x.label}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }

  // ---- receipt: the turn now, or the last one
  const receiptPanel = (w: number) => {
    const isReview = t.isReviewing
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={C.main} borderDimColor={!m.isRunning && !isReview} paddingX={1} width={w}>
        {m.isRunning ? (
          <Box>
            <Text color={C.main} wrap="truncate">{`◐ back to ${modelName.toLowerCase()} · turn `}</Text>
            <Box flexShrink={0}>{clock('turn-clock', t.startedAt, null, C.main)}</Box>
            {w >= 60 ? <Text dimColor wrap="truncate">{` · ${plural(t.edits, 'edit')} · ${plural(t.errors, 'error')}`}</Text> : null}
          </Box>
        ) : r ? (
          <Text wrap="truncate">
            <Text color={r.reason === 'answer' ? C.gate : C.warn}>{r.reason === 'answer' ? '✓ ' : '✗ '}</Text>
            <Text>{`last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}`}</Text>
            {r.costDelta !== null ? <Text color={C.main}>{` · +${fmtUsd(r.costDelta)}`}</Text> : null}
          </Text>
        ) : (
          <Text color={C.faint}>no turn finished yet</Text>
        )}
        {isReview ? <Text color={C.arch}>{`${cfg.architectLabel.toLowerCase()} reviewing before done (inferred)`}</Text> : null}
      </Box>
    )
  }

  // ---- log: whatever rows the other panels leave, 4 to 8
  // The main box's speed line and the gap above the log are a row each.
  const used = 2 + 5 + (m.speed ? 1 : 0) + 1 + (showArchitect ? 6 : 0) + 6 + (v.gateOpen ? 5 : 0) + (cards.length ? 3 + Math.min(6, cards.length) : 0) + (expandedCard ? 8 : 0) + (lp.length ? 1 : 0) + (files.length ? 5 + (v.filesOpen ? Math.min(6, files.filter(f => f.kind === v.filesOpen).length) : 0) : 0) + (tasks.length ? 3 + Math.min(6, tasks.length) : 0) + 3
  const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
  const nLog = logRows(bodyRows, used)
  const shownLines = (viewed ? lines.filter(l => l.agentId === viewed) : lines).slice(-nLog)
  const colorOf = (l: LogLine) =>
    l.kind === 'error' ? C.warn : l.kind === 'consult' ? C.arch : l.who === 'main' ? C.main : l.who === 'gate' ? C.gate : l.who === 'you' ? C.text : C.agent
  const logPanel = (w: number) => (
    <Box flexDirection="column" borderStyle="round" borderColor={C.faint} paddingX={1} marginTop={1} width={w}>
      <Text dimColor>{viewed ? 'session log · this agent' : 'session log'}</Text>
      {shownLines.length === 0 ? <Text color={C.faint}>nothing yet</Text> : null}
      {shownLines.map(l => (
        <Box>
          <Box width={9} flexShrink={0}>
            <Text color={C.faint}>{fmtClock(l.at)}</Text>
          </Box>
          <Box width={13} flexShrink={0}>
            <Text color={colorOf(l)} bold wrap="truncate">
              {l.who}
            </Text>
          </Box>
          <Text color={l.kind === 'error' ? C.warn : C.text} wrap="truncate">
            {l.text}
          </Text>
        </Box>
      ))}
    </Box>
  )

  const draw = (p: Panel, w: number) =>
    p === 'main'
      ? mainPanel(w)
      : p === 'architect'
        ? architectPanel(w)
        : p === 'gate'
          ? gatePanel(w)
          : p === 'agents'
            ? agentsPanel(w)
            : p === 'loops'
              ? loopsPanel(w)
              : p === 'files'
                ? filesPanel(w)
                : p === 'shell'
                  ? shellPanel(w)
                : p === 'receipt'
                  ? receiptPanel(w)
                  : logPanel(w)

  // Panels with the flow between them; the agents panel draws its own rails.
  const column = (ps: Panel[], w: number) => (
    <Box flexDirection="column" width={w}>
      {ps.map((p, i) => {
        const prev = ps[i - 1]
        const link =
          i === 0 || p === 'agents' || prev === 'agents' || p === 'log' || p === 'loops' || prev === 'loops' || p === 'files' || prev === 'files' || p === 'shell' || prev === 'shell' || p === 'receipt' || prev === 'receipt'
            ? null
            : rail(`link-${p}`, p === 'architect' ? advising : m.isRunning, p === 'architect' ? C.arch : C.main, w)
        return (
          <Box flexDirection="column">
            {link}
            {draw(p, w)}
            {p === 'agents' ? expandedPanel(w) : null}
          </Box>
        )
      })}
    </Box>
  )

  // Desktop draws the agents' time axis as SVG under the panels.
  const svgLanes =
    e.surface !== 'terminal' && cards.length > 0
      ? (() => {
          const { Svg } = $.ui.resolve(e)
          const rowH = 18
          const pxW = 520
          const geo = lanes(cards.slice(-10), now, 100)
          const rects = cards
            .slice(-10)
            .map((c, i) => {
              const gm = geo[i]
              const x = 150 + ((gm?.before ?? 0) / 100) * (pxW - 160)
              const wpx = Math.max(3, ((gm?.bar ?? 1) / 100) * (pxW - 160))
              const fill = c.status === 'running' ? SVG_COLORS.running : c.status === 'done' ? SVG_COLORS.done : c.status === 'failed' ? SVG_COLORS.failed : SVG_COLORS.other
              const label = shorten(cardTitle(c), 22).replace(/[<&>]/g, '')
              return `<text x="4" y="${i * rowH + 13}" font-size="11" fill="${SVG_COLORS.label}">${label}</text><rect x="${x}" y="${i * rowH + 4}" width="${wpx}" height="10" rx="3" fill="${fill}"/>`
            })
            .join('')
          const svgH = Math.min(10, cards.length) * rowH + 4
          return (
            <Svg
              source={`<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${svgH}" viewBox="0 0 ${pxW} ${svgH}">${rects}</svg>`}
              alt={`${cards.length} agents on a time axis`}
              width={pxW}
              height={svgH}
            />
          )
        })()
      : null

  // Inline above the prompt (the terminal's main screen), the pane is a summary of at most 8 rows.
  const isMini = layout === 'mini' || (layout === 'auto' && e.props.placement === 'inline')
  if (isMini) {
    const live = [...cards.filter(c => c.status === 'running'), ...cards.filter(c => c.status !== 'running').reverse()].slice(0, 3)
    const counts = ` ${s.rule} allowed · ${s.cleared} ${decider}${s.ask > 0 ? ` · ${s.ask} pending` : ''} · ${s.deny} denied`
    const strip = g.recent.slice(-Math.max(4, W - cfg.gateLabel.length - 1 - counts.length))
    const mg = u.pct !== null ? gauge(u.pct, 6) : null
    return (
      <Box flexDirection="column" width={W}>
        <Text wrap="truncate">
          <Text color={C.main} bold>
            {modelName}
          </Text>
          <Text color={m.isRunning ? C.main : C.dim}>{m.isRunning ? ' ● working' : ' ○ idle'}</Text>
          {mg ? <Text dimColor> · ctx </Text> : null}
          {mg ? <Text color={(u.pct ?? 0) >= 80 ? C.warn : C.main}>{mg.on}</Text> : null}
          {mg ? <Text color={C.faint}>{mg.off}</Text> : null}
          {mg ? <Text>{` ${Math.round(u.pct ?? 0)}%`}</Text> : null}
          {u.compactions > 0 ? <Text color={C.amber}>{` ⟲${u.compactions}`}</Text> : null}
          {u.costUsd !== null ? <Text dimColor>{` · ${fmtUsd(u.costUsd)}`}</Text> : null}
          {showArchitect ? <Text color={C.arch}>{` · ${cfg.architectLabel.toLowerCase()} ${advising ? 'advising' : a.consults.length}`}</Text> : null}
        </Text>
        {strip.length > 0 ? (
          <Box>
            <Text dimColor>{`${cfg.gateLabel.toLowerCase()} `}</Text>
            {strip.map(c => (
              <Text color={verdictColor(c)} dimColor={c.inSubagent}>
                {c.verdict === 'deny' ? '✗' : '■'}
              </Text>
            ))}
            <Text color={s.deny > 0 ? C.warn : s.ask > 0 ? C.amber : C.dim} wrap="truncate">
              {counts}
            </Text>
          </Box>
        ) : null}
        {live.map(c => (
          <Box>
            <Text color={statusColor(c)}>{`${glyph(c)} `}</Text>
            <Box width={Math.max(10, W - 30)}>
              <Text wrap="truncate">{cardTitle(c)}</Text>
            </Box>
            <Text dimColor>{c.steps > 0 ? ` ctx ${kTokens(c.ctx)} ` : ' '}</Text>
            {clock(`mini-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
          </Box>
        ))}
        {cards.length > live.length ? (
          <Text color={C.faint} wrap="truncate">{`+${cards.length - live.length} more agents · /flightdeck layout compact for all`}</Text>
        ) : null}
        {lp.length > 0 ? <Text dimColor>{`other loops ${lp.length} · ${lp.filter(l => isLoopActive(l, now)).length} active`}</Text> : null}
        {!m.isRunning && r ? (
          <Text dimColor wrap="truncate">
            {`last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}${r.costDelta !== null ? ` · +${fmtUsd(r.costDelta)}` : ''}`}
          </Text>
        ) : null}
      </Box>
    )
  }

  const legend = fitLegend(
    [
      { label: 'main', color: C.main },
      { label: 'agents', color: C.agent },
      { label: cfg.gateLabel.toLowerCase(), color: C.gate },
      ...(showArchitect ? [{ label: cfg.architectLabel.toLowerCase(), color: C.arch }] : []),
    ],
    W,
  )

  const body = isWide ? (
    <Box flexDirection="column">
      <Box columnGap={2}>
        {column(panels.filter(p => p === 'receipt' || p === 'main' || p === 'architect' || p === 'gate' || p === 'files'), colW)}
        {column(panels.filter(p => p === 'agents' || p === 'shell' || p === 'loops'), colW)}
      </Box>
      {panels.includes('log') ? logPanel(W) : null}
    </Box>
  ) : (
    column(panels, W)
  )

  return (
    <Box flexDirection="column" width={W}>
      <Box justifyContent="center">
        <Text bold wrap="truncate">
          <Text>FLIGHTDECK</Text>
          <Text color={C.dim}> · </Text>
          <Text color={C.main}>{modelName.toUpperCase()}</Text>
          <Text>{m.isRunning ? ' WORKS' : ' IDLE'}</Text>
          {showArchitect ? <Text color={C.dim}> · </Text> : null}
          {showArchitect ? <Text color={C.arch}>{cfg.architectLabel}</Text> : null}
          {showArchitect ? <Text>{advising ? ' ADVISING' : ' ON CALL'}</Text> : null}
        </Text>
      </Box>
      <Box justifyContent="center" columnGap={2}>
        {legend.map(l => (
          <Text>
            <Text color={l.color}>■</Text>
            <Text dimColor>{` ${l.label}`}</Text>
          </Text>
        ))}
      </Box>
      {body}
      {svgLanes}
    </Box>
  )
}
