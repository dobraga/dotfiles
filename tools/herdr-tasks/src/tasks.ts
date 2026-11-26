// Reads the task store the Tasks panel writes (~/.config/herdr-app/data/tasks/tasks.json: folders -> tasks).
// Only command, script and set tasks are ours; prompt tasks belong to herdr-automations.

import { homedir } from "node:os";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface Step {
  id: string;
  /** "task": a reference (`ref`) to a saved task or set; resolved when the set runs. */
  kind: "command" | "prompt" | "task" | "set";
  ref?: string;
  /** Extra context appended to a referenced prompt; the only place results can be inserted for a reference. */
  input?: string;
  command?: string;
  prompt?: string;
  agent?: string;
  model?: string;
  effort?: string;
  cwd?: string;
  when?: "always" | "prev_ok" | "prev_output";
  onFailure?: "stop" | "continue";
  permission?: "read-only" | "edit" | "full";
}

export interface Task {
  id: string;
  name: string;
  kind: "command" | "script" | "set" | "prompt";
  /** The folder the task was defined for (its key in the store). */
  folder: string;
  command?: string;
  cwd?: string;
  steps?: Step[];
  /** Prompt tasks (one-step sets): what to ask, who, and how freely it may act. */
  prompt?: string;
  agent?: string;
  model?: string;
  effort?: string;
  permission?: "read-only" | "edit" | "full";
  /** "worktree" (a new git worktree and branch per run) or "root" (the folder itself). */
  workspace?: "worktree" | "root";
  schedule?: { cron: string } | null;
  paused?: boolean;
  catchUpMinutes?: number;
  timeoutMinutes?: number;
}

export function parseTasks(text: string): Task[] {
  let j: any;
  try { j = JSON.parse(text); } catch { return []; }
  const out: Task[] = [];
  for (const [folder, list] of Object.entries<any>(j?.folders ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const t of list) if (t && typeof t.id === "string" && typeof t.name === "string") out.push({ ...t, folder: folder.startsWith("@") ? homedir() : folder }); // "@work": a space-profile task, runs from home
  }
  return out;
}

export function loadTasks(file: string): Task[] {
  return existsSync(file) ? parseTasks(readFileSync(file, "utf8")) : [];
}

/** Tasks this daemon schedules: everything with a cron. A paused one is still returned; the planner skips it. */
export const scheduledTasks = (tasks: Task[]) => tasks.filter((t) => t.schedule?.cron);

/** Pause or resume one task in the shared store (atomic write; every other field is kept as it was). */
export function setPaused(file: string, id: string, paused: boolean): boolean {
  if (!existsSync(file)) return false;
  const j = JSON.parse(readFileSync(file, "utf8"));
  let found = false;
  for (const list of Object.values<any>(j.folders ?? {})) for (const t of list) if (t?.id === id) { t.paused = paused; found = true; }
  if (!found) return false;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n");
  renameSync(tmp, file);
  return true;
}
