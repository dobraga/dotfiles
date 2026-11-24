import { existsSync, readFileSync } from "node:fs";
// Runs a whole task (a command, a script or a set) and turns the outcome into the fields of a history record.

import { isAbsolute, join } from "node:path";
import { runSet, assignIds, textOf } from "./sets.js";
import { runCommand, runPrompt, type Outcome } from "./runner.ts";
import type { Run } from "./history.ts";
import { createWorktree } from "./worktree.ts";
import { paths } from "./paths.ts";
import { HEADLESS } from "./agents.ts";
import type { Step, Task } from "./tasks.ts";

const TAIL_LINES = 50;
const TAIL_BYTES = 8 * 1024;

/** The last lines of a stream, bounded in lines and bytes. */
export function tailOf(text: string): string {
  const lines = String(text ?? "").replace(/\s+$/, "").split("\n");
  const t = lines.slice(-TAIL_LINES).join("\n");
  return t.length > TAIL_BYTES ? t.slice(-TAIL_BYTES) : t;
}

const folderOf = (task: Task, sub?: string) => (sub ? join(task.folder, sub) : task.folder);
/** The default time limit per run, from Settings → Tasks (`settings.json` beside tasks.json); a task's own limit wins. */
/** The Settings default catch-up window (minutes; -1 = only on time), from the same settings.json. */
export function defaultCatchUpMinutes(file = join(paths().data, "settings.json")): number | undefined {
  try {
    const m = Number(JSON.parse(readFileSync(file, "utf8"))?.catchUpMinutes);
    return Number.isFinite(m) && m !== 0 ? m : undefined;
  } catch { return undefined; }
}
export function defaultTimeoutMinutes(file = join(paths().data, "settings.json")): number | undefined {
  try {
    const m = Number(JSON.parse(readFileSync(file, "utf8"))?.timeoutMinutes);
    return Number.isFinite(m) && m > 0 ? m : undefined;
  } catch { return undefined; }
}
const timeoutOf = (task: Task) => {
  const m = task.timeoutMinutes && task.timeoutMinutes > 0 ? task.timeoutMinutes : defaultTimeoutMinutes();
  return m ? m * 60_000 : undefined;
};

const outputTail = (o: Outcome) => tailOf([o.stdout, o.stderr, o.error ?? ""].filter(Boolean).join("\n"));

export interface Executed extends Pick<Run, "status" | "exit_code" | "seconds" | "error" | "tail" | "steps" | "worktree" | "branch"> {
  /** The run as a Markdown document: each step's input and its full output. Written to a file by the caller. */
  output?: string;
  /** Each step's result (capped), saved beside the Markdown so a failed set can be resumed. */
  results?: Record<string, any>;
}

export interface ExecCtx {
  env?: Record<string, string | undefined>; worktrees?: string; now?: () => Date;
  /** Retry: resume at this step id, with the earlier steps' results and the earlier run's worktree. */
  from?: string; seed?: Record<string, any>; reuse?: { path: string; branch: string };
  /** Every saved task, to resolve a set's references; and the sets already being run above this one (loop guard). */
  tasks?: Task[]; chain?: string[];
}

const MAX_NESTING = 5;

/**
 * Turn a set's reference steps into concrete ones, or say why they cannot run. Nothing runs before this passes, so a
 * deleted task (or a loop) fails the whole set up front with a message that names the step.
 */
