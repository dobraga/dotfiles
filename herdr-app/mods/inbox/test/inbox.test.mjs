import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDialog, lastMessage, parseStopped, parseClassifier, answerPlan, composeAnswers, decisionLine, hash, classifyPrompt } from "../asks.js";
import { profilesOfFolder, inProfile, hiddenElsewhere, profileOf, classifierFor, buildItems, rank, normalizeSettings, pruneState, emptyState, parseState, needsYouCount, DEFAULT_SETTINGS } from "../items.js";

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

test("the several-questions dialog is flagged multi", () => {
  assert.equal(parseDialog(MULTI).multi, true);
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
