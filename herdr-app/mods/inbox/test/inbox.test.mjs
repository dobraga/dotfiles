import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDialog, lastMessage, parseStopped, parseClassifier, answerPlan, composeAnswers, decisionLine, dialogId, hash, classifyPrompt } from "../asks.js";
import { autoSeenItems, profilesOfFolder, inProfile, hiddenElsewhere, profileOf, classifierFor, buildItems, rank, normalizeSettings, pruneState, emptyState, parseState, needsYouCount, DEFAULT_SETTINGS } from "../items.js";

const PERMISSION = `
● Bash(rm -rf build)
  ⎿  Running…

╭──────────────────────────────────────────────────────────────╮
│ Bash command                                                  │
│                                                               │
│   rm -rf build                                                │
│   Remove the build folder                                     │
│                                                               │
│ Do you want to proceed?                                       │
│ ❯ 1. Yes                                                      │
│   2. Yes, and don't ask again for rm commands                 │
│   3. No, and tell Claude what to do differently (esc)         │
╰──────────────────────────────────────────────────────────────╯
`;

const CHOICE = `
● Which approach do you prefer?

 Which layout should the inbox use?
 ❯ 1. Side panel (Recommended)
   2. Own tab
   3. Overlay

 Enter to select · ↑/↓ to navigate · Esc to cancel
`;

const MULTI = `
 ←  ☐ Layout  ☐ Defaults  ✔ Submit  →

 Which layout?
 ❯ 1. Panel
   2. Tab

 Enter to select · Esc to cancel
`;

