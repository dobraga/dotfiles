// Task sets: an ordered list of steps (shell commands and agent prompts) where a step may use the results of earlier
// ones through {{steps.<id>.<field>}} templates. Pure: no I/O. The daemon plugs in how a step really runs (`execStep`);
// the Tasks panel uses the same module (copied into the mod by scripts/sync-mod.sh) to validate and to offer variables.
//
// How a result reaches the next step depends on what the next step is:
//   - prompt: {{steps.<id>.<field>}} in the prompt text is replaced by the value (no shell is involved).
//   - command: NEVER by text substitution (a previous answer could carry shell syntax and would run). The results are
//     exported as environment variables instead, $HERDR_<ID>_<FIELD> (HERDR_S1_STDOUT, HERDR_S2_RESPONSE, ...), so the
//     shell treats them as data: `echo "$HERDR_S1_STDOUT"`.
//
// Step:   { id, kind: "command" | "prompt", command?, prompt?, agent?, model?, effort?, cwd?,
//           when: "always" | "prev_ok" | "prev_output", onFailure: "stop" | "continue" }
// Result: command -> { stdout, stderr, exit_code, failed }   prompt -> { response, exit_code, failed }

export const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const FIELDS = {
  command: ["stdout", "stderr", "exit_code", "failed"],
  prompt: ["response", "exit_code", "failed"],
  // A nested set answers with its last step's output.
  set: ["response", "stdout", "exit_code", "failed"],
};
const REF_RE = /\{\{\s*steps\.([a-z][a-z0-9_]{0,31})\.([a-z_]+)\s*\}\}/g;

// A task step has no text of its own; its optional `input` (extra context for a referenced prompt) is what can use results.
export const textOf = (s) => (s.kind === "prompt" ? s.prompt : s.kind === "task" ? s.input : s.command) ?? "";

/** Give every step without a valid, unique id the next free `sN`. Returns new step objects. */
export function assignIds(steps) {
  const used = new Set();
  const out = steps.map((s) => ({ ...s }));
  for (const s of out) {
    if (s.id && ID_RE.test(s.id) && !used.has(s.id)) used.add(s.id);
    else s.id = null;
  }
  let n = 1;
  for (const s of out) {
    if (s.id) continue;
    while (used.has(`s${n}`)) n++;
    s.id = `s${n}`;
    used.add(s.id);
  }
  return out;
}

const ENV_MAX = 100 * 1024;

/** The environment variable a command step reads a result from. */
export const envName = (id, field) => `HERDR_${String(id).toUpperCase()}_${String(field).toUpperCase()}`;

/** Every recorded result as environment variables (values trimmed of trailing whitespace and capped). */
export function envFor(results) {
  const env = {};
  for (const [id, r] of Object.entries(results)) {
    for (const [field, v] of Object.entries(r ?? {})) {
      if (v === undefined || v === null || typeof v === "object") continue;
      const text = String(v).replace(/\s+$/, "");
      env[envName(id, field)] = text.length > ENV_MAX ? text.slice(-ENV_MAX) : text;
    }
  }
  return env;
}

/** Every {{steps.id.field}} in a text, in order. */
export function referencesIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(REF_RE)) out.push({ id: m[1], field: m[2], raw: m[0] });
  return out;
}

/** What step `index` may reference: the earlier steps and the fields each one produces (for the editor's variable chips). */
export function availableVars(steps, index) {
  return steps.slice(0, index).map((s) => ({ id: s.id, kind: s.kind, fields: FIELDS[s.kind] ?? [] }));
}

/** What to insert for a chip: the template for a prompt step, the environment variable for a command step. */
export function insertionFor(targetKind, id, field) {
  return targetKind === "prompt" ? `{{steps.${id}.${field}}}` : `"$${envName(id, field)}"`;
}

