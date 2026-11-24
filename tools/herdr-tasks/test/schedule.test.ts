// Ported from herdr-automations internal/schedule/schedule_test.go (MIT, see NOTICE.md), plus cases for lateness.
import { describe, expect, test } from "bun:test";
import { parseCron } from "../src/cron.ts";
import { due, nextRun, plan, type SchedTask, type State } from "../src/schedule.ts";

const at = (s: string) => {
  const [d, t] = s.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  return new Date(y, mo - 1, da, h, mi);
};
// A task due at 09:00 every weekday with the default two-hour window.
const weekday = (id: string, extra: Partial<SchedTask> = {}): SchedTask => ({ id, cron: "0 9 * * 1-5", catchUpMinutes: 120, ...extra });
const state = (pairs: Record<string, string> = {}): State => ({ last: Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, at(v).toISOString()])) });
const only = (p: { decisions: any[] }) => { expect(p.decisions.length).toBe(1); return p.decisions[0]; };

describe("due", () => {
  test("nothing is due before the next Monday", () => {
    expect(due(parseCron("0 9 * * 1"), at("2026-08-10 09:00"), at("2026-08-10 15:00"))).toBeNull();
  });
  test("after sleep it returns the occurrence", () => {
    const d = due(parseCron("0 9 * * 1"), at("2026-08-09 20:00"), at("2026-08-10 17:13"))!;
    expect(d.skipped).toBe(0);
    expect(d.occ).toEqual(at("2026-08-10 09:00"));
  });
  test("counts every missed occurrence", () => {
    const d = due(parseCron("0 9 * * *"), at("2026-08-07 12:00"), at("2026-08-10 10:00"))!;
    expect(d.skipped).toBe(2); // the 8th and the 9th; the 10th is the occurrence
    expect(d.occ).toEqual(at("2026-08-10 09:00"));
  });
});

describe("plan", () => {
  test("fires an occurrence that has just come due", () => {
    const p = plan([weekday("triage")], state({ triage: "2026-08-10 08:30" }), at("2026-08-10 09:00"));
    const d = only(p);
    expect(d.kind).toBe("fire");
    expect(d.trigger).toBe("cron");
    expect(p.changed).toBe(true);
    expect(p.state.last.triage).toBe(at("2026-08-10 09:00").toISOString());
  });

  test("catches up a woken laptop within the window and says it is late", () => {
    const d = only(plan([weekday("triage")], state({ triage: "2026-08-10 07:00" }), at("2026-08-10 10:30")));
    expect(d.kind).toBe("fire");
    expect(d.trigger).toBe("catchup");
    expect(d.lateSeconds).toBe(90 * 60);
  });

  test("writes off an occurrence past the window, with a reason, and still consumes it", () => {
    const p = plan([weekday("triage")], state({ triage: "2026-08-10 07:00" }), at("2026-08-10 17:00"));
    const d = only(p);
    expect(d.kind).toBe("missed");
    expect(d.reason).toContain("catch-up window");
    expect(p.state.last.triage).toBe(at("2026-08-10 09:00").toISOString());
  });

  test("never catches up when the window is disabled (-1)", () => {
    const d = only(plan([weekday("triage", { catchUpMinutes: -1 })], state({ triage: "2026-08-10 08:59" }), at("2026-08-10 09:02")));
    expect(d.kind).toBe("missed");
    expect(d.reason).toContain("catch-up disabled");
  });

  test("fires on the dot even with catch-up disabled", () => {
    const d = only(plan([weekday("triage", { catchUpMinutes: -1 })], state({ triage: "2026-08-10 08:30" }), at("2026-08-10 09:00")));
    expect(d.kind).toBe("fire");
  });

  test("an unset window means the 120 minute default", () => {
    const t: SchedTask = { id: "x", cron: "0 9 * * 1-5" };
    expect(only(plan([t], state({ x: "2026-08-10 07:00" }), at("2026-08-10 10:30"))).kind).toBe("fire");
    expect(only(plan([t], state({ x: "2026-08-10 07:00" }), at("2026-08-10 11:30"))).kind).toBe("missed");
  });

  test("reports the occurrences skipped on the way and still fires the latest", () => {
    const p = plan([weekday("triage")], state({ triage: "2026-08-10 08:00" }), at("2026-08-12 09:30"));
    expect(p.decisions.length).toBe(2);
    expect(p.decisions[0]).toMatchObject({ kind: "missed", count: 2 });
    expect(p.decisions[1].kind).toBe("fire");
  });

  test("registers a new task without firing it", () => {
    const p = plan([weekday("triage")], state(), at("2026-08-10 12:00"));
    expect(only(p).kind).toBe("register");
    expect(p.state.last.triage).toBe(at("2026-08-10 12:00").toISOString());
  });

  test("ignores a paused task", () => {
    const p = plan([weekday("triage", { paused: true })], state({ triage: "2026-08-10 08:00" }), at("2026-08-10 10:00"));
    expect(p.decisions).toEqual([]);
    expect(p.changed).toBe(false);
  });

  test("forgets a task that is gone", () => {
    const p = plan([weekday("a")], state({ a: "2026-08-10 09:00", gone: "2026-08-10 09:00" }), at("2026-08-10 09:30"));
    expect(Object.keys(p.state.last)).toEqual(["a"]);
    expect(p.changed).toBe(true);
  });

  test("is quiet when nothing is due", () => {
    const p = plan([weekday("triage")], state({ triage: "2026-08-10 09:00" }), at("2026-08-10 09:30"));
    expect(p.decisions).toEqual([]);
    expect(p.changed).toBe(false);
  });

  test("skips an entry whose cron cannot be parsed", () => {
    const p = plan([{ id: "bad", cron: "nope" }], state({ bad: "2026-08-10 08:00" }), at("2026-08-10 10:00"));
    expect(p.decisions).toEqual([]);
  });

  test("passes over what is due while globally paused, and never catches it up", () => {
    const p = plan([weekday("triage")], state({ triage: "2026-08-10 08:00" }), at("2026-08-10 09:05"), { paused: true });
    expect(only(p)).toMatchObject({ kind: "paused", count: 1 });
    expect(plan([weekday("triage")], p.state, at("2026-08-10 09:06")).decisions).toEqual([]);
  });

  test("a restart does not replay: the state it saved is the occurrence it consumed", () => {
    const first = plan([weekday("t")], state({ t: "2026-08-10 08:30" }), at("2026-08-10 09:00"));
    expect(first.decisions.length).toBe(1);
    const second = plan([weekday("t")], first.state, at("2026-08-10 09:00"));
    expect(second.decisions).toEqual([]);
  });
});

describe("nextRun", () => {
  test("says so when the cron cannot be parsed", () => {
    expect(nextRun("nope", new Date())).toBeNull();
    expect(nextRun("0 9 * * *", at("2026-08-10 10:00"))).toEqual(at("2026-08-11 09:00"));
  });
});

import { effectiveCatchUp as eff } from "../src/schedule.ts";
test("effectiveCatchUp: the task wins, then the Settings default", () => {
  expect(eff(undefined, 720)).toBe(720);
  expect(eff(0, 720)).toBe(720);
  expect(eff(30, 720)).toBe(30);
  expect(eff(-1, 720)).toBe(-1);
  expect(eff(undefined, undefined)).toBeUndefined();
});
