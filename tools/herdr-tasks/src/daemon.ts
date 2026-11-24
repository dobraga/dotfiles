// The long-running process: one lock, a tick every 30 s that asks the Scheduler what is due, atomic state writes.
// After herdr-automations' internal/daemon (MIT, see NOTICE.md). Standby mode waits for the lock instead of failing,
// so a login service and a manual start never double-fire: whichever comes second takes over when the first stops.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { executeTask, defaultCatchUpMinutes } from "./exec.ts";
import { append, orphans, trim } from "./history.ts";
import { Scheduler } from "./scheduler.ts";
import { loadTasks } from "./tasks.ts";
import { paths } from "./paths.ts";
import type { State } from "./schedule.ts";

export const TICK_MS = 30_000;

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** Takes the lock, or returns null when a live process holds it. A stale file (dead pid) is replaced. */
export function acquireLock(file: string): (() => void) | null {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => { try { if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file); } catch {} };
    } catch {
      const held = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(held) && held > 0 && pidAlive(held)) return null;
      try { unlinkSync(file); } catch {}
    }
  }
  return null;
}

export function loadState(file: string): State {
  try { const j = JSON.parse(readFileSync(file, "utf8")); if (j?.last && typeof j.last === "object") return { last: j.last }; } catch {}
  return { last: {} };
}

export function saveState(file: string, s: State): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, file);
}

export async function runDaemon(opts: { standby?: boolean; tickMs?: number } = {}): Promise<void> {
  const p = paths();
  mkdirSync(p.state, { recursive: true });
  const log = (msg: string) => { try { appendFileSync(p.log, `${new Date().toISOString()} ${msg}\n`); } catch {} console.log(msg); };
  const tickMs = opts.tickMs ?? TICK_MS;

  let release = acquireLock(p.lock);
  while (!release && opts.standby) {
    log("another scheduler holds the lock; standing by");
    await new Promise((r) => setTimeout(r, tickMs));
    release = acquireLock(p.lock);
  }
  if (!release) throw new Error("another herdr-tasks scheduler is already running");

  // A daemon that died mid-run leaves runs marked "running" forever: close them honestly.
  for (const r of orphans(p.history)) append(p.history, { run_id: r.run_id, task: r.task, name: r.name, status: "failed", error: "interrupted: the scheduler restarted during this run" });
  trim(p.history);

  const sched = new Scheduler({
    now: () => new Date(),
    loadTasks: () => loadTasks(p.tasks),
    loadState: () => loadState(p.stateFile),
    saveState: (s) => saveState(p.stateFile, s),
    append: (rec) => append(p.history, rec),
    execute: (task) => executeTask(task, { worktrees: p.worktrees, tasks: loadTasks(p.tasks) }),
    paused: () => existsSync(p.pauseFlag),
    defaultCatchUp: () => defaultCatchUpMinutes(),
    writeOutput: (id, doc, meta) => { if (meta?.results) writeRunResults(p.runs, id, meta); return writeRunDocument(p.runs, id, doc); },
    log,
  });
  log(`herdr-tasks daemon started (pid ${process.pid}), tasks ${p.tasks}`);

  const stop = async (sig: string) => {
    log(`received ${sig}, shutting down`);
    clearInterval(timer);
    await sched.idle();
    release!();
    process.exit(0);
  };
  // A manual run is its own process; if that process vanished (killed, crashed) its record would say "running" forever.
  const reap = () => { for (const r of orphans(p.history)) if (r.pid && r.pid !== process.pid && !pidAlive(r.pid)) append(p.history, { run_id: r.run_id, task: r.task, name: r.name, status: "failed", error: "interrupted: the process running this task ended without finishing" }); };
  const safeTick = () => { try { reap(); sched.tick(); } catch (e) { log(`tick error: ${e instanceof Error ? e.message : e}`); } };
  safeTick(); // do not wait a full tick to notice what is already due
  const timer = setInterval(safeTick, tickMs);
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  await new Promise(() => {}); // run until a signal
}

export const lockHolder = (file: string): number => {
  try { const pid = Number(readFileSync(file, "utf8").trim()); return pidAlive(pid) ? pid : 0; } catch { return 0; }
};
export { existsSync };

/** Writes a run's Markdown to <runs>/<run-id>.md (atomic) and returns the path. Old documents are pruned by count. */
export function writeRunResults(dir: string, runId: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${runId}.json`;
  writeFileSync(`${file}.tmp`, JSON.stringify(data));
  renameSync(`${file}.tmp`, file);
}

export function readRunResults(dir: string, runId: string): { results?: Record<string, any>; worktree?: string; branch?: string } | null {
  try { return JSON.parse(readFileSync(`${dir}/${runId}.json`, "utf8")); } catch { return null; }
}

export function writeRunDocument(dir: string, runId: string, doc: string): string {
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${runId}.md`;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, doc);
  renameSync(tmp, file);
  pruneRunDocuments(dir);
  return file;
}

export function pruneRunDocuments(dir: string, keep = 300): void {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".json")).map((f) => ({ f, t: statSync(`${dir}/${f}`).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep * 2)) unlinkSync(`${dir}/${f}`);
  } catch {}
}
