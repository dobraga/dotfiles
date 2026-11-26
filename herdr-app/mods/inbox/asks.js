// Ask cards: what an agent is waiting on, read from its terminal screen (`hc read <terminal>`). Pure and testable in Node.
// Three sources of a card: a dialog with numbered options (permission or choice), a turn that ended in an error (STOPPED),
// and a finished turn whose last message asks something in prose (classified by a model, see classifyPrompt).

const tail = (screen, n) => String(screen ?? "").replace(/\r/g, "").split("\n").slice(-n);
const clean = (l) => l.replace(/\s+$/, "");
// A rule line of box-drawing dashes, a prompt, or the status bar: where a message or dialog stops.
const RULE = /^[\s─━═\-╭╮╰╯│┌┐└┘]{8,}$/;
const OPTION = /^\s*(?:[❯>›▶●○◉◯]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;

/** A short stable hash (FNV-1a) for keys and the classified-message cache. */
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/**
 * Reads a dialog at the bottom of the screen: consecutive numbered options and the question above them.
 * Returns null when the screen shows no dialog. `multi` is true for Claude Code's several-questions dialog (a tab bar of
 * ☐/✔ steps): it is answered one tab at a time, each answer moves it to the next tab, which reads as a new dialog.
 */
export function parseDialog(screen) {
  const lines = tail(screen, 45).map(clean).map((l) => l.replace(/^\s*[│┃]\s?/, "").replace(/\s*[│┃]$/, ""));
  const isOpt = (l) => OPTION.test(l);
  const isDesc = (l) => /^\s{3,}\S/.test(l) && !RULE.test(l);
  const isGap = (l) => !l.trim() || RULE.test(l);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (isOpt(lines[i])) { end = i; break; }
  if (end < 0) return null;
  // Walk up over options, their indented descriptions and the rule/blank lines Claude Code draws between them.
  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    if (isOpt(lines[i]) || isDesc(lines[i])) { start = i; continue; }
    if (!isGap(lines[i])) break;
    let j = i;
    while (j >= 0 && isGap(lines[j])) j--;
    if (j >= 0 && (isOpt(lines[j]) || isDesc(lines[j]))) { i = j + 1; continue; }
    break;
  }
  // Options in order 1..n; descriptions belong to the option above them. A stray numbered list in prose is not a dialog.
  const opts = [];
  for (let i = start; i <= end; i++) {
    const m = OPTION.exec(lines[i]);
    if (!m) { if (opts.length && !isGap(lines[i])) opts[opts.length - 1].desc = `${opts[opts.length - 1].desc ?? ""} ${lines[i].trim()}`.trim(); continue; }
    if (Number(m[1]) !== opts.length + 1) { opts.length = 0; continue; }
    opts.push({ n: Number(m[1]), label: m[2], current: /^\s*[❯›▶>]\s/.test(lines[i]) });
  }
  if (opts.length < 2) return null;
  // The dialog must be the live prompt: a footer such as "Esc to cancel" / "Enter to select" or the cursor marker near it.
  const below = lines.slice(end + 1).join("\n");
  const live = opts.some((o) => o.current) || /Esc to|Enter to|to select|to navigate|to cancel|Navigate|enter Select|esc Skip/i.test(below);
  if (!live) return null;
  // Claude Code's several-questions tab bar ("← ☐ Layout ☐ Defaults ✔ Submit →") is chrome, not context.
  const TABS = /[☐☒✔]\s.*[☐☒✔]\s|←.*[☐☒✔].*→|^\s*[☐☒✔]\s/;
  let q = start - 1;
  const ctx = [];
  while (q >= 0 && ctx.length < 14) {
    if (RULE.test(lines[q])) break;
    if (lines[q].trim() && !TABS.test(lines[q])) ctx.unshift(lines[q].trim());
    q--;
  }
  // The last step of the several-questions dialog lists the questions with their answers ("● Q" / "→ A") above
  // Submit/Cancel: the question is whether to submit, and those pairs are the context.
  // Where the dialog is in a set: Antigravity prints "Question 2/4", Claude Code a tab bar (☒/✔ = answered).
  const stepM = ctx.map((l) => /^Question (\d+)\/(\d+)/i.exec(l)).find(Boolean);
  const step = stepM ? { n: Number(stepM[1]), total: Number(stepM[2]) } : null;
  const bar = lines.slice(0, start).reverse().find((l) => /←.*[☐☒✔].*→|[☐☒✔]\s.*[☐☒✔]\s/.test(l));
  const tabs = bar ? [...bar.matchAll(/([☐☒✔])\s+(.+?)(?=\s+[☐☒✔]\s|\s*→|\s*$)/g)].map((m) => ({ label: m[2].trim(), done: m[1] !== "☐" })).filter((t) => !/^submit$/i.test(t.label)) : null;
  const review = ctx.findIndex((l) => /^Review your answers/i.test(l));
  if (review >= 0) {
    const pairs = ctx.slice(review + 1).filter((l) => /^[●→]/.test(l));
    return { kind: "DECISION", question: "Submit your answers?", context: pairs.join("\n"), multi: true, step, tabs, options: cleanOptions(opts) };
  }
  ctx.splice(0, Math.max(0, ctx.length - 6));
  const question = (ctx.filter((l) => /\?$|^Do you|^Allow|^Would you/i.test(l)).pop() ?? ctx[ctx.length - 1] ?? "Waiting for your choice").replace(/^Question \d+\/\d+:\s*/i, "");
  const above = ctx.join(" ");
  const multi = lines.some((l) => /[☐☒✔]\s.*[☐☒✔]\s|←.*☐.*→/.test(l));
  const real = cleanOptions(opts);
  const yesNo = real.some((o) => /^yes\b/i.test(o.label)) && real.some((o) => /^no\b/i.test(o.label));
  return {
    kind: yesNo || /permission|allow|proceed|approve/i.test(`${question} ${above}`) ? "APPROVAL" : "DECISION",
    question, context: ctx.filter((l) => l !== question).slice(-3).join("\n"), multi, step, tabs, options: real,
    checkbox: real.some((o) => o.checked != null),
  };
}