export function resolveSteps(task: Task, steps: Step[], ctx: ExecCtx): Step[] | string {
  const byId = new Map((ctx.tasks ?? []).map((t) => [t.id, t]));
  const chain = [...(ctx.chain ?? []), task.id];
  const out: Step[] = [];
  for (const st of steps) {
    if (st.kind !== "task") { out.push(st); continue; }
    const t = st.ref ? byId.get(st.ref) : undefined;
    if (!t) return `step ${st.id} uses a task that no longer exists (${st.ref ?? "none chosen"}): edit the set and pick another`;
    if (chain.includes(t.id)) return `step ${st.id} uses "${t.name}", which would loop back into this set`;
    const base = { id: st.id, when: st.when, onFailure: st.onFailure };
    const where = t.folder === task.folder ? t.cwd : join(t.folder, t.cwd ?? "");
    if (t.kind === "command" || t.kind === "script") out.push({ ...base, kind: "command", command: t.command, cwd: where } as Step);
    else if (t.kind === "prompt") out.push({ ...base, kind: "prompt", prompt: [t.prompt, st.input].filter((x) => x && String(x).trim()).join("\n\n"), agent: t.agent, model: t.model, effort: t.effort, permission: t.permission ?? "read-only" } as Step);
    else {
      if (chain.length >= MAX_NESTING) return `step ${st.id}: sets are nested too deeply (limit ${MAX_NESTING})`;
      out.push({ ...base, kind: "set", subtask: t } as unknown as Step);
    }
  }
  return out;
}

const MAX_DOC = 256 * 1024;
const capResult = (r: any) => Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v !== "object").map(([k, v]) => [k, typeof v === "string" && v.length > 100 * 1024 ? v.slice(-100 * 1024) : v]));

/** The Markdown a run leaves behind: what was asked and what came back, step by step. */
export function runDocument(task: Task, status: string, seconds: number, steps: { step: Step; input: string; output: string; status: string }[], extra: { branch?: string; error?: string } = {}): string {
  const head = `# ${task.name}\n\n*${new Date().toISOString()} · ${status} · ${seconds}s${extra.branch ? ` · branch ${extra.branch}` : ""}*\n`;
  const body = steps.map(({ step, input, output, status: st }) =>
    `\n## ${steps.length > 1 ? `${step.id} (${step.kind}) · ${st}` : "Input"}\n\n${steps.length > 1 ? "**Input**\n\n" : ""}${"```"}${step.kind === "command" ? "sh" : ""}\n${input}\n${"```"}\n\n${steps.length > 1 ? "**Output**" : "## Output"}\n\n${output || "(empty)"}\n`).join("");
  const err = extra.error ? `\n---\n\n**Error:** ${extra.error}\n` : "";
  const doc = head + body + err;
  return doc.length > MAX_DOC ? doc.slice(0, MAX_DOC) + "\n\n*(truncated)*\n" : doc;
}

/** A prompt task is a set of one prompt step; its permission, agent, model and effort travel with the step. */
export const stepsOf = (task: Task): Step[] =>
  task.kind === "prompt"
    ? [{ id: "s1", kind: "prompt", prompt: task.prompt, agent: task.agent, model: task.model, effort: task.effort, permission: task.permission ?? "read-only" }]
    : ((task.steps ?? []) as Step[]);

