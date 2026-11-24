// One login service runs the daemon: a systemd user unit on Linux, a launchd agent on macOS (after herdr-automations'
// internal/service, MIT, see NOTICE.md). Both are rendered by pure functions so they are testable without either
// system. The unit creates the log directory first: upstream's installer did not and the service failed to start
// (status 209/STDOUT) until the directory existed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export interface Spec {
  exe: string;
  logs: string;
  env: Record<string, string>;
}

export const LABEL = "dev.herdr.tasks";
export const UNIT = "herdr-tasks.service";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sortedKeys = (m: Record<string, string>) => Object.keys(m).sort();

export function plist(s: Spec): string {
  const env = sortedKeys(s.env).map((k) => `    <key>${xml(k)}</key><string>${xml(s.env[k])}</string>\n`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(s.exe)}</string><string>daemon</string><string>--standby</string></array>
  <key>EnvironmentVariables</key>
  <dict>
${env}  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(s.logs)}</string>
  <key>StandardErrorPath</key><string>${xml(s.logs)}</string>
</dict>
</plist>
`;
}

const q = (s: string) => JSON.stringify(s); // systemd accepts C-style quoting, the same as Go's %q for these strings

export function unit(s: Spec): string {
  const env = sortedKeys(s.env).map((k) => `Environment=${q(`${k}=${s.env[k]}`)}\n`).join("");
  return `[Unit]
Description=herdr-tasks scheduler

[Service]
ExecStart=${q(s.exe)} daemon --standby
${env}StandardOutput=append:${s.logs}
StandardError=append:${s.logs}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export const unitPath = (home = homedir()) => join(home, ".config/systemd/user", UNIT);
export const plistPath = (home = homedir()) => join(home, "Library/LaunchAgents", `${LABEL}.plist`);

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

export function install(spec: Spec): string {
  mkdirSync(dirname(spec.logs), { recursive: true });
  if (platform() === "darwin") {
    const file = plistPath();
    mkdirSync(dirname(file), { recursive: true });
    const domain = `gui/${process.getuid?.() ?? 501}`;
    try { run("launchctl", ["bootout", domain, file]); } catch {} // not loaded yet is fine
    writeFileSync(file, plist(spec));
    run("launchctl", ["bootstrap", domain, file]);
    return file;
  }
  const file = unitPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, unit(spec));
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", UNIT]);
  return file;
}

export function uninstall(): void {
  if (platform() === "darwin") {
    const file = plistPath();
    try { run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, file]); } catch {}
    rmSync(file, { force: true });
    return;
  }
  try { run("systemctl", ["--user", "disable", "--now", UNIT]); } catch {}
  rmSync(unitPath(), { force: true });
  try { run("systemctl", ["--user", "daemon-reload"]); } catch {}
}

export function status(): { installed: boolean; active: boolean } {
  if (platform() === "darwin") {
    const installed = existsSync(plistPath());
    let active = false;
    try { active = run("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${LABEL}`]).includes("state = running"); } catch {}
    return { installed, active };
  }
  let active = false;
  try { active = run("systemctl", ["--user", "is-active", UNIT]).trim() === "active"; } catch {}
  return { installed: existsSync(unitPath()), active };
}
