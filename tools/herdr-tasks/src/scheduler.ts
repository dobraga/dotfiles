// The side-effecting half of the scheduler: asks `plan` what should happen now and does it (after the evaluate loop in
// herdr-automations' internal/daemon, MIT, see NOTICE.md). Every dependency is injected so the sleep, overlap and
// restart behaviour can be tested with a fake clock and fake runs.

import { plan, type State, type SchedTask, effectiveCatchUp } from "./schedule.ts";
import { newRunId, type Run } from "./history.ts";
import type { Task } from "./tasks.ts";
import type { Executed } from "./exec.ts";

export interface Deps {
  now(): Date;
  loadTasks(): Task[];
  loadState(): State;
  saveState(s: State): void;
  append(rec: Partial<Run> & { run_id: string }): void;
  execute(task: Task): Promise<Executed>;
  log(msg: string): void;
  /** Global pause (every task): occurrences that come due meanwhile are recorded and passed over, never caught up. */
  paused?(): boolean;
  /** The Settings default catch-up window in minutes (-1 = only on time), read on every tick. */
  defaultCatchUp?(): number | undefined;
  /** Persists a run's Markdown document and returns the file path (optional: tests skip it). */
  writeOutput?(runId: string, doc: string, meta?: { results?: Record<string, any>; worktree?: string; branch?: string }): string | undefined;
}

export class Scheduler {
  private running = new Set<string>();
  private active = new Set<Promise<void>>();
  state: State;

  constructor(private d: Deps) {
    this.state = d.loadState();
  }

  busy() { return this.running.size > 0; }
  /** Resolves when every run started so far has finished (tests, and a clean shutdown). */
  idle() { return Promise.all([...this.active]).then(() => undefined); }

  /** One tick: decide, record, and start what is due. Returns without waiting for the runs. */
  tick(): void {
    const tasks = this.d.loadTasks().filter((t) => t.schedule?.cron);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const sched: SchedTask[] = tasks.map((t) => ({ id: t.id, cron: t.schedule!.cron, paused: t.paused, catchUpMinutes: effectiveCatchUp(t.catchUpMinutes, this.d.defaultCatchUp?.()) }));
    const now = this.d.now();
    const res = plan(sched, this.state, now, { paused: this.d.paused?.() });
    this.state = res.state;

    for (const dec of res.decisions) {
      const task = byId.get(dec.id)!;
      if (dec.kind === "register") this.d.log(`${task.name}: scheduled, next run ${dec.at.toString()}`);
      else if (dec.kind === "missed") {
        this.d.append({ run_id: newRunId(task.id), task: task.id, name: task.name, status: "missed", reason: dec.reason, at: now.toISOString() });
        this.d.log(`${task.name}: missed (${dec.reason})`);
      } else if (dec.kind === "paused") {
        this.d.append({ run_id: newRunId(task.id), task: task.id, name: task.name, status: "skipped", reason: "all tasks are paused", at: now.toISOString() });
        this.d.log(`${task.name}: passed over, all tasks are paused`);
      } else if (dec.kind === "fire") this.fire(task, dec.trigger, dec.lateSeconds);
    }
    if (res.changed) this.d.saveState(this.state);
  }

  /** Start a run now (a due occurrence, or a manual request). A task already running is skipped and the skip is recorded. */
  fire(task: Task, trigger: "cron" | "catchup" | "manual", lateSeconds = 0): void {
    const run_id = newRunId(task.id);
    const started = this.d.now().toISOString();
    if (this.running.has(task.id)) {
      this.d.append({ run_id, task: task.id, name: task.name, status: "skipped", trigger, reason: "previous run still running", at: started });
      this.d.log(`${task.name}: skipped, previous run still running`);
      return;
    }
    this.running.add(task.id);
    this.d.append({ run_id, task: task.id, name: task.name, status: "running", trigger, started, at: started, pid: process.pid, ...(lateSeconds > 60 ? { late_seconds: lateSeconds } : {}) });
    if (trigger === "catchup") this.d.log(`${task.name}: running ${Math.round(lateSeconds / 60)}m late`);
    const p = (async () => {
      let out: Executed;
      try { out = await this.d.execute(task); }
      catch (e) { out = { status: "failed", exit_code: -1, seconds: 0, error: e instanceof Error ? e.message : String(e) }; }
      const { output, results, ...record } = out as Executed & { output?: string };
      const output_file = output ? this.d.writeOutput?.(run_id, output, { results, worktree: record.worktree, branch: record.branch }) : undefined;
      this.d.append({ run_id, task: task.id, name: task.name, ...record, ...(output_file ? { output_file } : {}), at: this.d.now().toISOString() });
      this.d.log(`${task.name}: ${out.status}${out.exit_code ? ` (exit ${out.exit_code})` : ""}`);
    })().finally(() => { this.running.delete(task.id); this.active.delete(p); });
    this.active.add(p);
  }
}
