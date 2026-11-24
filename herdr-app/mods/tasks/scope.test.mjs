import { test } from "node:test";
import assert from "node:assert/strict";
import { taskVisible } from "./scope.js";

const sf = { "": { list: [{ id: "f1", profile: "work" }], of: { s1: "f1" }, spaceProfiles: { s2: "personal" } } };
const spaces = [{ id: "s1", folder: "/src/api" }, { id: "s2", folder: "/src/blog" }, { id: "s3", folder: "/src/remote", machine: "m" }];

test("a run is shown when a space of the active profile works in its folder", () => {
  assert.equal(taskVisible("/src/api", spaces, sf, "work"), true);
  assert.equal(taskVisible("/src/api", spaces, sf, "personal"), false);
  assert.equal(taskVisible("/src/blog/posts", spaces, sf, "personal"), true);
});
test("no profile selected, unknown folder or remote-only space: never hidden", () => {
  assert.equal(taskVisible("/src/api", spaces, sf, null), true);
  assert.equal(taskVisible("/src/none", spaces, sf, "work"), true);
  assert.equal(taskVisible("/src/remote", spaces, sf, "work"), true);
  assert.equal(taskVisible(undefined, spaces, sf, "work"), true);
});
