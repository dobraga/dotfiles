// How each agent is run without a terminal (print mode): argv, how to read its answer, and how its model, effort
// ("thinking") and permission level map to flags. Data, not branches: adding an agent is adding an entry, and an entry
// is only added once a real call against that CLI has returned an answer (see docs/tasks/plan-tasks-single-scheduler.md).

export type Permission = "read-only" | "edit" | "full";
export const PERMISSIONS: Permission[] = ["read-only", "edit", "full"];

export interface PromptOpts { model?: string; effort?: string; permission?: Permission }

export interface Headless {
  /**
   * False when the agent has no way to stop edits. Plan mode is never used (it opens revu and, for agy, edited a file in
   * print mode anyway), and without a mode flag both agents edit freely in print mode (verified). A step asking for
   * read-only only runs inside a fresh worktree, where an edit is a branch to throw away instead of a change to the
   * working copy.
   */
  reliableReadOnly: boolean;
  argv(prompt: string, o: PromptOpts): string[];
  /** Reads the CLI's JSON output: the answer, and an error message when the CLI reports one. */
  read(stdout: string): { answer: string; error?: string };
}

const tryJson = (text: string): any => { try { return JSON.parse(text.trim()); } catch { return null; } };

export const HEADLESS: Record<string, Headless> = {
  claude: {
    reliableReadOnly: false,
    // Verified: with no mode flag claude edits in print mode; `acceptEdits` is the explicit "edit" level. `result` holds the answer.
    argv: (prompt, o) => [
      "claude", "-p", prompt, "--output-format", "json",
      ...(o.model ? ["--model", o.model] : []),
      ...(o.effort ? ["--effort", o.effort] : []),
      ...(o.permission === "full" ? ["--dangerously-skip-permissions"] : o.permission === "edit" ? ["--permission-mode", "acceptEdits"] : []),
    ],
    read(stdout) {
      const j = tryJson(stdout);
      if (!j) return { answer: stdout.trim() };
      return { answer: typeof j.result === "string" ? j.result : "", error: j.is_error ? String(j.result ?? "the agent reported an error") : undefined };
    },
  },
  agy: {
    reliableReadOnly: false,
    // Verified: `--mode accept-edits` edits and returns SUCCESS; with no flag it edits too (see reliableReadOnly).
    // The reasoning level is part of an agy model id (gemini-4-neon-high), so there is no --effort flag to pass.
    argv: (prompt, o) => [
      "agy", "-p", prompt, "--output-format", "json",
      ...(o.model ? ["--model", o.model] : []),
      ...(o.permission === "full" ? ["--dangerously-skip-permissions"] : o.permission === "edit" ? ["--mode", "accept-edits"] : []),
    ],
    read(stdout) {
      const j = tryJson(stdout);
      if (!j) return { answer: stdout.trim() };
      const ok = !j.status || j.status === "SUCCESS";
      return { answer: typeof j.response === "string" ? j.response : "", error: ok ? undefined : `agy status ${j.status}` };
    },
  },
};

export const hasHeadless = (agent: string) => agent in HEADLESS;
