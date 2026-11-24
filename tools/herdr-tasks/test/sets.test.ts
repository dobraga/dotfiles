import { describe, expect, test } from "bun:test";
import { assignIds, availableVars, envFor, envName, insertionFor, referencesIn, render, runSet, validateSet } from "../src/sets.js";

const cmd = (command: string, extra = {}) => ({ kind: "command", command, ...extra });
const prompt = (p: string, extra = {}) => ({ kind: "prompt", prompt: p, agent: "claude", ...extra });

describe("assignIds", () => {
  test("keeps valid unique ids and fills the rest with the next free sN", () => {
    const out = assignIds([cmd("a", { id: "build" }), cmd("b"), prompt("c", { id: "s2" }), cmd("d", { id: "build" }), cmd("e", { id: "Bad Id" })]);
    expect(out.map((s) => s.id)).toEqual(["build", "s1", "s2", "s3", "s4"]);
  });
});

describe("references and variables", () => {
  test("finds every reference with its field", () => {
    expect(referencesIn("a {{steps.s1.stdout}} b {{ steps.s2.response }}").map((r) => `${r.id}.${r.field}`)).toEqual(["s1.stdout", "s2.response"]);
  });
  test("offers earlier steps only, with the fields of their kind", () => {
    const steps = assignIds([cmd("x"), prompt("y"), cmd("z")]);
    expect(availableVars(steps, 0)).toEqual([]);
    expect(availableVars(steps, 2).map((v) => `${v.id}:${v.fields[0]}`)).toEqual(["s1:stdout", "s2:response"]);
  });
});

describe("validateSet", () => {
  test("a valid chain has no problems: prompts use templates, commands use environment variables", () => {
    const steps = assignIds([cmd("git log -5"), prompt("summarise {{steps.s1.stdout}}", { when: "prev_output" }), cmd('echo "$HERDR_S2_RESPONSE"', { when: "prev_ok" }), prompt("translate {{steps.s2.response}}")]);
    expect(validateSet(steps)).toEqual([]);
  });
  test("rejects forward and self references, unknown ids and wrong fields in prompts", () => {
    const steps = assignIds([prompt("{{steps.s2.response}}"), prompt("{{steps.s2.response}} {{steps.nope.stdout}}"), prompt("{{steps.s1.stdout}}")]);
    const p = validateSet(steps).join("\n");
    expect(p).toContain("a later step");
    expect(p).toContain("the step itself");
    expect(p).toContain("does not exist");
    expect(p).toContain('a prompt step has no "stdout"');
  });
  test("a command may not use templates: the message points to the environment variable", () => {
    const steps = assignIds([cmd("echo hi"), cmd("echo {{steps.s1.stdout}}")]);
    const p = validateSet(steps);
    expect(p.length).toBe(1);
    expect(p[0]).toContain("cannot use {{steps.s1.stdout}}");
    expect(p[0]).toContain('"$HERDR_S1_STDOUT"');
  });
  test("rejects empty sets, empty steps, a dependent first step and duplicate ids", () => {
    expect(validateSet([])).toEqual(["The set has no steps."]);
    const p = validateSet([cmd("  ", { id: "a", when: "prev_ok" }), cmd("x", { id: "a" })]).join("\n");
    expect(p).toContain("is empty");
    expect(p).toContain("no previous step");
    expect(p).toContain("already used");
  });
});

describe("environment for commands", () => {
  test("names and values: uppercased ids and fields, trailing whitespace trimmed, objects skipped", () => {
    expect(envName("s1", "stdout")).toBe("HERDR_S1_STDOUT");
    expect(envFor({ s1: { stdout: "hi\n\n", exit_code: 0, failed: false, junk: { a: 1 } }, build: { response: "ok " } })).toEqual({
      HERDR_S1_STDOUT: "hi", HERDR_S1_EXIT_CODE: "0", HERDR_S1_FAILED: "false", HERDR_BUILD_RESPONSE: "ok",
    });
  });
  test("insertion differs by target: template for prompts, quoted variable for commands", () => {
    expect(insertionFor("prompt", "s1", "stdout")).toBe("{{steps.s1.stdout}}");
    expect(insertionFor("command", "s1", "stdout")).toBe('"$HERDR_S1_STDOUT"');
  });
});

describe("render", () => {
  test("substitutes results and blanks what did not run", () => {
    expect(render("a={{steps.s1.stdout}} b={{steps.s9.stdout}}", { s1: { stdout: "hello" } })).toBe("a=hello b=");
  });
});

