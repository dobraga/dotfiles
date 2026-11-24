// One-time import of a herdr-automations `automations.yaml` into our task store, so retiring that scheduler loses nothing.
// Pure: takes the parsed YAML and the existing store, returns the new store and what could not be carried over.

import { homedir } from "node:os";
import { join } from "node:path";

export interface ImportReport { added: string[]; skipped: { name: string; why: string }[]; warnings: string[] }

const expand = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
const newId = (name: string, used: Set<string>) => {
  const base = `a-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task"}`;
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
};

/** Fields we do not support yet are reported, never silently dropped. */
const UNSUPPORTED = ["gate", "workflow", "session", "mcp_config", "agent_args", "template"] as const;

export function importAutomations(parsed: any, store: any, home = homedir()): { store: any; report: ImportReport } {
  const report: ImportReport = { added: [], skipped: [], warnings: [] };
  const next = { version: 1, folders: JSON.parse(JSON.stringify(store?.folders ?? {})) } as { version: number; folders: Record<string, any[]> };
  const used = new Set<string>(Object.values(next.folders).flat().map((t: any) => t.id));
  const existingNames = new Set(Object.values(next.folders).flat().map((t: any) => `${t.name}`));

  for (const a of Array.isArray(parsed?.automations) ? parsed.automations : []) {
    const name = String(a?.name ?? "").trim();
    if (!name) { report.skipped.push({ name: "(no name)", why: "an entry without a name" }); continue; }
    if (existingNames.has(name)) { report.skipped.push({ name, why: "a task with this name already exists" }); continue; }
    if (a.workflow) { report.skipped.push({ name, why: "it delegates to a herdr-workflows workflow, which has no equivalent here" }); continue; }
    if (a.template) { report.skipped.push({ name, why: `it uses the hc template "${a.template}", which has no equivalent here` }); continue; }
    if (!a.prompt) { report.skipped.push({ name, why: "it has no prompt" }); continue; }
    if (!a.repo) { report.skipped.push({ name, why: "it has no repo (folder)" }); continue; }
    const folder = expand(String(a.repo), home).replace(/\/+$/, "") || "/";
    for (const k of UNSUPPORTED) if (a[k] && k !== "workflow" && k !== "template") report.warnings.push(`${name}: "${k}" is not supported yet and was dropped`);
    const task: any = {
      id: newId(name, used), name, kind: "prompt",
      prompt: String(a.prompt), agent: a.agent || "claude",
      ...(a.model ? { model: String(a.model) } : {}),
      // The old scheduler's default is a worktree per run, with agents asking for permission interactively. Headless
      // runs cannot ask, so they start read-only; the user raises it knowingly in the form.
      workspace: a.workspace === "root" ? "root" : "worktree",
      permission: "read-only",
      schedule: { cron: String(a.cron ?? "") },
      paused: Boolean(a.disabled),
      ...(a.catch_up_minutes ? { catchUpMinutes: Number(a.catch_up_minutes) } : {}),
      ...(a.timeout_minutes ? { timeoutMinutes: Number(a.timeout_minutes) } : {}),
    };
    if (a.workspace === "existing") report.warnings.push(`${name}: "workspace: existing" has no equivalent; it now uses a new worktree`);
    (next.folders[folder] ??= []).push(task);
    existingNames.add(name);
    report.added.push(name);
  }
  return { store: next, report };
}
