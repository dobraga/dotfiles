import { test, expect } from "bun:test";
import { parseListOutput, parseMetadata, pickActive, signature, sendCommand, fmtTime, pillLabel, brandOf } from "../herdr-app/mods/workspace-status-usage/media.js";

test("parseListOutput keeps only mpris names", () => {
  const out = "org.mpris.MediaPlayer2.brave.instance1 1 brave u :1.1\n:1.5 2 x\norg.freedesktop.DBus 1 dbus";
  expect(parseListOutput(out)).toEqual(["org.mpris.MediaPlayer2.brave.instance1"]);
});

test("parseMetadata joins artists", () => {
  const md = { "xesam:title": { data: "T" }, "xesam:artist": { data: ["A", "B"] }, "mpris:length": { data: 5 } };
  expect(parseMetadata(md)).toMatchObject({ title: "T", artist: "A, B", lengthUs: 5 });
});

test("pickActive prefers Playing, then Paused, else null", () => {
  expect(pickActive([{ status: "Paused", id: 1 }, { status: "Playing", id: 2 }]).id).toBe(2);
  expect(pickActive([{ status: "Paused", id: 1 }]).id).toBe(1);
  expect(pickActive([])).toBeNull();
});

test("signature ignores position/syncedAt", () => {
  expect(signature({ a: 1, positionUs: 1, syncedAt: 2 })).toBe(signature({ a: 1, positionUs: 9, syncedAt: 8 }));
  expect(signature({ a: 1 })).not.toBe(signature({ a: 2 }));
});

test("sendCommand passes -- before bus so negative seek is safe", async () => {
  let args;
  await sendCommand(async (_c, a) => ((args = a), { code: 0 }), "org.mpris.MediaPlayer2.x", "seek", -5e6);
  expect(args.indexOf("--")).toBeLessThan(args.indexOf("org.mpris.MediaPlayer2.x"));
  expect(args.at(-1)).toBe("-5000000");
});

test("volume falls back to wpctl when MPRIS set fails", async () => {
  const calls = [];
  await sendCommand(async (c, a) => (calls.push(c), { code: c === "busctl" ? 1 : 0 }), "b", "volume", 0.5);
  expect(calls).toEqual(["busctl", "wpctl"]);
});

test("format helpers", () => {
  expect(fmtTime(65e6)).toBe("1:05");
  expect(pillLabel({ title: "x".repeat(50), artist: "" }, 10).length).toBe(10);
  expect(brandOf("org.mpris.MediaPlayer2.spotify")).toBe("spotify");
});