describe("runSet", () => {
  const fake = (table: Record<string, any>) => async (step: any, text: string) => {
    const r = table[step.id];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(text) : r;
  };

  test("passes a command's output to a prompt and the prompt's answer to the next prompt", async () => {
    const steps = assignIds([cmd("git log"), prompt("summarise: {{steps.s1.stdout}}"), prompt("translate: {{steps.s2.response}}")]);
    const seen: string[] = [];
    const res = await runSet(steps, async (step: any, text: string, _env: any) => {
      seen.push(text);
      if (step.id === "s1") return { stdout: "feat: a\nfix: b" };
      if (step.id === "s2") return { response: "two changes" };
      return { response: "duas mudancas" };
    });
    expect(res.status).toBe("done");
    expect(seen).toEqual(["git log", "summarise: feat: a\nfix: b", "translate: two changes"]);
  });

  test("a step that references nothing receives nothing in its text", async () => {
    const steps = assignIds([cmd("echo secret"), prompt("plain prompt")]);
    const seen: string[] = [];
    await runSet(steps, async (_s: any, text: string) => (seen.push(text), { stdout: "secret", response: "r" }));
    expect(seen[1]).toBe("plain prompt");
  });

  test("a command gets its text untouched and the previous results as environment variables", async () => {
    const steps = assignIds([cmd("a"), prompt("p"), cmd('echo "$HERDR_S2_RESPONSE"')]);
    const calls: any[] = [];
    await runSet(steps, async (step: any, text: string, env: any) => {
      calls.push({ id: step.id, text, env });
      return step.id === "s1" ? { stdout: "out1\n" } : step.id === "s2" ? { response: "answer $(rm -rf /)" } : {};
    });
    expect(calls[2].text).toBe('echo "$HERDR_S2_RESPONSE"'); // never rewritten with the answer
    expect(calls[2].env).toMatchObject({ HERDR_S1_STDOUT: "out1", HERDR_S2_RESPONSE: "answer $(rm -rf /)" });
    expect(calls[1].env).toEqual({});
  });

  test("onFailure stop skips the rest; continue runs on; either way the set is failed", async () => {
    const mk = (onFailure: string) => assignIds([cmd("a", { onFailure }), cmd("b")]);
    const exec = fake({ s1: { exit_code: 3 }, s2: { stdout: "ok" } });
    const stop = await runSet(mk("stop"), exec);
    expect(stop.status).toBe("failed");
    expect(stop.steps.map((s: any) => s.status)).toEqual(["failed", "skipped"]);
    const cont = await runSet(mk("continue"), exec);
    expect(cont.status).toBe("failed");
    expect(cont.steps.map((s: any) => s.status)).toEqual(["failed", "done"]);
  });

  test("a thrown error is a failed step, not a crash", async () => {
    const res = await runSet(assignIds([cmd("a")]), fake({ s1: new Error("spawn failed") }));
    expect(res.steps[0].status).toBe("failed");
    expect(res.steps[0].result.error).toBe("spawn failed");
  });

  test("when: prev_ok needs a successful previous step; prev_output also needs non-empty output", async () => {
    const steps = assignIds([cmd("a"), cmd("b", { when: "prev_output" }), cmd("c", { when: "prev_ok" })]);
    const empty = await runSet(steps, fake({ s1: { stdout: "" }, s2: { stdout: "x" }, s3: { stdout: "y" } }));
    expect(empty.steps.map((s: any) => s.status)).toEqual(["done", "skipped", "skipped"]);
    const full = await runSet(steps, fake({ s1: { stdout: "data" }, s2: { stdout: "x" }, s3: { stdout: "y" } }));
    expect(full.steps.map((s: any) => s.status)).toEqual(["done", "done", "done"]);
  });

  test("a failed previous step with continue skips a prev_ok step", async () => {
    const steps = assignIds([cmd("a", { onFailure: "continue" }), cmd("b", { when: "prev_ok" })]);
    const res = await runSet(steps, fake({ s1: { exit_code: 1 }, s2: { stdout: "x" } }));
    expect(res.steps.map((s: any) => s.status)).toEqual(["failed", "skipped"]);
  });

  test("calls the hooks in order", async () => {
    const log: string[] = [];
    await runSet(assignIds([cmd("a"), cmd("b")]), fake({ s1: {}, s2: {} }), { onStart: (s: any) => log.push(`start ${s.id}`), onEnd: (s: any) => log.push(`end ${s.id}`) });
    expect(log).toEqual(["start s1", "end s1", "start s2", "end s2"]);
  });
});

import { runSet as runSetRetry } from "../src/sets.js";
test("retry resumes at a step with the earlier results", async () => {
  const steps = [
    { id: "s1", kind: "command", command: "a" },
    { id: "s2", kind: "prompt", prompt: "use {{steps.s1.stdout}}" },
  ];
  const ran: string[] = [];
  const res = await runSetRetry(steps, async (s: any, text: string) => { ran.push(`${s.id}:${text}`); return { response: "ok" }; }, { from: 1, seed: { s1: { stdout: "kept", exit_code: 0, failed: false } } });
  expect(ran).toEqual(["s2:use kept"]);
  expect(res.status).toBe("done");
  expect(res.steps[0]).toMatchObject({ id: "s1", status: "done", kept: true });
});