// A multi-select option carries a box: "1. [ ] Café", "1. [✔] Café". `checked` is null for a plain option.
const BOX = /^\[([ ✔✓xX])\]\s*/;

// Claude Code adds its own "Type something." / "Chat about this" rows (boxed too in a multi-select): not the agent's choices.
function cleanOptions(opts) {
  const own = (label) => /^(type something|chat about this|other|write-in)\.*$/i.test(label);
  return opts.map((o) => {
    const box = BOX.exec(o.label);
    return { ...o, label: o.label.replace(BOX, "").trim(), checked: box ? box[1] !== " " : null };
  }).filter((o) => !own(o.label)).map((o) => ({ n: o.n, current: o.current, checked: o.checked, label: o.label.replace(/\s*\(Recommended\)\s*/i, "").trim(), recommended: /\(Recommended\)/i.test(o.label), desc: o.desc ?? "" }));
}

/** Identity of a dialog: the same question and options give the same id, the next question of a set gives another. */
export function dialogId(d) {
  return d ? hash(d.question + d.options.map((o) => o.label).join("|")) : null;
}

/** The agent's last message, for classification: from the last "●" bullet to the footer. Empty if none. */
export function lastMessage(screen) {
  const lines = tail(screen, 80).map(clean);
  let s = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*[●⏺]\s/.test(lines[i])) { s = i; break; }
  if (s < 0) return "";
  const body = [];
  for (let i = s; i < lines.length; i++) {
    const l = lines[i];
    if (RULE.test(l) || /^\s*[✻✽✢✶※]\s/.test(l) || /^\s*[❯>]\s/.test(l)) break;
    body.push(l.replace(/^\s*[●⏺]\s?/, "").replace(/^ {2}/, ""));
  }
  return body.join("\n").trim();
}

