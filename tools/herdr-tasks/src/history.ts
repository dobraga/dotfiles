// Append-only JSONL run log (after herdr-automations' internal/history, MIT, see NOTICE.md). One line per change of a
// run; readers fold the lines of a run id into its latest state. Nothing is ever rewritten in place, so a crash can
// at worst lose the last line.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Status = "running" | "done" | "failed" | "skipped" | "missed" | "cancelled";
export type Trigger = "cron" | "catchup" | "manual";

export interface Run {
  run_id: string;
  task: string;
  name?: string;
  status: Status;
  trigger?: Trigger;
  started?: string;
  /** When this record was written (for a finished run, when it finished). */
  at: string;
  seconds?: number;
  exit_code?: number;
  error?: string;
  reason?: string;
  /** Seconds past its due time when it started (catch-up runs). */
  late_seconds?: number;
  /** Prompt runs in a new worktree: where, and on which branch. */
  worktree?: string;
  branch?: string;
  /** A Markdown file with the full input and output of this run (prompt runs and sets), for the file viewer. */
  output_file?: string;
  /** Last lines of output, for the detail view. */
  tail?: string;
  /** For sets: one entry per step. */
  steps?: { id: string; status: string; exit_code?: number; tail?: string; reason?: string }[];
  seen?: boolean;
  /** Process that is running this record, so a run whose process vanished can be closed. */
  pid?: number;
}

export const newRunId = (task: string, now = Date.now()) => `${task}-${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function append(file: string, rec: Partial<Run> & { run_id: string }): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n");
}

/** Latest state per run id, newest first. Lines that are not valid records are ignored. */
export function latest(file: string): Run[] {
  if (!existsSync(file)) return [];
  const byId = new Map<string, Run>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!r || typeof r.run_id !== "string") continue;
      byId.set(r.run_id, { ...(byId.get(r.run_id) ?? {}), ...r });
    } catch {}
  }
  return [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export function markSeen(file: string, runIds: string[]): void {
  for (const id of runIds) append(file, { run_id: id, seen: true });
}

/** Keep the file small: past `maxBytes`, keep only the newest `keepLines` lines (written atomically). */
export function trim(file: string, maxBytes = 5 * 1024 * 1024, keepLines = 2000): boolean {
  if (!existsSync(file) || statSync(file).size <= maxBytes) return false;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, lines.slice(-keepLines).join("\n") + "\n");
  renameSync(tmp, file);
  return true;
}

/** Runs still marked "running": left behind by a daemon that died mid-run. */
export const orphans = (file: string): Run[] => latest(file).filter((r) => r.status === "running");
