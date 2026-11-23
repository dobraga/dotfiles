#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface MergeTargets {
  claudeSettingsPath: string;
  agyHooksPath: string;
  agyMcpPath: string;
  revuBinPath: string;
}

function readJsonOrEmpty(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, any>;
}

function writeJsonPretty(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function mergeClaudeSettings(path: string, revuCmd: string): boolean {
  const cfg = readJsonOrEmpty(path);
  cfg.hooks = cfg.hooks && typeof cfg.hooks === "object" ? cfg.hooks : {};
  const list: any[] = Array.isArray(cfg.hooks.PermissionRequest)
    ? cfg.hooks.PermissionRequest
    : [];

  const already = list.some(
    (entry) =>
      entry?.matcher === "ExitPlanMode" &&
      Array.isArray(entry?.hooks) &&
      entry.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes("revu hook claude"))
  );

  if (already) return false;

  list.push({
    matcher: "ExitPlanMode",
    hooks: [
      {
        type: "command",
        command: `${revuCmd} hook claude`,
        timeout: 86400,
      },
    ],
  });
  cfg.hooks.PermissionRequest = list;
  writeJsonPretty(path, cfg);
  return true;
}

export function mergeAgyHooks(path: string, revuCmd: string): boolean {
  const cfg = readJsonOrEmpty(path);
  const desired = {
    PreToolUse: [
      {
        matcher: "exit_plan_mode",
        hooks: [
          {
            type: "command",
            command: `${revuCmd} hook agy-exit-plan`,
            timeout: 86400,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "write_file|edit_file",
        hooks: [
          {
            type: "command",
            command: `${revuCmd} hook agy-mark`,
            timeout: 5,
          },
        ],
      },
    ],
    Stop: [
      {
        type: "command",
        command: `${revuCmd} hook agy-stop`,
        timeout: 3600,
      },
    ],
  };

  const prev = JSON.stringify(cfg["revu-plan-gate"] ?? null);
  const next = JSON.stringify(desired);
  if (prev === next) return false;

  cfg["revu-plan-gate"] = desired;
  writeJsonPretty(path, cfg);
  return true;
}

export function mergeAgyMcp(path: string, revuBinPath: string): boolean {
  const cfg = readJsonOrEmpty(path);
  cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {};
  const desired = {
    command: revuBinPath,
    args: ["mcp"],
  };
  const prev = JSON.stringify(cfg.mcpServers.revu ?? null);
  const next = JSON.stringify(desired);
  if (prev === next) return false;

  cfg.mcpServers.revu = desired;
  writeJsonPretty(path, cfg);
  return true;
}

export function mergeAll(targets: MergeTargets): {
  claudeChanged: boolean;
  agyHooksChanged: boolean;
  agyMcpChanged: boolean;
} {
  const claudeChanged = mergeClaudeSettings(targets.claudeSettingsPath, targets.revuBinPath);
  const agyHooksChanged = mergeAgyHooks(targets.agyHooksPath, targets.revuBinPath);
  const agyMcpChanged = mergeAgyMcp(targets.agyMcpPath, targets.revuBinPath);
  return { claudeChanged, agyHooksChanged, agyMcpChanged };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const dotfilesRoot = resolve(import.meta.dir, "..", "..", "..");
  const home = homedir();

  const targets: MergeTargets = {
    claudeSettingsPath: getArg("--claude-settings") ?? join(dotfilesRoot, ".claude", "settings.json"),
    agyHooksPath: getArg("--agy-hooks") ?? join(home, ".gemini", "config", "hooks.json"),
    agyMcpPath: getArg("--agy-mcp") ?? join(home, ".gemini", "config", "mcp_config.json"),
    revuBinPath: getArg("--revu-bin") ?? join(home, ".local", "bin", "revu"),
  };

  const res = mergeAll(targets);
  console.log(
    `revu config merge: claude=${res.claudeChanged ? "updated" : "ok"} agy-hooks=${
      res.agyHooksChanged ? "updated" : "ok"
    } agy-mcp=${res.agyMcpChanged ? "updated" : "ok"}`
  );
}
