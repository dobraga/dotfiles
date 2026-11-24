// Model and effort discovery for the Inbox settings: the same rules as the Tasks form (tasks/main.js `probe`, `groupVariants`),
// kept here as pure functions because mods do not import each other. One `--help` per agent says whether it lists models
// (`models` subcommand) and which reasoning-effort levels it has (`--effort (low, medium...)`).

export const STATIC_MODELS = {
  claude: [["claude-fable-5-2", "Fable 5.2"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]],
};
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_FALLBACK = EFFORT_ORDER;

// Some agents list one model per level ("Gemini 4 Neon (High)", id gemini-4-neon-high): show each model once and let the
// effort range pick the level. Returns { bases, variants } or null when no model has levels.
export function groupVariants(models) {
  const variants = {};
  const bases = [];
  for (const [id, label] of models) {
    const m = /^(.*?)\s*\((low|medium|high|xhigh|max)\)\s*$/i.exec(label);
    const level = m?.[2].toLowerCase();
    if (!m || !id.toLowerCase().endsWith(`-${level}`)) { bases.push([id, label]); variants[id] = {}; continue; }
    const baseId = id.slice(0, -(level.length + 1));
    if (!variants[baseId]) { variants[baseId] = {}; bases.push([baseId, m[1].trim()]); }
    variants[baseId][level] = id;
  }
  return Object.values(variants).some((v) => Object.keys(v).length) ? { bases, variants } : null;
}

export const defaultVariant = (v) => v.medium ?? v.high ?? v.low ?? Object.values(v)[0];

export function parseEfforts(help) {
  const line = /--effort\b[^\n]*(?:\n[^\n-][^\n]*)?/.exec(help)?.[0];
  if (!line) return null;
  const group = /\(([^)]*)\)/.exec(line)?.[1];
  const levels = group ? group.split(/[,|/]/).map((x) => x.trim()).filter((x) => /^[a-z]+$/.test(x)) : [];
  return levels.length > 1 ? levels : EFFORT_FALLBACK;
}

export const listsModels = (help) => /^\s+models\b/m.test(help);

export function parseModelList(stdout) {
  const models = [];
  for (const l of String(stdout).split("\n")) {
    const c = l.split("\t");
    if (c.length >= 2 && /^[\w./:-]+$/.test(c[0])) models.push([c[0], c.slice(1).join(" ").trim() || c[0]]);
    else if (c.length === 1 && /^[\w./:-]+$/.test(c[0].trim())) models.push([c[0].trim(), c[0].trim()]);
  }
  return models;
}

/** What one agent offers: `{ models: [[id, label]], variants: {base: {level: id}} | null, efforts: [level] | null }`. */
export function shape(bin, help, listOutput) {
  const efforts = parseEfforts(help);
  const models = STATIC_MODELS[bin] ?? (listOutput != null ? parseModelList(listOutput) : []);
  const grouped = models.length ? groupVariants(models) : null;
  return { models: grouped ? grouped.bases : models, variants: grouped?.variants ?? null, efforts: grouped ? null : efforts };
}

/** The dropdown's current base model for a stored id (a per-level id maps back to its base). */
export function baseOf(variants, model) {
  return variants ? Object.keys(variants).find((b) => b === model || Object.values(variants[b]).includes(model)) ?? "" : model;
}

/** Choosing a base model: with levels, keep the current level if the model has it, else its default. Returns { model, effort }. */
export function pickModel(variants, base, effort) {
  if (variants && base) {
    const v = variants[base] ?? {};
    const level = v[effort] ? effort : "";
    return { model: level ? v[level] : Object.keys(v).length ? defaultVariant(v) : base, effort: level };
  }
  return { model: base, effort };
}

/** Choosing an effort level: with per-level models the level is part of the model id. Returns { model, effort }. */
export function pickEffort(variants, model, level) {
  if (variants) {
    const base = baseOf(variants, model);
    if (base && Object.keys(variants[base]).length) return { model: level && variants[base][level] ? variants[base][level] : defaultVariant(variants[base]), effort: "" };
  }
  return { model, effort: level };
}

/** The level shown selected: from the model id when it has per-level variants, else the stored effort. */
export const effortOf = (variants, model, effort) => (variants ? EFFORT_ORDER.find((l) => variants[baseOf(variants, model)]?.[l] === model) ?? "" : effort);
export const levelsOf = (variants, model, efforts) => (variants ? EFFORT_ORDER.filter((l) => baseOf(variants, model) && variants[baseOf(variants, model)]?.[l]) : efforts ?? []);
