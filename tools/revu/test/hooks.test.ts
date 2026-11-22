import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeHookOutput,
  resolveClaudePlanContent,
} from "../src/hooks/claude.ts";
import {
  buildAgyStopOutput,
  isPlanFileCandidate,
  processAgyMark,
} from "../src/hooks/agy.ts";
import { loadPendingAgyPlan } from "../src/session.ts";
import { mergeAll } from "../scripts/merge-configs.ts";

let tempDir: string;
const prevEnv = process.env.REVU_DATA_DIR;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "revu-hooks-test-"));
  process.env.REVU_DATA_DIR = tempDir;
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.REVU_DATA_DIR;
  else process.env.REVU_DATA_DIR = prevEnv;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Claude Code ExitPlanMode hook contract", () => {
  test("prefers fresh planFilePath content over stale inline plan", () => {
    const planFile = join(tempDir, "plan.md");
    writeFileSync(planFile, "# Fresh Plan From Disk\n", "utf8");
    const res = resolveClaudePlanContent({
      plan: "# Stale Inline Plan",
      planFilePath: planFile,
    });
    expect(res.planContent).toBe("# Fresh Plan From Disk\n");
    expect(res.planPath).toBe(planFile);
  });

  test("emits updatedInput on allow (Claude Code >= 2.1.199 requirement) and message on deny", () => {
    const event = {
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "old", extraFlag: true },
    };

    const allow = buildClaudeHookOutput(event, "# Reviewed Plan", true, "") as any;
    expect(allow.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(allow.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(allow.hookSpecificOutput.decision.updatedInput.plan).toBe("# Reviewed Plan");
    expect(allow.hookSpecificOutput.decision.updatedInput.extraFlag).toBe(true);

    const deny = buildClaudeHookOutput(event, "# Reviewed Plan", false, "Fix step 2") as any;
    expect(deny.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(deny.hookSpecificOutput.decision.message).toContain("Fix step 2");
  });
});

describe("Antigravity (AGY) plan hooks contract", () => {
  test("detects RequestFeedback artifacts and docs/tasks/plan-*.md files", () => {
    const planA = join(tempDir, "implementation_plan.md");
    writeFileSync(planA, "# Plan A", "utf8");

    expect(
      isPlanFileCandidate({
        conversationId: "conv-1",
        toolCall: {
          name: "write_file",
          args: { Path: planA, ArtifactMetadata: { RequestFeedback: true, UserFacing: true } },
        },
      })
    ).toBe(planA);

    expect(
      isPlanFileCandidate({
        conversationId: "conv-1",
        toolCall: {
          name: "write_file",
          args: { Path: "/repo/docs/tasks/plan-auth.md" },
        },
      })
    ).toBe("/repo/docs/tasks/plan-auth.md");

    expect(
      isPlanFileCandidate({
        conversationId: "conv-1",
        toolCall: {
          name: "write_file",
          args: { Path: "/repo/README.md" },
        },
      })
    ).toBeNull();

    // processAgyMark writes pending marker
    processAgyMark({
      conversationId: "conv-1",
      toolCall: {
        name: "write_file",
        args: { Path: planA, ArtifactMetadata: { RequestFeedback: true } },
      },
    });
    const marker = loadPendingAgyPlan("conv-1");
    expect(marker?.path).toBe(planA);
    expect(marker?.sha256).toBeTruthy();
  });

  test("builds correct Stop outputs for approve, approve_and_proceed, and request_changes", () => {
    expect(buildAgyStopOutput("approve", "")).toEqual({ decision: "" });
    const proceed = buildAgyStopOutput("approve_and_proceed", "");
    expect(proceed.decision).toBe("continue");
    expect(proceed.reason).toContain("Proceed");
    const changes = buildAgyStopOutput("request_changes", "# Feedback");
    expect(changes.decision).toBe("continue");
    expect(changes.reason).toContain("# Feedback");
  });
});

describe("idempotent config merger", () => {
  test("preserves existing hooks and MCP servers without clobbering", () => {
    const claudePath = join(tempDir, "claude-settings.json");
    const agyHooksPath = join(tempDir, "agy-hooks.json");
    const agyMcpPath = join(tempDir, "agy-mcp.json");

    writeFileSync(claudePath, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [] }] } }));
    writeFileSync(agyHooksPath, JSON.stringify({ "orca-status": { Stop: [] } }));
    writeFileSync(agyMcpPath, JSON.stringify({ mcpServers: { "canva-dev": { command: "npx" } } }));

    const first = mergeAll({
      claudeSettingsPath: claudePath,
      agyHooksPath,
      agyMcpPath,
      revuBinPath: "/home/user/.local/bin/revu",
    });
    expect(first).toEqual({ claudeChanged: true, agyHooksChanged: true, agyMcpChanged: true });

    // Second run is a clean no-op
    const second = mergeAll({
      claudeSettingsPath: claudePath,
      agyHooksPath,
      agyMcpPath,
      revuBinPath: "/home/user/.local/bin/revu",
    });
    expect(second).toEqual({ claudeChanged: false, agyHooksChanged: false, agyMcpChanged: false });

    const agyHooks = JSON.parse(readFileSync(agyHooksPath, "utf8"));
    expect(agyHooks["orca-status"]).toBeDefined();
    expect(agyHooks["revu-plan-gate"].Stop[0].command).toContain("revu hook agy-stop");

    const agyMcp = JSON.parse(readFileSync(agyMcpPath, "utf8"));
    expect(agyMcp.mcpServers["canva-dev"]).toBeDefined();
    expect(agyMcp.mcpServers.revu.args).toEqual(["mcp"]);
  });
});
