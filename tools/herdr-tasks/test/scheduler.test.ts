import { describe, expect, test } from "bun:test";
import { Scheduler, type Deps } from "../src/scheduler.ts";
import type { State } from "../src/schedule.ts";
import type { Run } from "../src/history.ts";
import type { Task } from "../src/tasks.ts";

const t = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);

function rig(tasks: Task[], start: Date, run: (task: Task) => Promise<any> = async () => ({ status: "done", exit_code: 0, seconds: 0 })) {
  let clock = start;
  let saved: State = { last: {} };
  const history: (Partial<Run> & { run_id: string })[] = [];
  const logs: string[] = [];
  const executed: string[] = [];
  const deps: Deps = {
    now: () => clock,
    loadTasks: () => tasks,
    loadState: () => saved,
    saveState: (s) => { saved = JSON.parse(JSON.stringify(s)); },
    append: (r) => history.push(r),
    execute: async (task) => { executed.push(task.id); return run(task); },
    log: (m) => logs.push(m),
  };
  return { deps, history, logs, executed, set: (d: Date) => { clock = d; }, saved: () => saved };
}
const cmd = (id: string, cron: string, extra: Partial<Task> = {}): Task => ({ id, name: id, kind: "command", folder: "/p", command: "true", schedule: { cron }, ...extra });
const statuses = (h: any[], id?: string) => h.filter((r) => !id || r.task === id).map((r) => r.status);

describe("Scheduler", () => {
  test("registers a new task, then fires it on the dot", async () => {
    const r = rig([cmd("a", "0 9 * * *")], t(2026, 8, 10, 8, 30));
    const s = new Scheduler(r.deps);
    s.tick();
    expect(r.executed).toEqual([]); // registered, not fired
    r.set(t(2026, 8, 10, 9, 0));
    s.tick();
    await s.idle();
    expect(r.executed).toEqual(["a"]);
    expect(statuses(r.history)).toEqual(["running", "done"]);
    expect(r.history[0].trigger).toBe("cron");
  });

  test("sleep: wakes inside the window, runs late and records how late", async () => {
    const r = rig([cmd("a", "0 9 * * *")], t(2026, 8, 10, 8, 0));
    const s = new Scheduler(r.deps);
    s.tick(); // registered at 08:00
    r.set(t(2026, 8, 10, 10, 30)); // the lid was shut across 09:00
    s.tick();
    await s.idle();
    expect(r.history[0]).toMatchObject({ status: "running", trigger: "catchup", late_seconds: 90 * 60 });
  });

  test("sleep: past the window the run is recorded as missed, not executed", async () => {
    const r = rig([cmd("a", "0 9 * * *")], t(2026, 8, 10, 8, 0));
    const s = new Scheduler(r.deps);
    s.tick();
    r.set(t(2026, 8, 10, 17, 0));
    s.tick();
    await s.idle();
    expect(r.executed).toEqual([]);
    expect(r.history.map((h) => h.status)).toEqual(["missed"]);
    expect(r.history[0].reason).toContain("catch-up window");
  });

  test("overlap: a run still going makes the next one a recorded skip", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig([cmd("a", "* * * * *")], t(2026, 8, 10, 8, 0), async () => { await gate; return { status: "done", exit_code: 0, seconds: 0 }; });
    const s = new Scheduler(r.deps);
    s.tick();
    r.set(t(2026, 8, 10, 8, 1)); s.tick();
    expect(s.busy()).toBe(true);
    r.set(t(2026, 8, 10, 8, 2)); s.tick();
    expect(statuses(r.history)).toEqual(["running", "skipped"]);
    expect(r.history[1].reason).toBe("previous run still running");
    release();
    await s.idle();
    expect(s.busy()).toBe(false);
    r.set(t(2026, 8, 10, 8, 3)); s.tick();
    await s.idle();
    expect(r.executed.length).toBe(2); // the skipped minute did not queue anything
  });

  test("restart: state persisted by one scheduler stops a new one replaying the occurrence", async () => {
    const r = rig([cmd("a", "0 9 * * *")], t(2026, 8, 10, 8, 30));
    const first = new Scheduler(r.deps);
    first.tick();
    r.set(t(2026, 8, 10, 9, 0));
    first.tick();
    await first.idle();
    const second = new Scheduler(r.deps); // a restarted daemon reads the saved state
    second.tick();
    await second.idle();
    expect(r.executed).toEqual(["a"]);
  });

  test("a failing run is recorded failed with its exit code; an exception is a failed run", async () => {
    const r = rig([cmd("a", "* * * * *"), cmd("b", "* * * * *")], t(2026, 8, 10, 8, 0), async (task) => {
      if (task.id === "a") return { status: "failed", exit_code: 3, seconds: 1, tail: "boom" };
      throw new Error("spawn exploded");
    });
    const s = new Scheduler(r.deps);
    s.tick();
    r.set(t(2026, 8, 10, 8, 1)); s.tick();
    await s.idle();
    const final = r.history.filter((h) => h.status === "failed");
    expect(final.map((h) => `${h.task}:${h.exit_code}`).sort()).toEqual(["a:3", "b:-1"]);
    expect(final.find((h) => h.task === "b")?.error).toBe("spawn exploded");
  });

  test("schedules prompt tasks like any other, and ignores unscheduled and paused tasks", async () => {
    const r = rig([
      { id: "p", name: "p", kind: "prompt", folder: "/p", prompt: "hi", agent: "claude", schedule: { cron: "* * * * *" } },
      { id: "n", name: "n", kind: "command", folder: "/p", command: "true", schedule: null },
      cmd("z", "* * * * *", { paused: true }),
    ], t(2026, 8, 10, 8, 0));
    const s = new Scheduler(r.deps);
    s.tick();
    r.set(t(2026, 8, 10, 8, 5)); s.tick();
    await s.idle();
    expect(r.executed).toEqual(["p"]);
  });

  test("global pause: what comes due is recorded as skipped and never caught up after resuming", async () => {
    let paused = true;
    const r = rig([cmd("a", "* * * * *")], t(2026, 8, 10, 8, 0));
    const s = new Scheduler({ ...r.deps, paused: () => paused });
    s.tick();
    r.set(t(2026, 8, 10, 8, 3)); s.tick();
    await s.idle();
    expect(r.executed).toEqual([]);
    expect(r.history.map((h) => `${h.status}:${h.reason}`)).toEqual(["skipped:all tasks are paused"]);
    paused = false;
    r.set(t(2026, 8, 10, 8, 3)); s.tick(); // same minute: nothing new is due, the holiday is not replayed
    await s.idle();
    expect(r.executed).toEqual([]);
    r.set(t(2026, 8, 10, 8, 4)); s.tick();
    await s.idle();
    expect(r.executed).toEqual(["a"]);
  });

  test("a manual fire runs now and still respects the overlap guard", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig([cmd("a", "0 9 * * *")], t(2026, 8, 10, 8, 0), async () => { await gate; return { status: "done", exit_code: 0, seconds: 0 }; });
    const s = new Scheduler(r.deps);
    s.fire(r.deps.loadTasks()[0], "manual");
    s.fire(r.deps.loadTasks()[0], "manual");
    expect(statuses(r.history)).toEqual(["running", "skipped"]);
    release();
    await s.idle();
  });
});
