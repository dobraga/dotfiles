import { describe, expect, test } from "bun:test";
import { plist, unit } from "../src/service.ts";

const spec = { exe: "/h/tools/herdr-tasks/bin/herdr-tasks", logs: "/h/.local/state/herdr/tasks/daemon.log", env: { PATH: "/a:/b", HOME: "/h", ZED: "x&y" } };

describe("service rendering", () => {
  test("systemd unit runs the daemon in standby, appends logs, restarts, and bakes the env sorted", () => {
    const u = unit(spec);
    expect(u).toContain('ExecStart="/h/tools/herdr-tasks/bin/herdr-tasks" daemon --standby');
    expect(u).toContain("StandardOutput=append:/h/.local/state/herdr/tasks/daemon.log");
    expect(u).toContain("Restart=always");
    expect(u).toContain("WantedBy=default.target");
    expect(u.indexOf("HOME=")).toBeLessThan(u.indexOf("PATH="));
    expect(u).toContain('Environment="ZED=x&y"');
  });
  test("launchd plist is valid XML with escaping, RunAtLoad and KeepAlive", () => {
    const p = plist(spec);
    expect(p).toContain("<key>Label</key><string>dev.herdr.tasks</string>");
    expect(p).toContain("<string>daemon</string><string>--standby</string>");
    expect(p).toContain("<key>ZED</key><string>x&amp;y</string>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).toContain("<key>KeepAlive</key><true/>");
  });
});