/** A turn that ended in an error: the agent printed one and stopped. Returns the error line or null. */
export function parseStopped(screen) {
  const lines = tail(screen, 25).map(clean).filter((l) => l.trim());
  const text = lines.slice(-10).join("\n");
  const m = /(API Error[^\n]*|Overloaded[^\n]*|Connection error[^\n]*|Unable to connect[^\n]*|ECONNRESET[^\n]*|Credit balance is too low[^\n]*|Please run \/login[^\n]*|Invalid API key[^\n]*)/i.exec(text);
  if (!m) return null;
  const loggedOut = /\/login|Invalid API key/i.test(m[1]);
  return { error: m[1].trim(), loggedOut };
}

export function classifyPrompt(message) {
  return [
    "You decide whether a coding agent is waiting for a human's answer. Below is the last message the agent wrote.",
    "Reply with JSON only, no prose, no code fence: {\"waiting\": boolean, \"questions\": [{\"text\": string, \"options\": [string]}]}",
    "waiting is true only if the agent needs a decision or information from the person before it can continue.",
    "Rhetorical endings (\"let me know if you want more\", \"happy to help further\") are NOT waiting.",
    "options lists the choices the agent itself offered for that question, verbatim and short; empty if it offered none.",
    "",
    "MESSAGE:",
    message.slice(-4000),
  ].join("\n");
}

/** Tolerant reader of the classifier's reply (a model may wrap JSON in a fence or add a word). */
export function parseClassifier(answer) {
  const text = String(answer ?? "");
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { waiting: false, questions: [] };
  try {
    const j = JSON.parse(m[0]);
    const qs = (Array.isArray(j.questions) ? j.questions : [])
      .map((q) => ({ text: String(q?.text ?? "").trim(), options: (Array.isArray(q?.options) ? q.options : []).map((o) => String(o).trim()).filter(Boolean).slice(0, 8) }))
      .filter((q) => q.text);
    return { waiting: j.waiting === true && qs.length > 0, questions: qs.slice(0, 6) };
  } catch { return { waiting: false, questions: [] }; }
}

/** What to send to the terminal for an answer: a key press for a dialog option, or a message. Never both. */
export function answerPlan(card, answer) {
  if (card.mode === "dialog") {
    // Moving inside a set of questions: both agents take the arrows (Claude Code's tabs, Antigravity's Back/Next).
    if (answer.nav) return { keys: [answer.nav === "back" ? "left" : "right"] };
    // A multi-select: a number key toggles that box, so press only the ones that differ from the screen, then go on.
    if (answer.checked) {
      const want = new Set(answer.checked);
      return { keys: [...card.options.filter((o) => want.has(o.n) !== Boolean(o.checked)).map((o) => String(o.n)), "right"] };
    }
    if (answer.option != null) {
      // Antigravity's dialog is moved with the arrows and confirmed with Enter; Claude Code takes the option's number.
      if (card.nav === "arrows") {
        const from = Math.max(0, card.options.findIndex((o) => o.current));
        const to = card.options.findIndex((o) => o.n === answer.option);
        const step = to >= from ? "down" : "up";
        return { keys: [...Array(Math.abs(to - from)).fill(step), "enter"] };
      }
      return { keys: [String(answer.option)] };
    }
    // Free text over a dialog: leave the dialog with Esc, then say it in the prompt.
    return { keys: ["esc"], then: { send: answer.text } };
  }
  return { send: answer.text };
}

/** Several drafts (one per question) become one numbered message. */
export function composeAnswers(questions, drafts) {
  return questions.map((q, i) => (drafts[i] ? `${i + 1}. ${drafts[i]}` : null)).filter(Boolean).join("\n");
}

export function decisionLine({ at, agent, space, question, answer }) {
  const t = new Date(at);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
  const one = (s) => String(s).replace(/\s+/g, " ").trim();
  return `- ${stamp} · ${agent} (${space}) · ${one(question)} → ${one(answer)}\n`;
}

export const SUPPORTED_APPS = ["claude-code", "codex", "pi", "agy", "antigravity"];
