// Task definitions the scheduler does not own: shell commands and saved scripts, per folder.
// Prompt tasks live in herdr-automations' automations.yaml and are merged in by the panel.
// Pure helpers; the panel reads and writes the JSON file with readTextFile / writeTextFile.

export const emptyStore = () => ({ version: 1, folders: {}, pins: {} });

export function parseStore(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && j.folders && typeof j.folders === "object") return { version: 1, folders: j.folders, pins: j.pins && typeof j.pins === "object" ? j.pins : {} };
  } catch {}
  return emptyStore();
}

export const serializeStore = (store) => JSON.stringify(store, null, 2) + "\n";

// A short id that is safe in file names and crontab comments.
export const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";

export const tasksFor = (store, folder) => store.folders[folder] ?? [];

export function upsert(store, folder, task) {
  const list = tasksFor(store, folder);
  const next = list.some((t) => t.id === task.id) ? list.map((t) => (t.id === task.id ? task : t)) : [...list, task];
  return { ...store, folders: { ...store.folders, [folder]: next } };
}

export function remove(store, folder, id) {
  const next = tasksFor(store, folder).filter((t) => t.id !== id);
  const folders = { ...store.folders };
  if (next.length) folders[folder] = next;
  else delete folders[folder];
  return { ...store, folders };
}

// Every scheduled, not paused task across folders: the crontab is one file for all of them.
export function scheduled(store) {
  const out = [];
  for (const [folder, list] of Object.entries(store.folders)) {
    for (const task of list) if (task.schedule?.cron && !task.paused) out.push({ folder, task });
  }
  return out;
}

export const validTask = (t) =>
  Boolean(t && typeof t.id === "string" && typeof t.name === "string" && t.name.trim() && typeof t.command === "string" && t.command.trim());

// Favourite scripts: detected scripts are not stored, so the store keeps their keys per folder.
export const scriptKey = (s) => `${s.source}:${s.name}`;
export const isPinnedScript = (store, folder, s) => (store.pins?.[folder] ?? []).includes(scriptKey(s));
export function togglePinScript(store, folder, s) {
  const key = scriptKey(s);
  const cur = store.pins?.[folder] ?? [];
  const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
  const pins = { ...(store.pins ?? {}) };
  if (next.length) pins[folder] = next; else delete pins[folder];
  return { ...store, pins };
}
