import { describe, expect, test } from "bun:test";
import { cronProblem, nextRuns, parseCron } from "../src/cron.ts";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("parseCron", () => {
  test("accepts the standard forms and descriptors", () => {
    for (const e of ["* * * * *", "*/5 * * * *", "0 9 * * 1-5", "0 9 * * mon-fri", "30 4 1,15 * *", "0 0 1 jan *", "@daily", "@hourly", "@weekly", "0 9 * * 7", "5/20 * * * *", "0 9 ? * *"])
      expect(cronProblem(e)).toBeNull();
  });
  test("rejects wrong field counts, ranges and names", () => {
    expect(cronProblem("nope")).toContain("5 fields");
    expect(cronProblem("61 * * * *")).toContain("out of range");
    expect(cronProblem("* 24 * * *")).toContain("out of range");
    expect(cronProblem("* * 0 * *")).toContain("out of range");
    expect(cronProblem("* * * 13 *")).toContain("out of range");
    expect(cronProblem("* * * * 8")).toContain("out of range");
    expect(cronProblem("*/0 * * * *")).toContain("step");
    expect(cronProblem("* * * foo *")).toContain("invalid");
    expect(cronProblem("@every 1h")).toContain("unsupported");
  });
});

describe("next", () => {
  test("is strictly after the given time and on a whole minute", () => {
    const c = parseCron("*/15 * * * *");
    expect(c.next(at(2026, 8, 10, 9, 0))).toEqual(at(2026, 8, 10, 9, 15));
    expect(c.next(new Date(at(2026, 8, 10, 9, 14).getTime() + 30_000))).toEqual(at(2026, 8, 10, 9, 15));
  });
  test("weekdays at 09:00 skips the weekend", () => {
    const c = parseCron("0 9 * * 1-5");
    expect(c.next(at(2026, 8, 7, 9, 0))).toEqual(at(2026, 8, 10, 9, 0)); // Fri -> Mon
  });
  test("day-of-month OR day-of-week when both are restricted, AND when either is *", () => {
    const both = parseCron("0 9 13 * 5"); // the 13th OR any Friday
    expect(both.matches(at(2026, 8, 14, 9, 0))).toBe(true); // a Friday
    expect(both.matches(at(2026, 8, 13, 9, 0))).toBe(true); // the 13th (a Thursday)
    expect(both.matches(at(2026, 8, 12, 9, 0))).toBe(false);
    const dowOnly = parseCron("0 9 * * 5");
    expect(dowOnly.matches(at(2026, 8, 13, 9, 0))).toBe(false);
  });
  test("month names, Sunday as 0 and 7, lists and steps", () => {
    expect(parseCron("0 0 1 jan *").next(at(2026, 8, 1))).toEqual(at(2027, 1, 1));
    expect(parseCron("0 9 * * 0").matches(at(2026, 8, 9, 9, 0))).toBe(true);
    expect(parseCron("0 9 * * 7").matches(at(2026, 8, 9, 9, 0))).toBe(true);
    expect(nextRuns("0,30 8-9 * * *", at(2026, 8, 10, 7, 0), 4)).toEqual([at(2026, 8, 10, 8, 0), at(2026, 8, 10, 8, 30), at(2026, 8, 10, 9, 0), at(2026, 8, 10, 9, 30)]);
  });
  test("rolls over month and year ends", () => {
    expect(parseCron("0 0 31 * *").next(at(2026, 2, 1))).toEqual(at(2026, 3, 31));
    expect(parseCron("59 23 31 12 *").next(at(2026, 12, 31, 23, 59))).toEqual(at(2027, 12, 31, 23, 59));
  });
  test("never matching dates give null instead of looping", () => {
    expect(parseCron("0 0 30 2 *").next(at(2026, 1, 1))).toBeNull();
  });
});
