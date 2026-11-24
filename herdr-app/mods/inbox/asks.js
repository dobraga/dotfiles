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
 * ☐/✔ steps), which is never answered from a card.
 */
export function parseDialog(screen) {
  const lines = tail(screen, 45).map(clean);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (OPTION.test(lines[i])) { end = i; break; }
  if (end < 0) return null;
  let start = end;
  while (start - 1 >= 0 && (OPTION.test(lines[start - 1]) || (lines[start - 1].trim() && /^\s{4,}\S/.test(lines[start - 1]) && !RULE.test(lines[start - 1])) )) start--;
  // Options in order 1..n only; a stray numbered list in prose is not a dialog.
  const opts = [];
  for (let i = start; i <= end; i++) {
    const m = OPTION.exec(lines[i]);
    if (!m) { if (opts.length) opts[opts.length - 1].label += ` ${lines[i].trim()}`; continue; }
    if (Number(m[1]) !== opts.length + 1) { opts.length = 0; continue; }
    opts.push({ n: Number(m[1]), label: m[2], current: /^\s*[❯›▶]/.test(lines[i]) });
  }
  if (opts.length < 2) return null;
  // The dialog must be the live prompt: a footer such as "Esc to cancel" / "Enter to select" or the cursor marker near it.
  const below = lines.slice(end + 1).join("\n");
  const live = opts.some((o) => o.current) || /Esc to|Enter to|to select|to navigate|to cancel/i.test(below);
  if (!live) return null;
  let q = end >= 0 ? start - 1 : -1;
  const ctx = [];
  while (q >= 0 && !RULE.test(lines[q]) && ctx.length < 6) { if (lines[q].trim()) ctx.unshift(lines[q].trim()); q--; }
  const question = ctx.filter((l) => /\?$|^Do you|^Allow|^Would you/i.test(l)).pop() ?? ctx[ctx.length - 1] ?? "Waiting for your choice";
  const above = ctx.join(" ");
  const multi = lines.some((l) => /[☐☒✔]\s.*[☐☒✔]\s|←.*☐.*→/.test(l));
  const yesNo = opts.some((o) => /^yes\b/i.test(o.label)) && opts.some((o) => /^no\b/i.test(o.label));
  return {
    kind: yesNo || /permission|allow|proceed|approve/i.test(`${question} ${above}`) ? "APPROVAL" : "DECISION",
    question, context: ctx.filter((l) => l !== question).slice(-3).join("\n"), multi,
    options: opts.map((o) => ({ n: o.n, label: o.label.replace(/\s*\(Recommended\)\s*/i, "").trim(), recommended: /\(Recommended\)/i.test(o.label) })),
  };
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
    if (answer.option != null) return { keys: [String(answer.option)] };
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
