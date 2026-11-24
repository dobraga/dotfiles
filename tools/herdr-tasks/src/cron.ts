// Standard 5-field cron (minute hour day-of-month month day-of-week) plus the @descriptors, in local time.
// Same dialect as robfig/cron's standard parser, which herdr-automations uses: `*`, `?`, lists, ranges, steps,
// month and weekday names, day-of-week 0 and 7 are Sunday, and day-of-month / day-of-week are OR-ed when both
// are restricted and AND-ed when either is `*`.

export interface Cron {
  /** The first matching minute strictly after `from`, or null when none exists within five years. */
  next(from: Date): Date | null;
  matches(d: Date): boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DESCRIPTORS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

interface Field { set: Set<number>; star: boolean }

function value(tok: string, names: string[] | null, offset: number, label: string): number {
  if (/^\d+$/.test(tok)) return Number(tok);
  const i = names ? names.indexOf(tok.toLowerCase().slice(0, 3)) : -1;
  if (i >= 0 && tok.length >= 3) return i + offset;
  throw new Error(`invalid ${label} "${tok}"`);
}

function parseField(src: string, min: number, max: number, names: string[] | null, offset: number, label: string): Field {
  const set = new Set<number>();
  let star = false;
  for (const part of src.split(",")) {
    if (!part) throw new Error(`empty ${label} list item in "${src}"`);
    const [range, stepTxt, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`invalid ${label} "${part}"`);
    const step = stepTxt === undefined ? 1 : Number(stepTxt);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid ${label} step "${stepTxt}"`);
    let lo: number, hi: number;
    if (range === "*" || range === "?") {
      lo = min; hi = max;
      if (stepTxt === undefined || stepTxt === "1") star = star || part === range;
      if (stepTxt === undefined) star = true;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = value(a, names, offset, label); hi = value(b, names, offset, label);
    } else {
      lo = value(range, names, offset, label);
      hi = stepTxt === undefined ? lo : max;
    }
    if (label === "day-of-week") { if (lo === 7) lo = 0; if (hi === 7 && range !== "*") hi = 7; }
    if (lo < min || hi > max + (label === "day-of-week" ? 1 : 0) || lo > hi) throw new Error(`${label} "${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) set.add(label === "day-of-week" && v === 7 ? 0 : v);
  }
  return { set, star };
}

export function parseCron(expr: string): Cron {
  const raw = String(expr).trim();
  const src = DESCRIPTORS[raw.toLowerCase()] ?? raw;
  if (src.startsWith("@")) throw new Error(`unsupported descriptor "${raw}"`);
  const f = src.split(/\s+/);
  if (f.length !== 5) throw new Error(`expected exactly 5 fields, found ${f.length}`);
  const minute = parseField(f[0], 0, 59, null, 0, "minute");
  const hour = parseField(f[1], 0, 23, null, 0, "hour");
  const dom = parseField(f[2], 1, 31, null, 0, "day-of-month");
  const month = parseField(f[3], 1, 12, MONTHS, 1, "month");
  const dow = parseField(f[4], 0, 6, DAYS, 0, "day-of-week");
  // robfig: a `*` in either day field means the other one decides alone; both restricted means OR.
  const dayOk = (d: Date) => {
    const a = dom.set.has(d.getDate()), b = dow.set.has(d.getDay());
    return dom.star || dow.star ? a && b : a || b;
  };
  const matches = (d: Date) =>
    minute.set.has(d.getMinutes()) && hour.set.has(d.getHours()) && month.set.has(d.getMonth() + 1) && dayOk(d);

  return {
    matches,
    next(from) {
      const t = new Date(from.getTime());
      t.setSeconds(0, 0);
      t.setMinutes(t.getMinutes() + 1);
      const limit = t.getFullYear() + 5;
      while (t.getFullYear() <= limit) {
        if (!month.set.has(t.getMonth() + 1)) { t.setMonth(t.getMonth() + 1, 1); t.setHours(0, 0, 0, 0); continue; }
        if (!dayOk(t)) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
        if (!hour.set.has(t.getHours())) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
        if (!minute.set.has(t.getMinutes())) { t.setMinutes(t.getMinutes() + 1, 0, 0); continue; }
        return t;
      }
      return null;
    },
  };
}

/** Validates an expression and returns a message, or null when it is fine. */
export function cronProblem(expr: string): string | null {
  try { parseCron(expr); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

export function nextRuns(expr: string, from: Date, count: number): Date[] {
  const c = parseCron(expr);
  const out: Date[] = [];
  let t: Date | null = from;
  while (out.length < count && (t = c.next(t))) out.push(t);
  return out;
}
