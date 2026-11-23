import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeHookOutput,
  resolveClaudePlanContent,
} from "../src/hooks/claude.ts";
import {
  buildAgyExitPlanOutput,
  buildAgyStopOutput,
  extractPlanTitle,
  isExplicitPlanRequest,
  isPlanFileCandidate,
  looksLikeMarkdownPlan,
  normalizeCheckboxes,
  parseTranscriptTurn,
  processAgyMark,
  shouldGateExitPlan,
} from "../src/hooks/agy.ts";
import { loadPendingAgyPlan, savePendingAgyPlan, sha256 } from "../src/session.ts";
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

  test("classifies explicit /plan prompts, markdown plans, titles, and checkbox normalization", () => {
    expect(isExplicitPlanRequest("/plan fix auth")).toBe(true);
    expect(isExplicitPlanRequest("/plan")).toBe(true);
    expect(isExplicitPlanRequest("  /plan\nmulti line")).toBe(true);
    expect(isExplicitPlanRequest("pode commitar")).toBe(false);
    expect(isExplicitPlanRequest("plan something")).toBe(false);
    expect(isExplicitPlanRequest(undefined)).toBe(false);

    const validPlan =
      "# Plan: Auth Refactor\n\n## Steps\n- [ ] Update token validator to enforce issuer checks across services.\n- [ ] Run test suite.\n";
    expect(looksLikeMarkdownPlan(validPlan)).toBe(true);
    expect(looksLikeMarkdownPlan("Qual opção você prefere: 1 ou 2?")).toBe(false);
    expect(looksLikeMarkdownPlan("# Short\n- ok")).toBe(false);

    expect(extractPlanTitle("# **Plan:** `Auth` Refactor\n\nBody")).toBe("Plan: Auth Refactor");
    expect(extractPlanTitle("No heading here", "fallback.md")).toBe("fallback.md");

    const unchecked = "# Plan\n- [ ] Step 1\n- [ ] Step 2\n";
    const checked = "# Plan\n- [x] Step 1\n- [X] Step 2\r\n";
    const edited = "# Plan\n- [x] Step 1 revised\n- [ ] Step 2\n";
    expect(sha256(normalizeCheckboxes(unchecked))).toBe(sha256(normalizeCheckboxes(checked)));
    expect(sha256(normalizeCheckboxes(unchecked))).not.toBe(sha256(normalizeCheckboxes(edited)));
  });

  test("parseTranscriptTurn prefers transcript_full.jsonl, unwraps args, and tracks turn state", () => {
    const logsDir = join(tempDir, "transcript-test", ".system_generated", "logs");
    const artifactDir = join(tempDir, "transcript-test");
    mkdirSync(logsDir, { recursive: true });
    const shortPath = join(logsDir, "transcript.jsonl");
    const fullPath = join(logsDir, "transcript_full.jsonl");

    // Truncated transcript.jsonl lacks full plan content & exit_plan_mode details
    writeFileSync(
      shortPath,
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\n/plan old\n</USER_REQUEST>" }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "Truncated..." }),
      ].join("\n") + "\n",
      "utf8"
    );

    const blockedPlanPath = join(artifactDir, "implementation_plan.md");
    const blockedPlanBody = "# Implementation Plan\n\n## Goal\nAdd feature cleanly.\n\n1. Edit file A\n2. Run tests\n";
    writeFileSync(
      fullPath,
      [
        // Turn 1: executed & wrote code (should be ignored once turn 2 starts)
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\n/plan first\n</USER_REQUEST>" }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: "exit_plan_mode", args: { plan: JSON.stringify("# First") } }],
        }),
        JSON.stringify({ step_index: 2, type: "GENERIC", status: "DONE", content: "Plan mode is off." }),
        JSON.stringify({
          step_index: 3,
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: "write_file", args: { Path: JSON.stringify("/repo/src/app.ts") } }],
        }),
        JSON.stringify({ step_index: 4, type: "GENERIC", status: "DONE", content: "Created file." }),

        // Turn 2: denied plan file write + inline markdown plan (no exit_plan_mode yet)
        JSON.stringify({ step_index: 5, type: "USER_INPUT", content: "<USER_REQUEST>\n/plan second\n</USER_REQUEST>" }),
        JSON.stringify({
          step_index: 6,
          type: "PLANNER_RESPONSE",
          content: "Writing plan artifact.",
          tool_calls: [
            {
              name: "write_file",
              args: {
                Path: JSON.stringify(blockedPlanPath),
                Content: JSON.stringify(blockedPlanBody),
                ArtifactMetadata: JSON.stringify({ RequestFeedback: true }),
              },
            },
          ],
        }),
        JSON.stringify({
          step_index: 7,
          type: "GENERIC",
          status: "ERROR",
          error: "tool call denied by pre-tool hook: Plan mode is on",
        }),
        JSON.stringify({
          step_index: 8,
          type: "PLANNER_RESPONSE",
          content: "# Plan: Second Task\n\n## Changes\n- Update module B with clean validation.\n- Verify unit tests pass.\n",
          tool_calls: [],
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const turn2 = parseTranscriptTurn(shortPath, artifactDir);
    expect(turn2.userStepIdx).toBe(5);
    expect(turn2.hadExitPlanCompleted).toBe(false);
    expect(turn2.hadNonPlanCodeWrite).toBe(false);
    expect(turn2.attemptedBlockedPlanWrite).toEqual({
      path: blockedPlanPath,
      content: blockedPlanBody,
    });
    expect(turn2.lastAssistantText).toContain("# Plan: Second Task");

    // Append exit_plan_mode completion + non-plan code write to Turn 2
    writeFileSync(
      fullPath,
      readFileSync(fullPath, "utf8") +
        [
          JSON.stringify({
            step_index: 9,
            type: "PLANNER_RESPONSE",
            tool_calls: [{ name: "exit_plan_mode", args: { plan: JSON.stringify("# Plan: Second Task") } }],
          }),
          JSON.stringify({ step_index: 10, type: "GENERIC", status: "DONE", content: "Plan mode is off." }),
          JSON.stringify({
            step_index: 11,
            type: "SYSTEM_MESSAGE",
            content: "Plan mode is off: this turn runs on the execution model.",
          }),
          JSON.stringify({
            step_index: 12,
            type: "PLANNER_RESPONSE",
            tool_calls: [
              {
                name: "edit_file",
                args: { Path: JSON.stringify("/repo/src/moduleB.ts"), Target: JSON.stringify("a"), Replacement: JSON.stringify("b") },
              },
            ],
          }),
          JSON.stringify({ step_index: 13, type: "GENERIC", status: "DONE", content: "Edited file." }),
        ].join("\n") +
        "\n",
      "utf8"
    );

    const turn2After = parseTranscriptTurn(shortPath, artifactDir);
    expect(turn2After.hadExitPlanCompleted).toBe(true);
    expect(turn2After.hadNonPlanCodeWrite).toBe(true);
  });

  test("shouldGateExitPlan and buildAgyExitPlanOutput handle /plan, quick turns, approvals, and notes", () => {
    const plan = "# Plan\n1. Step one";
    const planHash = sha256(plan);
    const turn = {
      userStepIdx: 10,
      hadExitPlanCompleted: false,
      hadNonPlanCodeWrite: false,
      attemptedBlockedPlanWrite: null,
      lastAssistantText: "",
    };

    expect(
      shouldGateExitPlan(
        { lastUserInput: "/plan test", toolCall: { name: "exit_plan_mode", args: { plan } } },
        null,
        turn
      )
    ).toEqual({ gate: true, planContent: plan, planHash });

    expect(
      shouldGateExitPlan(
        { lastUserInput: "pode commitar", toolCall: { name: "exit_plan_mode", args: { plan } } },
        null,
        turn
      ).gate
    ).toBe(false);

    expect(
      shouldGateExitPlan(
        { lastUserInput: "/plan test", toolCall: { name: "exit_plan_mode", args: { plan } } },
        {
          conversationId: "c1",
          path: "agy-plan.md",
          sha256: planHash,
          approvedTurnUserStep: 10,
          approvedForExecution: true,
          updatedAt: new Date().toISOString(),
        },
        turn
      ).gate
    ).toBe(false);

    expect(
      shouldGateExitPlan(
        { lastUserInput: "/plan test", toolCall: { name: "exit_plan_mode", args: { plan } } },
        {
          conversationId: "c1",
          path: "agy-plan.md",
          sha256: planHash,
          approvedHash: planHash,
          approvedTurnUserStep: 2,
          approvedForExecution: false,
          updatedAt: new Date().toISOString(),
        },
        turn
      ).gate
    ).toBe(false);

    expect(buildAgyExitPlanOutput(plan, true, "# Revu: Approved", false)).toEqual({ decision: "allow" });
    const allowWithNotes = buildAgyExitPlanOutput(plan, true, "## Non-blocking Notes\n- Keep clean", true) as any;
    expect(allowWithNotes.decision).toBe("allow");
    expect(allowWithNotes.overwrite.plan).toContain(plan);
    expect(allowWithNotes.overwrite.plan).toContain("Keep clean");

    const deny = buildAgyExitPlanOutput(plan, false, "Fix step 1", false) as any;
    expect(deny.decision).toBe("deny");
    expect(deny.reason).toContain("Fix step 1");
    expect(deny.reason).toContain("exit_plan_mode");
  });

  test("processAgyMark ignores errors, post-execution writes, and checkbox-only updates", () => {
    const planFile = join(tempDir, "docs", "tasks", "plan-demo.md");
    mkdirSync(join(tempDir, "docs", "tasks"), { recursive: true });
    const v1 = "# Plan: Demo\n- [ ] Step 1\n- [ ] Step 2\n";
    writeFileSync(planFile, v1, "utf8");

    // 1. Error write is ignored
    processAgyMark({
      conversationId: "conv-mark-err",
      error: "tool call denied by pre-tool hook",
      toolCall: { name: "write_file", args: { Path: planFile } },
    });
    expect(loadPendingAgyPlan("conv-mark-err")).toBeNull();

    // 2. Write during already-approved turn keeps approvedForExecution & lastReviewedHash synced
    const logsDir = join(tempDir, "mark-exec", ".system_generated", "logs");
    mkdirSync(logsDir, { recursive: true });
    const tPath = join(logsDir, "transcript.jsonl");
    writeFileSync(
      tPath,
      [
        JSON.stringify({ step_index: 4, type: "USER_INPUT", content: "<USER_REQUEST>\n/plan go\n</USER_REQUEST>" }),
        JSON.stringify({ step_index: 5, type: "SYSTEM_MESSAGE", content: "Plan mode is off." }),
      ].join("\n") + "\n",
      "utf8"
    );
    savePendingAgyPlan({
      conversationId: "conv-mark-exec",
      path: "agy-plan.md",
      sha256: "abc",
      approvedTurnUserStep: 4,
      approvedForExecution: true,
      updatedAt: new Date().toISOString(),
    });
    processAgyMark({
      conversationId: "conv-mark-exec",
      transcriptPath: tPath,
      toolCall: { name: "write_file", args: { Path: planFile } },
    });
    const mExec = loadPendingAgyPlan("conv-mark-exec");
    expect(mExec?.path).toBe(planFile);
    expect(mExec?.lastReviewedHash).toBe(sha256(v1));
    expect(mExec?.approvedForExecution).toBe(true);

    // 3. Subsequent turn checking off `- [x]` updates hashes silently without clearing lastReviewedHash
    const v2 = "# Plan: Demo\n- [x] Step 1\n- [ ] Step 2\n";
    writeFileSync(planFile, v2, "utf8");
    writeFileSync(
      tPath,
      JSON.stringify({ step_index: 20, type: "USER_INPUT", content: "<USER_REQUEST>\ncontinue\n</USER_REQUEST>" }) + "\n",
      "utf8"
    );
    processAgyMark({
      conversationId: "conv-mark-exec",
      transcriptPath: tPath,
      toolCall: { name: "edit_file", args: { Path: planFile } },
    });
    const mChecked = loadPendingAgyPlan("conv-mark-exec");
    expect(mChecked?.lastReviewedHash).toBe(sha256(v2));
    expect(mChecked?.approvedHash).toBe(sha256(v2));
  });

  test("builds correct Stop outputs for approve and request_changes", () => {
    const approveDisk = buildAgyStopOutput("approve", "");
    expect(approveDisk.decision).toBe("continue");
    expect(approveDisk.reason).toContain("Proceed");

    const approveInlineWithNotes = buildAgyStopOutput("approve", "## Non-blocking Notes\n- Note A", {
      inlineOrchestratorPlan: true,
      hasNonBlockingNotes: true,
    });
    expect(approveInlineWithNotes.decision).toBe("continue");
    expect(approveInlineWithNotes.reason).toContain("exit_plan_mode");
    expect(approveInlineWithNotes.reason).toContain("Note A");

    const changes = buildAgyStopOutput("request_changes", "# Feedback");
    expect(changes.decision).toBe("continue");
    expect(changes.reason).toContain("# Feedback");
    const changesInline = buildAgyStopOutput("request_changes", "# Feedback", {
      inlineOrchestratorPlan: true,
    });
    expect(changesInline.reason).toContain("exit_plan_mode");
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
    expect(agyHooks["revu-plan-gate"].PreToolUse[0].matcher).toBe("exit_plan_mode");
    expect(agyHooks["revu-plan-gate"].PreToolUse[0].hooks[0].command).toContain("revu hook agy-exit-plan");
    expect(agyHooks["revu-plan-gate"].Stop[0].command).toContain("revu hook agy-stop");

    const agyMcp = JSON.parse(readFileSync(agyMcpPath, "utf8"));
    expect(agyMcp.mcpServers["canva-dev"]).toBeDefined();
    expect(agyMcp.mcpServers.revu.args).toEqual(["mcp"]);
  });
});
