import { test } from "node:test";
import assert from "node:assert/strict";
import { groupVariants, parseEfforts, parseModelList, shape, baseOf, pickModel, pickEffort, effortOf, levelsOf, defaultVariant } from "./agent-models.js";

const AGY = [["gemini-4-neon-low", "Gemini 4 Neon (Low)"], ["gemini-4-neon-high", "Gemini 4 Neon (High)"], ["plain-model", "Plain"]];

test("per-level models are grouped under one base", () => {
  const g = groupVariants(AGY);
  assert.deepEqual(g.bases, [["gemini-4-neon", "Gemini 4 Neon"], ["plain-model", "Plain"]]);
  assert.deepEqual(g.variants["gemini-4-neon"], { low: "gemini-4-neon-low", high: "gemini-4-neon-high" });
  assert.equal(groupVariants([["a", "A"]]), null);
});

test("efforts come from the --effort line of --help", () => {
  assert.deepEqual(parseEfforts("  --effort <level>  Effort (low, medium, high, xhigh, max)"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(parseEfforts("  --effort <level>  reasoning effort"), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(parseEfforts("no such flag"), null);
});

test("model list output is parsed (tab separated or bare ids)", () => {
  assert.deepEqual(parseModelList("m1\tModel One\nm2\n\nbad line here\n"), [["m1", "Model One"], ["m2", "m2"]]);
});

test("claude uses its fixed models and efforts; agy groups variants and drops the effort flag", () => {
  const c = shape("claude", "  --effort <l> (low, high)", null);
  assert.equal(c.models.length, 4);
  assert.deepEqual(c.efforts, ["low", "high"]);
  const a = shape("agy", "  models  list\n", "gemini-4-neon-low\tGemini 4 Neon (Low)\ngemini-4-neon-high\tGemini 4 Neon (High)\n");
  assert.equal(a.efforts, null);
  assert.ok(a.variants["gemini-4-neon"]);
});

test("choosing model and effort keeps the per-level id in step", () => {
  const v = groupVariants(AGY).variants;
  assert.deepEqual(pickModel(v, "gemini-4-neon", ""), { model: defaultVariant(v["gemini-4-neon"]), effort: "" });
  assert.equal(pickModel(v, "plain-model", "").model, "plain-model");
  assert.deepEqual(pickEffort(v, "gemini-4-neon-low", "high"), { model: "gemini-4-neon-high", effort: "" });
  assert.equal(baseOf(v, "gemini-4-neon-high"), "gemini-4-neon");
  assert.equal(effortOf(v, "gemini-4-neon-high", ""), "high");
  assert.deepEqual(levelsOf(v, "gemini-4-neon-low", null), ["low", "high"]);
  // no variants: the effort is stored as is
  assert.deepEqual(pickEffort(null, "claude-opus-5-5", "high"), { model: "claude-opus-5-5", effort: "high" });
  assert.deepEqual(pickModel(null, "claude-haiku-5-5", "high"), { model: "claude-haiku-5-5", effort: "high" });
});
