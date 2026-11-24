#!/usr/bin/env bun
// herdr-tasks: scheduler for shell commands, scripts and sets of steps (see NOTICE.md for the design it is ported from).
//
//   herdr-tasks daemon [--standby]        run the scheduler (the login service does this)
//   herdr-tasks ls --json                 our tasks with next run and last run, and the scheduler's pid (0 = stopped)
//   herdr-tasks history --json [--task id] [--limit n]
//   herdr-tasks run <task-id> [--wait]    run a task now (detached unless --wait)
//   herdr-tasks pause|resume <task-id> | --all     pause one task, or every task (a global flag the daemon honours)
//   herdr-tasks worktrees prune           remove clean worktrees that never got commits of their own
//   herdr-tasks import-automations [file] one-time import of a herdr-automations automations.yaml
//   herdr-tasks seen <run-id> | --all     mark runs as read
//   herdr-tasks next "<cron>" [--count n] --json     validate a cron and list the next runs
//   herdr-tasks service install|uninstall|status
//   herdr-tasks ask --agent a [--model m] [--effort e] [--prompt-file f]   one headless question (prompt on stdin or in a file), answer as JSON; used by the Inbox
//   herdr-tasks version

import { spawn } from "node:child_process";
import { runDaemon, lockHolder, writeRunDocument, writeRunResults, readRunResults } from "./daemon.ts";
import { executeTask } from "./exec.ts";
import { append, latest, markSeen, newRunId } from "./history.ts";
import { cronProblem, nextRuns } from "./cron.ts";
import { nextRun } from "./schedule.ts";
import { paths } from "./paths.ts";
import * as service from "./service.ts";
import { loadTasks, setPaused } from "./tasks.ts";
import { pruneWorktrees } from "./worktree.ts";
import { importAutomations } from "./import.ts";
import { HEADLESS } from "./agents.ts";
import { runArgv } from "./runner.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const VERSION = "0.1.0";
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const die = (m: string, code = 1): never => { console.error(`error: ${m}`); process.exit(code); };

const p = paths();
const [cmd, sub] = args;

