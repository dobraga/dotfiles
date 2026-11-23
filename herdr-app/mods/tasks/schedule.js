// Scheduling for shell-command tasks through the user's crontab. Prompt tasks use herdr-automations instead.
// (A template run through that scheduler fires, but it records every short script as "failed", so commands
// are scheduled here.) One managed block in the crontab holds one line per scheduled task:
//   # BEGIN herdr-tasks
//   */5 * * * * /bin/sh '<jobs>/<id>.sh' # herdr-task:<id>
//   # END herdr-tasks
// Each line runs a small generated job script that cds into the folder, runs the command, appends its output to a
// log and one JSON line (id, time, exit code, seconds) to a history file, which the panel reads. Pure functions.

export const BEGIN = "# BEGIN herdr-tasks";
export const END = "# END herdr-tasks";

// Single-quote a string for sh.
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function paths(home) {
  const data = `${home}/.config/herdr-app/data/tasks`;
  const state = `${home}/.local/state/herdr/tasks`;
  return { data, jobs: `${data}/jobs`, state, history: `${state}/history.jsonl`, log: (id) => `${state}/${id}.log`, job: (id) => `${data}/jobs/${id}.sh` };
}

// The command is passed to `sh` through a quoted heredoc, so it needs no escaping and may span lines.
export function jobScript(task, folder, p) {
  const delim = "HERDR_TASK_CMD";
  if (String(task.command).includes(delim)) throw new Error("command contains the reserved marker " + delim);
  const log = p.log(task.id);
  return [
    "#!/bin/sh",
    `# herdr-task ${task.id}: ${String(task.name).replace(/\s+/g, " ")}`,
    `mkdir -p ${shq(p.state)}`,
    `rec() { printf '{"id":"%s","at":"%s","code":%s,"seconds":%s}\\n' ${shq(task.id)} "$(date -Iseconds)" "$1" "$2" >> ${shq(p.history)}; }`,
    `cd ${shq(task.cwd ? `${folder}/${task.cwd}` : folder)} || { echo "cannot cd to the task folder" >> ${shq(log)}; rec 1 0; exit 1; }`,
    `[ -f ${shq(log)} ] && [ "$(wc -c < ${shq(log)})" -gt 1048576 ] && : > ${shq(log)}`,
    `start=$(date +%s)`,
    `sh >> ${shq(log)} 2>&1 <<'${delim}'`,
    task.command,
    delim,
    `code=$?`,
    `rec "$code" "$(( $(date +%s) - start ))"`,
    `exit "$code"`,
    "",
  ].join("\n");
}

export const cronLine = (task, p) => `${task.schedule.cron.trim()} /bin/sh ${shq(p.job(task.id))} # herdr-task:${task.id}`;

export function renderBlock(entries, p) {
  if (!entries.length) return "";
  return [BEGIN, ...entries.map(({ task }) => cronLine(task, p)), END, ""].join("\n");
}

// Replace (or add, or drop) our block and leave every other crontab line exactly as it was.
export function mergeBlock(existing, block) {
  const text = String(existing ?? "");
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  let before = text;
  let after = "";
  if (b !== -1 && e !== -1 && e > b) {
    before = text.slice(0, b);
    after = text.slice(e + END.length).replace(/^\n/, "");
  }
  before = before.replace(/\n*$/, before.trim() ? "\n" : "");
  const out = before + (block && before ? "\n" : "") + block + (after ? (block ? "\n" : "") + after : "");
  return out.replace(/\n{3,}/g, "\n\n");
}

export function parseHistory(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.id === "string") out.push(r);
    } catch {}
  }
  return out;
}

// Cron fields are validated by `herdr-automations put --dry-run`, which also previews the next runs.
export const dryRunEntry = (cron, folder) => ({
  name: "preview", cron, repo: folder, workspace: "root", workspace_id: "", close_workspace: "never",
  agent: "claude", template: "", model: "", prompt: "preview", mcp_config: "", timeout_minutes: 1,
});
