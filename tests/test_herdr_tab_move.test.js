import { test, expect } from "bun:test";
import { dropPlace, mergeTab, terminalsOf, findTab } from "../herdr-app/mods/tabs-folders/move.js";

const term = (id, t, extra = {}) => ({ type: "block", id, content: { terminal: t }, ...extra });
const chat = (id) => ({ type: "block", id, content: { mod: "chat", props: { chat: "c-1" } } });
const tab = (id, children) => ({ id, name: id, root: { type: "row", id, children } });
const doc = () => ({
  spaces: [
    { id: "sp1", tabs: [tab("a", [term("p1", "t1")]), tab("b", [chat("p2"), term("p3", "t2", { hidden: true })]), tab("c", [term("p4", "t3"), term("p5", "t4")])] },
    { id: "sp2", tabs: [tab("z", [term("p9", "t9")])] },
  ],
});
let n = 0;
const newId = () => `s${++n}`;
const ids = (list) => list.map((x) => x.id);

test("dropPlace: bar, right, down", () => {
  expect(dropPlace({ x: 10, y: 20 }, 40, 1000)).toBe(null);
  expect(dropPlace({ x: 10, y: 40 }, 40, 1000)).toBe(null);
  expect(dropPlace({ x: 10, y: 300 }, 40, 1000)).toBe("right");
  expect(dropPlace({ x: 10, y: 900 }, 40, 1000)).toBe("down");
  expect(dropPlace(null, 40, 1000)).toBe(null);
});

test("terminalsOf walks nested containers", () => {
  expect(terminalsOf(tab("x", [{ type: "column", id: "s", children: [term("p1", "t1"), term("p2", "t2")] }, chat("p3")]))).toEqual(["t1", "t2"]);
});

test("right: appends the moved panes and drops the source tab", () => {
  const d = doc(), out = mergeTab(d, "b", "a", "right", newId);
  expect(ids(out.spaces[0].tabs)).toEqual(["a", "c"]);
  const root = findTab(out, "a").tab.root;
  expect(root.id).toBe("a");
  expect(ids(root.children)).toEqual(["p1", "p2", "p3"]);
  expect(root.children[2].hidden).toBe(true);
  expect(ids(d.spaces[0].tabs)).toEqual(["a", "b", "c"]); // input untouched
  expect(out.spaces[1]).toBe(d.spaces[1]);
});

test("down: a column of both halves, hidden panes left at the root", () => {
  const out = mergeTab(doc(), "b", "c", "down", newId);
  const root = findTab(out, "c").tab.root;
  expect(root.children.length).toBe(2);
  const [col, host] = root.children;
  expect(col.type).toBe("column");
  expect(col.children[0].type).toBe("row");
  expect(ids(col.children[0].children)).toEqual(["p4", "p5"]);
  expect(col.children[1].id).toBe("p2"); // one pane: no wrapper
  expect(host.id).toBe("p3");
});

test("refuses: same tab, missing tab, other space, bad place, unknown shape", () => {
  expect(mergeTab(doc(), "a", "a", "right", newId)).toBe(null);
  expect(mergeTab(doc(), "nope", "a", "right", newId)).toBe(null);
  expect(mergeTab(doc(), "z", "a", "right", newId)).toBe(null);
  expect(mergeTab(doc(), "b", "a", "left", newId)).toBe(null);
  const odd = doc(); odd.spaces[0].tabs[0].root = { type: "stack", id: "a" };
  expect(mergeTab(odd, "b", "a", "right", newId)).toBe(null);
  expect(mergeTab(null, "b", "a", "right", newId)).toBe(null);
});
