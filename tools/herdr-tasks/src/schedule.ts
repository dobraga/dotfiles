// Pure scheduling decisions, ported from herdr-automations' internal/schedule (MIT, see NOTICE.md).
// Answers one question: what should happen right now? Nothing here runs a command, writes history or touches the
// filesystem, which is what makes the laptop-was-asleep rules testable with a fake clock.
//
// It reads the wall clock rather than arming timers: a monotonic timer armed for "in 15 hours" can fire 15 hours of
// *awake* time later when the machine sleeps in between, which is how a 9am Monday run silently never happened.

import { parseCron, type Cron } from "./cron.ts";

export interface SchedTask {
  id: string;
  cron: string;
  paused?: boolean;
  /** How late a missed occurrence may still run. Unset or 0 means 120; negative means only on time. */
  catchUpMinutes?: number;
}

/** What the scheduler remembers between ticks: the occurrence each task was last evaluated for (ISO time). */
export interface State { last: Record<string, string> }

export type Decision =
  /** Run it. `trigger` is "catchup" when it is more than a minute late. */
  | { kind: "fire"; id: string; at: Date; trigger: "cron" | "catchup"; lateSeconds: number }
  /** It came due and is not worth running any more; recording it matters more than silence. */
  | { kind: "missed"; id: string; at: Date; count: number; reason: string }
  /** First time seen: counts from now, so adding a task at noon does not fire this morning's occurrence. */
  | { kind: "register"; id: string; at: Date }
  /** It came due while every task was paused: recorded and passed over, never caught up. */
  | { kind: "paused"; id: string; at: Date; count: number };

export interface Plan { decisions: Decision[]; state: State; changed: boolean }

export const DEFAULT_CATCH_UP_MINUTES = 120;

/** A task's own window wins; unset (or 0) falls back to the Settings default, then to DEFAULT_CATCH_UP_MINUTES. -1 = only on time. */
export const effectiveCatchUp = (own: number | undefined, settingsDefault: number | undefined): number | undefined =>
  own === undefined || own === 0 ? (settingsDefault || undefined) : own;

export function catchUpMs(t: SchedTask): number {
  const m = t.catchUpMinutes;
  if (m === undefined || m === 0) return DEFAULT_CATCH_UP_MINUTES * 60_000;
  return m < 0 ? 0 : m * 60_000;
}

/** The most recent occurrence at or before `now`, how many earlier ones were skipped on the way, or null if none is due. */
export function due(cron: Cron, last: Date, now: Date): { occ: Date; skipped: number } | null {
  let next = cron.next(last);
  if (!next || next > now) return null;
  let occ = next;
  let skipped = 0;
  for (;;) {
    const n = cron.next(occ);
    if (!n || n > now) break;
    skipped++;
    occ = n;
  }
  return { occ, skipped };
}

export function plan(tasks: SchedTask[], state: State, now: Date, opts: { paused?: boolean } = {}): Plan {
  const res: Plan = { decisions: [], state: { last: { ...state.last } }, changed: false };
  const live = new Set<string>();
  for (const t of tasks) {
    live.add(t.id);
    if (t.paused) continue;
    let cron: Cron;
    try { cron = parseCron(t.cron); } catch { continue; } // a broken schedule is reported elsewhere; skipping beats guessing

    const seen = res.state.last[t.id];
    if (seen === undefined) {
      res.state.last[t.id] = now.toISOString();
      res.changed = true;
      res.decisions.push({ kind: "register", id: t.id, at: cron.next(now) ?? now });
      continue;
    }

    const d = due(cron, new Date(seen), now);
    if (!d) continue;
    res.state.last[t.id] = d.occ.toISOString();
    res.changed = true;

    if (opts.paused) {
      res.decisions.push({ kind: "paused", id: t.id, at: d.occ, count: d.skipped + 1 });
      continue;
    }
    if (d.skipped > 0) res.decisions.push({ kind: "missed", id: t.id, at: d.occ, count: d.skipped, reason: "machine unavailable" });

    const lateMs = now.getTime() - d.occ.getTime();
    if (lateMs > catchUpMs(t)) {
      const mins = Math.round(lateMs / 60_000);
      const window = catchUpMs(t) === 0 ? "catch-up disabled" : `past the ${catchUpMs(t) / 60_000}m catch-up window`;
      res.decisions.push({ kind: "missed", id: t.id, at: d.occ, count: 1, reason: `due ${mins}m ago, ${window}` });
      continue;
    }
    res.decisions.push({ kind: "fire", id: t.id, at: d.occ, trigger: lateMs > 60_000 ? "catchup" : "cron", lateSeconds: Math.round(lateMs / 1000) });
  }

  // Forget tasks that are gone, so re-adding one later starts clean instead of firing for every occurrence since.
  for (const id of Object.keys(res.state.last)) {
    if (!live.has(id)) { delete res.state.last[id]; res.changed = true; }
  }
  return res;
}

/** When a task comes due next, or null when its cron cannot be parsed. */
export function nextRun(cron: string, from: Date): Date | null {
  try { return parseCron(cron).next(from); } catch { return null; }
}