test("the review step of the several-questions dialog asks to submit, with the answers as context", () => {
  const d = parseDialog(`
 ←  ✔ Card  ☒ Second  ✔ Submit  →

 Review your answers

  ● Teste de captura: wait ~5s, then check the Inbox. What does the card show?
    → Card com opções
  ● Second question, to keep it multi-question

 Ready to submit your answers?

 ❯ 1. Submit answers
   2. Cancel

 Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
  assert.equal(d.question, "Submit your answers?");
  assert.equal(d.multi, true);
  assert.match(d.context, /^● Teste de captura.*\n→ Card com opções\n● Second question/);
  assert.deepEqual(d.options.map((o) => o.label), ["Submit answers", "Cancel"]);
});

test("permission dialog becomes an APPROVAL card with its options", () => {
  const d = parseDialog(PERMISSION.replace(/[│╭╮╰╯─]/g, " "));
  assert.equal(d.kind, "APPROVAL");
  assert.equal(d.options.length, 3);
  assert.equal(d.options[0].label, "Yes");
  assert.match(d.question, /proceed/);
  assert.equal(d.multi, false);
});

test("a choice dialog is a DECISION and marks the recommended option", () => {
  const d = parseDialog(CHOICE);
  assert.equal(d.kind, "DECISION");
  assert.deepEqual(d.options.map((o) => o.recommended), [true, false, false]);
  assert.equal(d.options[0].label, "Side panel");
  assert.match(d.question, /layout/i);
});

test("the several-questions dialog is flagged multi and read as its current tab, without the tab bar", () => {
  const d = parseDialog(MULTI);
  assert.equal(d.multi, true);
  assert.equal(d.question, "Which layout?");
  assert.equal(d.context, "");
  assert.deepEqual(d.options.map((o) => o.label), ["Panel", "Tab"]);
  assert.deepEqual(answerPlan({ mode: "dialog", nav: "number", options: d.options }, { option: 2 }), { keys: ["2"] });
});

test("a numbered list in prose is not a dialog", () => {
  assert.equal(parseDialog("● Steps:\n  1. one\n  2. two\n\n❯ \n"), null);
});

test("lastMessage reads from the last bullet to the footer", () => {
  const screen = "● old\n\n● Should I use panel or tab?\n  Panel is closer to the work.\n\n✻ Worked for 3s\n────────────────────\n❯ \n";
  assert.equal(lastMessage(screen), "Should I use panel or tab?\nPanel is closer to the work.");
  assert.equal(lastMessage("no bullets here"), "");
});

test("an error turn is STOPPED; a login error has no Continue", () => {
  assert.equal(parseStopped("● x\n  ⎿ API Error: 529 Overloaded\n❯ \n").loggedOut, false);
  assert.equal(parseStopped("Please run /login · API Error: 401\n").loggedOut, true);
  assert.equal(parseStopped("● all good\n"), null);
});

test("classifier reply is read tolerantly", () => {
  const r = parseClassifier('Sure:\n```json\n{"waiting":true,"questions":[{"text":"Panel or tab?","options":["Panel","Tab"]}]}\n```');
  assert.equal(r.waiting, true);
  assert.deepEqual(r.questions[0].options, ["Panel", "Tab"]);
  assert.equal(parseClassifier("nope").waiting, false);
  assert.equal(parseClassifier('{"waiting":true,"questions":[]}').waiting, false);
  assert.match(classifyPrompt("hello"), /MESSAGE:\nhello/);
});

test("answer plans: a key for dialogs, a message for prose, esc then text for free text over a dialog", () => {
  assert.deepEqual(answerPlan({ mode: "dialog" }, { option: 2 }), { keys: ["2"] });
  assert.deepEqual(answerPlan({ mode: "dialog" }, { text: "do X" }), { keys: ["esc"], then: { send: "do X" } });
  assert.deepEqual(answerPlan({ mode: "text" }, { text: "Panel" }), { send: "Panel" });
  assert.equal(composeAnswers([{}, {}, {}], ["a", "", "c"]), "1. a\n3. c");
});

test("decision log line and hash are stable", () => {
  const line = decisionLine({ at: new Date(2026, 10, 23, 9, 5).getTime(), agent: "claude-code", space: "dotfiles", question: "Panel\nor tab?", answer: "Panel" });
  assert.equal(line, "- 2026-11-23 09:05 · claude-code (dotfiles) · Panel or tab? → Panel\n");
  assert.equal(hash("a"), hash("a"));
  assert.notEqual(hash("a"), hash("b"));
});

const S = normalizeSettings({});
const agents = [
  { address: "t1", status: "blocked", seq: 5, space_name: "dotfiles", tab_name: "1", title: "t" },
  { address: "t2", status: "done", seq: 6, space_name: "ml", tab_name: "2", title: "" },
  { address: "t3", status: "working", seq: 7, space_name: "ml", tab_name: "3" },
];
const notifs = [
  { id: "n1", prKey: "k1", level: "error", title: "CI failed #1", body: "repo", at: 1000, read: false },
  { id: "n2", prKey: "k2", level: "info", title: "Merged #2", body: "repo", at: 2000, read: true },
];
const runs = [
  { run_id: "r1", task: "a", name: "backup", status: "failed", at: "2026-11-23T10:00:00Z", error: "exit 2", seen: false },
  { run_id: "r2", task: "b", name: "lint", status: "done", at: "2026-11-23T11:00:00Z", seen: true },
  { run_id: "r3", task: "c", status: "running", at: "2026-11-23T11:00:00Z" },
];
const ask = { key: "ask-t1-x", address: "t1", kind: "APPROVAL", title: "dotfiles · 1", question: "Proceed?", at: Date.parse("2026-12-01") };

test("items: blocked agent with a card is listed once, as the card", () => {
  const items = buildItems({ agents, notifs, runs, asks: [ask], settings: S, state: emptyState() });
  assert.equal(items.filter((i) => i.data?.address === "t1" || i.data?.address === undefined && i.key === "ask-t1-x").length, 1);
  assert.ok(items.find((i) => i.key === "ask-t1-x"));
  assert.equal(items.some((i) => i.group === "agents" && i.kind === "AGENT"), false);
});

test("items: working agents and running runs are not listed", () => {
  const items = buildItems({ agents, notifs, runs, asks: [], settings: S, state: emptyState() });
  assert.equal(items.some((i) => i.data?.address === "t3"), false);
  assert.equal(items.some((i) => i.key === "task-r3"), false);
});

test("rank: sections first, newest first, seen hidden unless asked, dismissed always hidden", () => {
  const state = { ...emptyState(), dismissed: { "pr-n1": 1 } };
  const items = buildItems({ agents, notifs, runs, asks: [ask], settings: S, state });
  const keys = rank(items).map((i) => i.key);
  assert.equal(keys[0], "ask-t1-x");
  assert.ok(keys.includes("task-r1"));
  assert.ok(!keys.includes("pr-n1"), "dismissed");
  assert.ok(!keys.includes("pr-n2"), "seen (read) hidden");
  assert.ok(rank(items, { showSeen: true }).some((i) => i.key === "pr-n2"));
  assert.ok(rank(items, { filter: "tasks" }).every((i) => i.group === "tasks"));
});

test("a persistent seen mark hides a row; source toggles drop a group", () => {
  const state = { ...emptyState(), seen: { "task-r1": 5 } };
  assert.equal(buildItems({ runs, settings: S, state }).find((i) => i.key === "task-r1").seen, true);
  const off = normalizeSettings({ sources: { prs: false } });
  assert.equal(buildItems({ notifs, settings: off, state: emptyState() }).length, 0);
});

test("needsYouCount counts unseen section-0 rows and open asks", () => {
  const items = buildItems({ agents, notifs, runs, asks: [ask], settings: S, state: emptyState() });
  assert.equal(needsYouCount(items), 3); // ask + CI notif + failed task
});

test("settings: defaults, bad values fall back", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  const s = normalizeSettings({ classifier: { agent: "agy", model: " m " }, notify: "bogus", retentionDays: 0, asks: { plainText: true } });
  assert.equal(s.classifier.agent, "agy");
  assert.equal(s.classifier.model, "m");
  assert.equal(s.notify, "asks");
  assert.equal(s.retentionDays, 14);
  assert.equal(s.asks.plainText, true);
  assert.equal(s.asks.enabled, true);
});

test("state: parse falls back, prune drops old entries", () => {
  assert.deepEqual(parseState("not json"), emptyState());
  const now = 100 * 86_400_000;
  const p = pruneState({ ...emptyState(), seen: { a: now - 20 * 86_400_000, b: now - 1000 }, answered: [{ at: 1 }, { at: now }] }, now, 14);
  assert.deepEqual(Object.keys(p.seen), ["b"]);
  assert.equal(p.answered.length, 1);
});

test("classifier is chosen per space profile, falling back to the default", () => {
  const s = normalizeSettings({ classifier: { agent: "claude", model: "haiku" }, profiles: { work: { agent: "agy", model: "gemini" }, junk: { model: "x" } } });
  assert.deepEqual(Object.keys(s.profiles), ["work"]);
  assert.equal(classifierFor(s, "work").agent, "agy");
  assert.equal(classifierFor(s, "personal").model, "haiku");
  assert.equal(classifierFor(s, null).agent, "claude");
});

test("profileOf reads a space's profile through its folder, or directly", () => {
  const sf = { "": { list: [{ id: "f1", profile: "work" }], of: { s1: "f1" }, spaceProfiles: { s2: "personal" } } };
  assert.equal(profileOf({ id: "s1" }, sf), "work");
  assert.equal(profileOf({ id: "s2" }, sf), "personal");
  assert.equal(profileOf({ id: "s3" }, sf), null);
  assert.equal(profileOf({ id: "s1" }, undefined), null);
});

test("rows follow the selected profile; tasks (no profile) stay; the rest is counted as hidden", () => {
  const pr = [{ id: "a", prKey: "k", level: "error", title: "w", body: "", at: 1, profile: "work" }, { id: "b", prKey: "k", level: "error", title: "p", body: "", at: 2, profile: "personal" }];
  const items = buildItems({ agents: [{ address: "t1", status: "done", seq: 1, space: "s1", space_name: "x", tab_name: "1" }], notifs: pr, runs, settings: S, state: emptyState(), profileOfSpace: (id) => (id === "s1" ? "personal" : null) });
  const keys = rank(items, { profile: "work", showSeen: true }).map((i) => i.key);
  assert.ok(keys.includes("pr-a") && keys.includes("task-r1"));
  assert.ok(!keys.includes("pr-b") && !keys.includes("ag-t1-1"));
  assert.equal(hiddenElsewhere(items, "work"), 2);
  assert.equal(rank(items, { showSeen: true }).length, items.length);
  assert.equal(inProfile({ profile: null }, "work"), true);
  assert.equal(needsYouCount(items, "personal"), 2); // personal CI + failed task
});

test("a task run follows the profiles of the spaces in its folder", () => {
  const sf = { "": { list: [], of: {}, spaceProfiles: { s1: "work", s2: "personal" } } };
  const sp = [{ id: "s1", folder: "/src/api" }, { id: "s2", folder: "/src/blog" }];
  assert.deepEqual(profilesOfFolder("/src/api", sp, sf), ["work"]);
  assert.deepEqual(profilesOfFolder("/src/api/sub", sp, sf), ["work"]);
  assert.equal(profilesOfFolder("/src/other", sp, sf), null);
  const items = buildItems({ runs, settings: S, state: emptyState(), folderProfiles: (id) => (id === "a" ? ["work"] : null) });
  const keys = rank(items, { profile: "personal", showSeen: true }).map((i) => i.key);
  assert.ok(!keys.includes("task-r1"), "work task hidden under personal");
  assert.ok(keys.includes("task-r2"), "folder unknown: shown");
  assert.ok(rank(items, { profile: "work" }).some((i) => i.key === "task-r1"));
});

test("the real AskUserQuestion screen (rule between options, descriptions, built-in rows) becomes a DECISION card", () => {
  const screen = readFileSync(new URL("./fixture-askuserquestion.txt", import.meta.url), "utf8");
  const d = parseDialog(screen);
  assert.ok(d, "dialog found");
  assert.equal(d.kind, "DECISION");
  assert.equal(d.multi, false);
  assert.deepEqual(d.options.map((o) => o.label), ["Responder pelo card", "Responder no terminal", "Cancelar o teste"]);
  assert.equal(d.options[0].recommended, true);
  assert.match(d.options[0].desc, /Clique nesta/);
  assert.match(d.question, /Teste do Inbox/);
});

test("Antigravity's dialog (> cursor, Navigate footer, Write-in row) is a card answered with arrows and Enter", () => {
  const screen = readFileSync(new URL("./fixture-agy-question.txt", import.meta.url), "utf8");
  const d = parseDialog(screen);
  assert.ok(d, "dialog found");
  assert.equal(d.question, "Qual bebida você prefere agora?");
  assert.deepEqual(d.options.map((o) => o.label), ["Café", "Chá", "Água"]);
  assert.equal(d.options[0].recommended, true);
  assert.equal(d.options[0].current, true);
  const card = { mode: "dialog", nav: "arrows", options: d.options };
  assert.deepEqual(answerPlan(card, { option: 1 }), { keys: ["enter"] });
  assert.deepEqual(answerPlan(card, { option: 3 }), { keys: ["down", "down", "enter"] });
  const moved = { ...card, options: d.options.map((o) => ({ ...o, current: o.n === 3 })) };
  assert.deepEqual(answerPlan(moved, { option: 1 }), { keys: ["up", "up", "enter"] });
  assert.deepEqual(answerPlan({ mode: "dialog", nav: "number", options: d.options }, { option: 2 }), { keys: ["2"] });
});

test("the next question of a set is another dialog, so answering one is seen as delivered", () => {
  const screen = readFileSync(new URL("./fixture-agy-question.txt", import.meta.url), "utf8");
  const next = screen.replace("Question 1/1: Qual bebida você prefere agora?", "Question 2/2: Quantos passageiros?")
    .replace("1. (Recommended) Café", "1. (Recommended) 1 adulto").replace("2. Chá", "2. 2 adultos").replace("3. Água", "3. 3 adultos");
  const a = parseDialog(screen), b = parseDialog(next);
  assert.equal(b.question, "Quantos passageiros?");
  assert.equal(dialogId(a), dialogId(parseDialog(screen)));
  assert.notEqual(dialogId(a), dialogId(b));
  assert.equal(dialogId(null), null);
});

test("a multi-select reads its boxes, drops the boxed own rows, and a toggle is not a new dialog", () => {
  const fx = (f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  const d = parseDialog(fx("fixture-multiselect.txt"));
  assert.equal(d.checkbox, true);
  assert.deepEqual(d.options.map((o) => [o.n, o.label, o.checked]), [[1, "Café", true], [2, "Chá", false], [3, "Água", false]]);
  assert.deepEqual(d.tabs, [{ label: "Bebidas", done: true }, { label: "Única", done: false }]);
  assert.equal(d.question, "Quais bebidas você toma no dia? (marque várias, no terminal)");
  assert.equal(dialogId(d), dialogId(parseDialog(fx("fixture-multiselect-empty.txt")))); // [ ] → [✔] is the same dialog
  const card = { mode: "dialog", nav: "number", options: d.options };
  assert.deepEqual(answerPlan(card, { checked: [1, 3] }), { keys: ["3", "right"] }); // Café is already ticked
  assert.deepEqual(answerPlan(card, { checked: [2] }), { keys: ["1", "2", "right"] });
  assert.deepEqual(answerPlan(card, { nav: "back" }), { keys: ["left"] });
  assert.deepEqual(answerPlan(card, { nav: "next" }), { keys: ["right"] });
});

test("Antigravity's set gives its step", () => {
  const screen = readFileSync(new URL("./fixture-agy-question.txt", import.meta.url), "utf8").replace("Question 1/1:", "Question 2/4:");
  assert.deepEqual(parseDialog(screen).step, { n: 2, total: 4 });
  assert.equal(parseDialog(CHOICE).step, null);
  assert.equal(parseDialog(CHOICE).checkbox, false);
});

test("a dismissed ask hides only that card, not the same question asked again later", () => {
  const card = (at) => ({ key: "ask-t1-abc", address: "t1", kind: "DECISION", title: "s · 1", question: "Q?", at, options: [] });
  const state = { ...emptyState(), dismissed: { "ask-t1-abc": 200, "pr-x": 1 } };
  const one = (at) => buildItems({ asks: [card(at)], settings: DEFAULT_SETTINGS, state }).find((i) => i.key === "ask-t1-abc");
  assert.equal(one(100).dismissed, true); // dismissed after it appeared
  assert.equal(one(300).dismissed, false); // asked again after the dismissal
  const pr = buildItems({ notifs: [{ id: "x", prKey: "k", level: "info", title: "t", body: "", at: 999 }], settings: DEFAULT_SETTINGS, state })[0];
  assert.equal(pr.dismissed, true); // other rows stay dismissed for good
});

test("auto-seen takes only informational rows of the active profile", () => {
  const items = buildItems({
    agents, runs, asks: [ask], settings: S, state: emptyState(),
    notifs: [{ id: "i", prKey: "k", level: "info", title: "Merged", body: "", at: 1, profile: "work" }, { id: "w", prKey: "k", level: "warning", title: "Review", body: "", at: 2, profile: "work" }, { id: "o", prKey: "k", level: "info", title: "Other", body: "", at: 3, profile: "personal" }, ...notifs],
  });
  const keys = autoSeenItems(items, "work").map((i) => i.key);
  assert.deepEqual(keys.sort(), ["pr-i"]); // r2 is already seen, n2 read; failures, reviews, asks and agents stay
  assert.ok(autoSeenItems(items, null).some((i) => i.key === "pr-o"));
  assert.equal(normalizeSettings({ autoSeen: false }).autoSeen, false);
  assert.equal(normalizeSettings({}).autoSeen, true);
});

test("with the Agents tab open, finished agents are auto-seen too; blocked ones never", () => {
  const items = buildItems({ agents, settings: S, state: emptyState() });
  assert.deepEqual(autoSeenItems(items).map((i) => i.key), []);
  assert.deepEqual(autoSeenItems(items, null, { agentsTab: true }).map((i) => i.key), ["ag-t2-6"]);
  assert.equal(normalizeSettings({ autoSeenSeconds: 7 }).autoSeenSeconds, 5);
  assert.equal(normalizeSettings({ autoSeenSeconds: 10 }).autoSeenSeconds, 10);
});
