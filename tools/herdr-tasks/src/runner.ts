// Runs one thing and reports how it ended (after herdr-automations' internal/runner, MIT, see NOTICE.md).
// Commands run as `sh -c` in the task's folder; prompts run headless through the agent's print mode so their answer
// can be captured and passed to a later step.

export interface Outcome {
  exit_code: number;
  failed: boolean;
  stdout: string;
  stderr: string;
  /** For prompt steps: the agent's answer. */
  response: string;
  seconds: number;
  error?: string;
  timedOut?: boolean;
}

export interface RunOpts {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Kill the process after this many ms (SIGTERM, then SIGKILL after 5 s). Default 60 minutes. */
  timeoutMs?: number;
  /** Keep at most this many bytes of each stream (the end of it). */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT = 60 * 60_000;

export const humanDuration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} seconds` : `${Math.round(ms / 60_000)} minutes`);
const DEFAULT_MAX = 256 * 1024;

async function collect(stream: ReadableStream<Uint8Array> | null | undefined, max: number): Promise<string> {
  if (!stream) return "";
  const dec = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += dec.decode(chunk, { stream: true });
    if (text.length > max * 2) text = text.slice(-max); // bounded memory; the end is what matters
  }
  text += dec.decode();
  return text.length > max ? text.slice(-max) : text;
}

export async function runArgv(argv: string[], opts: RunOpts): Promise<Outcome> {
  const started = Date.now();
  const max = opts.maxBytes ?? DEFAULT_MAX;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // detached: the command leads its own process group, so a timeout can kill it and everything it started
    // (killing only the shell would leave a child holding the output pipes open until it ends).
    proc = Bun.spawn(argv, { cwd: opts.cwd, env: { ...process.env, ...opts.env } as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true } as any);
  } catch (e) {
    return { exit_code: 127, failed: true, stdout: "", stderr: "", response: "", seconds: 0, error: e instanceof Error ? e.message : String(e) };
  }
  let timedOut = false;
  const killGroup = (sig: NodeJS.Signals) => { try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch {} } };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 5000).unref?.();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT);
  const [stdout, stderr] = await Promise.all([collect(proc.stdout as ReadableStream<Uint8Array>, max), collect(proc.stderr as ReadableStream<Uint8Array>, max)]);
  const code = await proc.exited;
  clearTimeout(timer);
  const exit_code = timedOut ? 124 : code;
  return {
    exit_code, failed: exit_code !== 0, stdout, stderr, response: "", seconds: Math.round((Date.now() - started) / 1000),
    ...(timedOut ? { timedOut: true, error: `timed out after ${humanDuration(opts.timeoutMs ?? DEFAULT_TIMEOUT)}` } : {}),
  };
}

export const runCommand = (command: string, opts: RunOpts) => runArgv(["sh", "-c", command], opts);

import { HEADLESS, type Permission } from "./agents.ts";

/** Headless argv for an agent's print mode, or null when we do not know how to run that agent without a terminal. */
export function promptArgv(agent: string, prompt: string, model?: string, effort?: string, permission: Permission = "read-only"): string[] | null {
  return HEADLESS[agent]?.argv(prompt, { model, effort, permission }) ?? null;
}

/** The agent's answer from its JSON print-mode output; falls back to the raw text. */
export function parseAnswer(stdout: string, agent = "claude"): string {
  return (HEADLESS[agent] ?? HEADLESS.claude).read(stdout).answer;
}

export async function runPrompt(step: { agent?: string; model?: string; effort?: string; permission?: Permission }, prompt: string, opts: RunOpts): Promise<Outcome> {
  const agent = step.agent ?? "claude";
  const argv = promptArgv(agent, prompt, step.model, step.effort, step.permission);
  if (!argv) return { exit_code: 127, failed: true, stdout: "", stderr: "", response: "", seconds: 0, error: `agent "${agent}" has no headless mode here` };
  const o = await runArgv(argv, opts);
  const read = HEADLESS[agent].read(o.stdout);
  const failed = o.failed || Boolean(read.error);
  return { ...o, failed, exit_code: o.failed ? o.exit_code : read.error ? 1 : 0, response: failed ? "" : read.answer, error: o.error ?? read.error };
}