export async function executeTask(task: Task, ctx: ExecCtx = {}): Promise<Executed> {
  const env = ctx.env;
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);

  if (task.kind === "set" || task.kind === "prompt") {
    const assigned = assignIds(stepsOf(task)) as Step[];
    const resolved = resolveSteps(task, assigned, ctx);
    if (typeof resolved === "string") return { status: "failed", exit_code: 1, seconds: seconds(), error: resolved };
    const steps = resolved;
    // A new worktree per run for tasks that ask for one and have a prompt step (prompts are the ones that edit).
    let root = task.folder;
    let wt: { path: string; branch: string } | undefined;
    if (ctx.reuse && existsSync(ctx.reuse.path)) { wt = ctx.reuse; root = wt.path; }
    else if (task.workspace === "worktree" && steps.some((s) => s.kind === "prompt")) {
      try { wt = await createWorktree(task.folder, task.name, ctx.worktrees ?? join(task.folder, ".git", "herdr-worktrees"), ctx.now?.()); root = wt.path; }
      catch (e) { return { status: "failed", exit_code: 1, seconds: seconds(), error: e instanceof Error ? e.message : String(e) }; }
    }
    // An agent whose read-only mode is not trustworthy may only be asked for it inside a throwaway worktree.
    if (!wt) {
      const risky = steps.find((st) => st.kind === "prompt" && (st.permission ?? task.permission ?? "read-only") === "read-only" && HEADLESS[st.agent ?? "claude"]?.reliableReadOnly === false);
      if (risky) return { status: "failed", exit_code: 1, seconds: seconds(), error: `${risky.agent} has no reliable read-only mode: run it in a new worktree, or give the task the "edit" permission knowingly` };
    }
    const docSteps: { step: Step; input: string; output: string; status: string }[] = [];
    const res = await runSet(steps, async (step: Step, text: string, stepEnv: Record<string, string>) => {
      if ((step as any).subtask) {
        const sub = (step as any).subtask as Task;
        const r = await executeTask(sub, { ...ctx, env: { ...env, ...stepEnv }, chain: [...(ctx.chain ?? []), task.id], from: undefined, seed: undefined, reuse: undefined });
        const last = r.results ? Object.values(r.results).pop() : undefined;
        const answer = String(last?.response || last?.stdout || r.tail || "");
        docSteps.push({ step, input: `(runs the set "${sub.name}")`, output: answer || r.error || "", status: r.status === "done" ? "done" : "failed" });
        return { response: answer, stdout: answer, exit_code: r.exit_code ?? (r.status === "done" ? 0 : 1), failed: r.status !== "done", error: r.error, stderr: "" };
      }
      const cwdOf = step.cwd ? (isAbsolute(step.cwd) ? step.cwd : join(root, step.cwd)) : root;
      const opts = { cwd: cwdOf, env: { ...env, ...stepEnv }, timeoutMs: timeoutOf(task) };
      const o = step.kind === "prompt" ? await runPrompt({ ...step, permission: step.permission ?? task.permission }, text, opts) : await runCommand(text, opts);
      docSteps.push({ step, input: text, output: o.response || [o.stdout, o.stderr, o.error ?? ""].filter(Boolean).join("\n").trim(), status: o.failed ? "failed" : "done" });
      return { ...o };
    }, { from: ctx.from ? Math.max(0, steps.findIndex((s) => s.id === ctx.from)) : 0, seed: ctx.seed });
    const failed = res.steps.find((s: any) => s.status === "failed");
    return {
      status: res.status === "done" ? "done" : "failed",
      exit_code: failed?.result?.exit_code ?? 0,
      seconds: seconds(),
      error: failed ? (task.kind === "prompt" ? failed.result?.error ?? "the agent failed" : `step ${failed.id} failed${failed.result?.error ? `: ${failed.result.error}` : ""}`) : undefined,
      // A prompt task shows the agent's answer as its output; a set shows the step outline.
      tail: task.kind === "prompt" ? tailOf(res.steps[0]?.result?.response || (res.steps[0]?.result ? outputTail(res.steps[0].result) : "")) : tailOf(res.steps.map((s: any) => `[${s.id}] ${s.status}${s.reason ? ` (${s.reason})` : ""}`).join("\n")),
      steps: res.steps.map((s: any) => ({
        id: s.id, status: s.status, exit_code: s.result?.exit_code, reason: s.reason,
        tail: s.result ? tailOf(s.result.response || outputTail(s.result)) : undefined,
      })),
      ...(wt ? { worktree: wt.path, branch: wt.branch } : {}),
      output: runDocument(task, res.status, seconds(), docSteps, { branch: wt?.branch, error: failed ? failed.result?.error : undefined }),
      results: Object.fromEntries(res.steps.filter((s: any) => s.result).map((s: any) => [s.id, capResult(s.result)])),
    };
  }

  const command = task.command ?? "";
  if (!command.trim()) return { status: "failed", exit_code: 1, seconds: 0, error: "the task has no command" };
  const o = await runCommand(command, { cwd: folderOf(task, task.cwd), env, timeoutMs: timeoutOf(task) });
  return {
    status: o.failed ? "failed" : "done", exit_code: o.exit_code, seconds: o.seconds, error: o.error, tail: outputTail(o),
    output: runDocument(task, o.failed ? "failed" : "done", o.seconds, [{ step: { id: "s1", kind: "command" } as Step, input: command, output: [o.stdout, o.stderr].filter(Boolean).join("\n").trim(), status: o.failed ? "failed" : "done" }], { error: o.error }),
  };
}

export { textOf };