async function main() {
  switch (cmd) {
    case "version": console.log(VERSION); return;

    case "ask": {
      // A one-shot question for other tools (the Inbox classifier): no tools are needed, so it runs read-only from an empty
      // temp dir. Prompt on stdin; prints {answer, error?}. Same agent table as scheduled prompts.
      const agent = opt("--agent") ?? "claude";
      const h = HEADLESS[agent] ?? die(`agent "${agent}" has no headless mode`);
      const file = opt("--prompt-file"); // exec-style callers cannot pipe stdin
      const prompt = (file ? readFileSync(file, "utf8") : await Bun.stdin.text()).trim() || die("ask needs the prompt on stdin or --prompt-file");
      const cwd = mkdtempSync(join(tmpdir(), "herdr-ask-"));
      try {
        const o = await runArgv(h.argv(prompt, { model: opt("--model") || undefined, effort: opt("--effort") || undefined, permission: "read-only" }), { cwd, timeoutMs: Number(opt("--timeout") ?? 60) * 1000 });
        const r = h.read(o.stdout);
        json({ answer: r.answer, ...(o.error || r.error || o.failed ? { error: o.error ?? r.error ?? (o.stderr.trim().slice(-300) || `exit ${o.exit_code}`) } : {}) });
        process.exit(o.failed || r.error ? 1 : 0);
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    }

    case "daemon": await runDaemon({ standby: flag("--standby"), tickMs: process.env.HERDR_TASKS_TICK_MS ? Number(process.env.HERDR_TASKS_TICK_MS) : undefined }); return;

    case "ls": {
      const runs = latest(p.history);
      const now = new Date();
      json({
        scheduler: lockHolder(p.lock),
        paused_all: existsSync(p.pauseFlag),
        tasks: loadTasks(p.tasks).map((t) => ({
          id: t.id, name: t.name, kind: t.kind, folder: t.folder, cron: t.schedule?.cron ?? null, paused: Boolean(t.paused),
          next: t.schedule?.cron && !t.paused ? nextRun(t.schedule.cron, now)?.toISOString() ?? null : null,
          last: runs.find((r) => r.task === t.id && r.status !== "running" && r.status !== "skipped") ?? null,
        })),
      });
      return;
    }

    case "history": {
      const task = opt("--task");
      const limit = Number(opt("--limit") ?? 200);
      json(latest(p.history).filter((r) => !task || r.task === task).slice(0, limit));
      return;
    }

    case "run": {
      const id = sub ?? die("run needs a task id");
      const task = loadTasks(p.tasks).find((t) => t.id === id) ?? die(`no task "${id}"`);
      if (!flag("--wait") && !flag("--foreground")) {
        // exec-style callers give up after 30 s: start a detached copy of ourselves and answer at once.
        const child = spawn(process.execPath, [process.argv[1], "run", id, "--foreground", ...args.slice(2).filter((a) => a !== "--wait" && a !== "--foreground")], { detached: true, stdio: "ignore", env: process.env });
        child.unref();
        json({ started: true, task: id });
        return;
      }
      const run_id = newRunId(task.id);
      const started = new Date().toISOString();
      append(p.history, { run_id, task: task.id, name: task.name, status: "running", trigger: "manual", started, pid: process.pid });
      // Retry: `--from <step-id> --retry-of <run-id>` resumes a set at a step with the earlier run's results and worktree.
      const from = opt("--from"), retryOf = opt("--retry-of");
      const prior = retryOf ? readRunResults(p.runs, retryOf) : null;
      if (from && !prior?.results) die(`run ${retryOf ?? "(none)"} has no saved results to resume from`);
      const { output, results, ...res } = await executeTask(task, {
        worktrees: p.worktrees, tasks: loadTasks(p.tasks),
        ...(from ? { from, seed: prior?.results, reuse: prior?.worktree && prior.branch ? { path: prior.worktree, branch: prior.branch } : undefined } : {}),
      });
      const out = res;
      if (results) writeRunResults(p.runs, run_id, { results, worktree: res.worktree, branch: res.branch });
      append(p.history, { run_id, task: task.id, name: task.name, ...res, ...(output ? { output_file: writeRunDocument(p.runs, run_id, output) } : {}) });
      if (flag("--wait")) json({ run_id, ...out });
      process.exit(out.status === "done" ? 0 : 1);
    }

    case "pause":
    case "resume": {
      const paused = cmd === "pause";
      if (flag("--all")) {
        mkdirSync(dirname(p.pauseFlag), { recursive: true });
        if (paused) writeFileSync(p.pauseFlag, new Date().toISOString());
        else rmSync(p.pauseFlag, { force: true });
        return;
      }
      if (!setPaused(p.tasks, sub ?? die(`${cmd} needs a task id or --all`), paused)) die(`no task "${sub}"`);
      return;
    }

    case "worktrees": {
      if (sub !== "prune") die("worktrees needs: prune");
      json(await pruneWorktrees(p.worktrees));
      return;
    }

    case "import-automations": {
      const file = sub && !sub.startsWith("--") ? sub : join(p.home, ".config/herdr/plugins/config/dnzzl.automations/automations.yaml");
      if (!existsSync(file)) die(`no such file: ${file}`);
      const parsed = (Bun as any).YAML.parse(readFileSync(file, "utf8"));
      const store = existsSync(p.tasks) ? JSON.parse(readFileSync(p.tasks, "utf8")) : { version: 1, folders: {} };
      const { store: next, report } = importAutomations(parsed, store, p.home);
      if (!flag("--dry-run") && report.added.length) {
        mkdirSync(dirname(p.tasks), { recursive: true });
        const tmp = `${p.tasks}.tmp`;
        writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
        renameSync(tmp, p.tasks);
      }
      json({ file, dryRun: flag("--dry-run"), ...report });
      return;
    }

    case "seen": {
      if (flag("--all")) markSeen(p.history, latest(p.history).filter((r) => r.status !== "running" && !r.seen).map((r) => r.run_id));
      else markSeen(p.history, [sub ?? die("seen needs a run id or --all")]);
      return;
    }

    case "next": {
      const expr = sub ?? die("next needs a cron expression");
      const problem = cronProblem(expr);
      if (problem) { json({ problem }); process.exit(1); }
      json({ next: nextRuns(expr, new Date(), Number(opt("--count") ?? 3)).map((d) => d.toISOString()) });
      return;
    }

    case "service": {
      if (sub === "install") {
        const exe = process.env.HERDR_TASKS_BIN ?? process.argv[1].replace(/src\/cli\.ts$/, "bin/herdr-tasks");
        const env: Record<string, string> = { HOME: p.home, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
        for (const k of ["HERDR_TASKS_STATE", "HERDR_TASKS_DATA"]) if (process.env[k]) env[k] = process.env[k]!;
        console.log(`installed ${service.install({ exe, logs: p.log, env })}`);
      } else if (sub === "uninstall") { service.uninstall(); console.log("uninstalled"); }
      else if (sub === "status") json({ ...service.status(), scheduler: lockHolder(p.lock) });
      else die("service needs install, uninstall or status");
      return;
    }

    default:
      console.log("usage: herdr-tasks daemon|ls|history|run|seen|next|service|version (see the header of src/cli.ts)");
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
