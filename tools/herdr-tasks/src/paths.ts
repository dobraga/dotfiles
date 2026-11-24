import { homedir } from "node:os";
import { join } from "node:path";

// Same locations the Tasks panel uses (herdr-app/mods/tasks/schedule.js `paths`), so the panel and the daemon share files.
export function paths(home = process.env.HERDR_TASKS_HOME ?? homedir()) {
  const state = process.env.HERDR_TASKS_STATE ?? join(home, ".local/state/herdr/tasks");
  const data = process.env.HERDR_TASKS_DATA ?? join(home, ".config/herdr-app/data/tasks");
  return {
    home, state, data,
    tasks: join(data, "tasks.json"),
    history: join(state, "history.jsonl"),
    stateFile: join(state, "state.json"),
    lock: join(state, "daemon.lock"),
    pauseFlag: join(state, "paused"),
    worktrees: join(state, "worktrees"),
    runs: join(state, "runs"),
    log: join(state, "daemon.log"),
  };
}