/** Problems that would make the set fail at run time, found before saving. [] means fine. */
export function validateSet(steps) {
  const problems = [];
  if (!steps.length) return ["The set has no steps."];
  const seen = new Map();
  steps.forEach((s, i) => {
    const at = `Step ${i + 1}`;
    if (!ID_RE.test(String(s.id ?? ""))) problems.push(`${at}: id "${s.id}" must match [a-z][a-z0-9_]{0,31}.`);
    else if (seen.has(s.id)) problems.push(`${at}: id "${s.id}" is already used by step ${seen.get(s.id) + 1}.`);
    else seen.set(s.id, i);
    if (!["command", "prompt", "set", "task"].includes(s.kind)) problems.push(`${at}: unknown kind "${s.kind}".`);
    if (s.kind === "task" && !s.ref) problems.push(`${at}: no task chosen.`);
    if (s.kind !== "task" && s.kind !== "set" && !String(textOf(s)).trim()) problems.push(`${at}: ${s.kind === "prompt" ? "the prompt" : "the command"} is empty.`);
    if (!["always", "prev_ok", "prev_output"].includes(s.when ?? "always")) problems.push(`${at}: unknown "run when" value "${s.when}".`);
    if (!["stop", "continue"].includes(s.onFailure ?? "stop")) problems.push(`${at}: unknown "on failure" value "${s.onFailure}".`);
    if ((s.when === "prev_ok" || s.when === "prev_output") && i === 0) problems.push(`${at}: the first step has no previous step to depend on.`);
    if (s.kind === "command" && referencesIn(textOf(s)).length) {
      const r = referencesIn(textOf(s))[0];
      problems.push(`${at}: a command cannot use ${r.raw} (a previous answer could run as shell code). Read it from the environment instead: "$${envName(r.id, r.field)}".`);
      return;
    }
    for (const r of referencesIn(textOf(s))) {
      const j = seen.get(r.id) ?? steps.findIndex((x) => x.id === r.id);
      if (j === -1) problems.push(`${at}: ${r.raw} refers to a step that does not exist.`);
      else if (j >= i) problems.push(`${at}: ${r.raw} refers to ${j === i ? "the step itself" : "a later step"}; only earlier steps can be used.`);
      else if (FIELDS[steps[j].kind] && !FIELDS[steps[j].kind].includes(r.field)) problems.push(`${at}: ${r.raw}: a ${steps[j].kind} step has no "${r.field}" (it has ${FIELDS[steps[j].kind].join(", ")}).`);
    }
  });
  return problems;
}

/** Substitute {{steps.id.field}} with recorded results. A reference to a step that did not run becomes an empty string. */
export function render(text, results) {
  return String(text ?? "").replace(REF_RE, (_m, id, field) => {
    const v = results[id]?.[field];
    return v === undefined || v === null ? "" : String(v).replace(/\s+$/, "");
  });
}

/**
 * Run a set. `execStep(step, text, env)` really runs one step and resolves to a result object, or rejects. For a prompt,
 * `text` is the prompt with {{steps...}} substituted and `env` is {}; for a command, `text` is the command exactly as
 * written and `env` holds the previous results as HERDR_<ID>_<FIELD> variables. Returns { status, steps: [{ id, status, result?, reason? }] }.
 * Retry: `hooks.from` (index) and `hooks.seed` (results by step id) resume a set at a step.
 * Step status: "done" | "failed" | "skipped". Set status: "done" | "failed".
 *   - `when` decides whether a step runs: "prev_ok" needs the previous step to have run and succeeded;
 *     "prev_output" additionally needs its stdout/response to be non-empty.
 *   - `onFailure: "stop"` ends the set at a failed step (later steps are recorded "skipped: set stopped"); "continue" goes on.
 *     A set with any failed step is failed, even when it continued.
 */
export async function runSet(steps, execStep, hooks = {}) {
  const results = {};
  const records = [];
  let stopped = false;
  let anyFailed = false;
  // Retry: steps before `hooks.from` keep the results of the earlier run (`hooks.seed`) and are not run again.
  const from = Math.max(0, hooks.from ?? 0);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const prev = records[i - 1];
    if (i < from) {
      const kept = hooks.seed?.[step.id];
      if (kept) results[step.id] = kept;
      records.push({ id: step.id, status: kept && !kept.failed ? "done" : "skipped", reason: "kept from the previous run", result: kept, kept: true });
      continue;
    }
    if (stopped) { records.push({ id: step.id, status: "skipped", reason: "set stopped" }); continue; }
    const when = step.when ?? "always";
    if (when !== "always") {
      const out = prev?.result?.stdout ?? prev?.result?.response ?? "";
      const okPrev = prev?.status === "done";
      if (!okPrev) { records.push({ id: step.id, status: "skipped", reason: "previous step did not succeed" }); continue; }
      if (when === "prev_output" && !String(out).trim()) { records.push({ id: step.id, status: "skipped", reason: "previous step produced no output" }); continue; }
    }
    hooks.onStart?.(step, i);
    let result;
    try {
      result = step.kind === "prompt" ? await execStep(step, render(textOf(step), results), {}) : await execStep(step, textOf(step), envFor(results));
    } catch (e) {
      result = { exit_code: -1, failed: true, error: e instanceof Error ? e.message : String(e), stdout: "", stderr: "", response: "" };
    }
    result = { exit_code: 0, failed: false, ...result };
    result.failed = Boolean(result.failed) || result.exit_code !== 0;
    results[step.id] = result;
    const rec = { id: step.id, status: result.failed ? "failed" : "done", result };
    records.push(rec);
    hooks.onEnd?.(step, i, rec);
    if (result.failed) {
      anyFailed = true;
      if ((step.onFailure ?? "stop") === "stop") stopped = true;
    }
  }
  return { status: anyFailed ? "failed" : "done", steps: records };
}
