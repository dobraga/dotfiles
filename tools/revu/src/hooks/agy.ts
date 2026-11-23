import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runReviewSession } from "../runner.ts";
import {
  deriveSessionKey,
  loadPendingAgyPlan,
  savePendingAgyPlan,
  sha256,
  type PendingAgyPlan,
} from "../session.ts";
import type { DecisionAction } from "../types.ts";

export const AGY_INLINE_PLAN_PATH = "agy-plan.md";

export interface AgyPreToolUseEvent {
  conversationId?: string;
  cwd?: string;
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  lastUserInput?: string;
  toolCall?: {
    id?: string;
    name?: string;
    args?: {
      plan?: string;
      Path?: string;
      [key: string]: unknown;
    };
  };
}

export interface AgyPostToolUseEvent {
  conversationId?: string;
  cwd?: string;
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  lastUserInput?: string;
  error?: string;
  toolCall?: {
    id?: string;
    name?: string;
    args?: {
      Path?: string;
      ArtifactMetadata?: {
        RequestFeedback?: boolean;
        UserFacing?: boolean;
        Summary?: string;
      };
      [key: string]: unknown;
    };
  };
}

export interface AgyStopEvent {
  conversationId?: string;
  cwd?: string;
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  lastUserInput?: string;
  terminationReason?: string;
  continuationActive?: boolean;
  fullyIdle?: boolean;
}

export interface TranscriptTurnSummary {
  userStepIdx: number;
  hadExitPlanCompleted: boolean;
  hadNonPlanCodeWrite: boolean;
  attemptedBlockedPlanWrite: { path: string; content: string } | null;
  lastAssistantText: string;
}

const MAX_AUTO_ROUNDS = 8;
const MAX_PLAN_BYTES = 5 * 1024 * 1024;

function isHookDisabled(): boolean {
  return process.env.REVU_PLAN_HOOK === "0" || process.env.REVU_PLAN_HOOK === "false";
}

export function isExplicitPlanRequest(lastUserInput?: string): boolean {
  return /^\/plan(?:\s|$)/i.test((lastUserInput ?? "").trimStart());
}

export function normalizeCheckboxes(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").replace(/^(\s*[-*+]\s+\[)[ xX](\])/gm, "$1 $2");
}

export function looksLikeMarkdownPlan(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 120) return false;
  const headings = trimmed.match(/^#{1,3}\s+\S/gm) ?? [];
  if (headings.length < 1) return false;
  return headings.length >= 2 || /^\s*(?:[-*+]|\d+\.)\s+\S/m.test(trimmed);
}

export function extractPlanTitle(markdown: string, fallback = "plan.md"): string {
  const match = markdown.match(/^#{1,3}\s+(.+)$/m);
  if (!match) return fallback;
  const cleaned = match[1]!.replace(/[*_`]/g, "").trim();
  if (!cleaned) return fallback;
  return cleaned.length <= 60 ? cleaned : cleaned.slice(0, 59) + "…";
}

export function resolveFullTranscriptPath(transcriptPath?: string): string | null {
  if (!transcriptPath) return null;
  const fullSibling = join(dirname(transcriptPath), "transcript_full.jsonl");
  if (existsSync(fullSibling)) return fullSibling;
  return existsSync(transcriptPath) ? transcriptPath : null;
}

function unwrapTranscriptArg(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }
  return v;
}

function unwrapTranscriptString(v: unknown): string | undefined {
  const unwrapped = unwrapTranscriptArg(v);
  if (typeof unwrapped === "string") return unwrapped;
  return typeof v === "string" ? v : undefined;
}

function unwrapTranscriptObj(v: unknown): Record<string, unknown> | undefined {
  const unwrapped = unwrapTranscriptArg(v);
  if (unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)) {
    return unwrapped as Record<string, unknown>;
  }
  return undefined;
}

export function parseTranscriptTurn(
  transcriptPath?: string,
  artifactDirectoryPath?: string
): TranscriptTurnSummary {
  const empty: TranscriptTurnSummary = {
    userStepIdx: -1,
    hadExitPlanCompleted: false,
    hadNonPlanCodeWrite: false,
    attemptedBlockedPlanWrite: null,
    lastAssistantText: "",
  };

  const fullPath = resolveFullTranscriptPath(transcriptPath);
  if (!fullPath) return empty;

  let lines: string[];
  try {
    lines = readFileSync(fullPath, "utf8").split(/\r?\n/);
  } catch {
    return empty;
  }

  const entries: Record<string, any>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") entries.push(parsed as Record<string, any>);
    } catch {
      // skip malformed line
    }
  }

  let lastUserArrIdx = -1;
  let userStepIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.type === "USER_INPUT") {
      lastUserArrIdx = i;
      userStepIdx = typeof e.step_index === "number" ? e.step_index : i;
    }
  }

  const summary: TranscriptTurnSummary = { ...empty, userStepIdx };
  let pendingToolCalls: Record<string, any>[] = [];

  for (let i = lastUserArrIdx + 1; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.type === "SYSTEM_MESSAGE") {
      if (typeof e.content === "string" && e.content.includes("Plan mode is off")) {
        summary.hadExitPlanCompleted = true;
      }
      continue;
    }

    if (e.type === "PLANNER_RESPONSE") {
      if (typeof e.content === "string" && e.content.trim()) {
        summary.lastAssistantText = e.content;
      }
      pendingToolCalls = Array.isArray(e.tool_calls) ? [...e.tool_calls] : [];
      continue;
    }

    if (e.type === "GENERIC") {
      const tc = pendingToolCalls.shift();
      if (!tc) continue;
      const tcName = typeof tc.name === "string" ? tc.name : "";
      const isErr = e.status === "ERROR" || Boolean(e.error);

      if (tcName === "exit_plan_mode" && !isErr) {
        summary.hadExitPlanCompleted = true;
        continue;
      }

      if (tcName === "write_file" || tcName === "edit_file") {
        const rawArgs = (tc.args ?? {}) as Record<string, unknown>;
        const path = unwrapTranscriptString(rawArgs.Path);
        const content = unwrapTranscriptString(rawArgs.Content);
        const meta = unwrapTranscriptObj(rawArgs.ArtifactMetadata);
        const candidate = isPlanFileCandidate({
          artifactDirectoryPath,
          toolCall: {
            name: tcName,
            args: {
              ...(path !== undefined ? { Path: path } : {}),
              ...(meta ? { ArtifactMetadata: meta as any } : {}),
            },
          },
        });
        if (candidate) {
          if (isErr && content && content.trim()) {
            summary.attemptedBlockedPlanWrite = { path: candidate, content };
          }
        } else if (!isErr) {
          summary.hadNonPlanCodeWrite = true;
        }
      }
    }
  }

  return summary;
}

export function isPlanFileCandidate(event: AgyPostToolUseEvent): string | null {
  const args = event.toolCall?.args;
  const path = typeof args?.Path === "string" ? args.Path : "";
  if (!path || !/\.md$/i.test(path)) return null;

  if (args?.ArtifactMetadata?.RequestFeedback === true) {
    return path;
  }

  // Match docs/tasks/plan-*.md (AGENTS.md Rule of Three convention)
  if (/(?:^|\/)docs\/tasks\/plan-[^/]+\.md$/i.test(path)) {
    return path;
  }

  // Match implementation_plan.md inside AGY's artifact directory
  if (
    event.artifactDirectoryPath &&
    path.startsWith(event.artifactDirectoryPath) &&
    /plan.*\.md$/i.test(basename(path))
  ) {
    return path;
  }

  return null;
}

export function isPlanApprovedForCurrentTurn(
  marker: PendingAgyPlan | null,
  turnUserStep: number
): boolean {
  return Boolean(
    marker?.approvedForExecution &&
      marker.approvedTurnUserStep !== undefined &&
      turnUserStep !== -1 &&
      marker.approvedTurnUserStep === turnUserStep
  );
}

export function shouldGateExitPlan(
  event: AgyPreToolUseEvent,
  marker: PendingAgyPlan | null,
  turn: TranscriptTurnSummary
): { gate: boolean; planContent: string; planHash: string } {
  const planContent = typeof event.toolCall?.args?.plan === "string" ? event.toolCall.args.plan : "";
  if (!planContent.trim()) {
    return { gate: false, planContent: "", planHash: "" };
  }
  if (!isExplicitPlanRequest(event.lastUserInput)) {
    return { gate: false, planContent, planHash: sha256(planContent) };
  }
  const planHash = sha256(planContent);
  if (isPlanApprovedForCurrentTurn(marker, turn.userStepIdx)) {
    return { gate: false, planContent, planHash };
  }
  if (marker?.approvedHash === planHash) {
    return { gate: false, planContent, planHash };
  }
  if ((marker?.autoRounds ?? 0) >= MAX_AUTO_ROUNDS) {
    return { gate: false, planContent, planHash };
  }
  return { gate: true, planContent, planHash };
}

export function buildAgyExitPlanOutput(
  planContent: string,
  approved: boolean,
  formattedFeedback: string,
  hasNonBlockingNotes: boolean
): Record<string, unknown> {
  if (approved) {
    if (hasNonBlockingNotes && formattedFeedback.trim()) {
      return {
        decision: "allow",
        overwrite: {
          plan: `${planContent}\n\n---\n\n${formattedFeedback}`,
        },
      };
    }
    return { decision: "allow" };
  }

  return {
    decision: "deny",
    reason: `The user reviewed your plan in Revu and requested changes. Revise the plan to address every annotation below and call exit_plan_mode again:\n\n${
      formattedFeedback || "Reviewer requested changes to the plan."
    }`,
  };
}

export async function runAgyExitPlanHook(rawStdin?: string): Promise<void> {
  if (isHookDisabled()) {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }

  const text = rawStdin ?? (await Bun.stdin.text());
  if (!text.trim()) {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }

  let event: AgyPreToolUseEvent;
  try {
    event = JSON.parse(text) as AgyPreToolUseEvent;
  } catch {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }

  if (event.toolCall?.name && event.toolCall.name !== "exit_plan_mode") {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }

  const prev = event.conversationId ? loadPendingAgyPlan(event.conversationId) : null;
  const turn = parseTranscriptTurn(event.transcriptPath, event.artifactDirectoryPath);
  const { gate, planContent, planHash } = shouldGateExitPlan(event, prev, turn);

  if (!gate) {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }

  const cwd = event.cwd ?? process.cwd();
  const sessionId = event.conversationId
    ? `agy-${event.conversationId}`
    : `agy-${deriveSessionKey([cwd, AGY_INLINE_PLAN_PATH])}`;

  const result = await runReviewSession({
    cwd,
    sessionId,
    inlinePlan: {
      title: `AGY Plan — ${extractPlanTitle(planContent, "plan.md")}`,
      path: AGY_INLINE_PLAN_PATH,
      content: planContent,
    },
    quiet: true,
  });

  const hasNonBlockingNotes = Boolean(
    result.decision.generalNote.trim() || result.comments.some((c) => !c.resolved)
  );
  const normHash = sha256(normalizeCheckboxes(planContent));

  if (event.conversationId) {
    const prevRounds = prev?.autoRounds ?? 0;
    savePendingAgyPlan({
      conversationId: event.conversationId,
      path: prev?.path && prev.path !== AGY_INLINE_PLAN_PATH ? prev.path : AGY_INLINE_PLAN_PATH,
      sha256: planHash,
      lastReviewedHash: planHash,
      approvedHash: result.decision.approved ? planHash : prev?.approvedHash,
      approvedNormalizedHash: result.decision.approved ? normHash : prev?.approvedNormalizedHash,
      approvedTurnUserStep:
        result.decision.approved && turn.userStepIdx !== -1
          ? turn.userStepIdx
          : prev?.approvedTurnUserStep,
      approvedForExecution: result.decision.approved,
      autoRounds: result.decision.approved ? 0 : prevRounds + 1,
      updatedAt: new Date().toISOString(),
    });
  }

  const out = buildAgyExitPlanOutput(
    planContent,
    result.decision.approved,
    result.formattedFeedback,
    hasNonBlockingNotes
  );
  process.stdout.write(JSON.stringify(out) + "\n");
}

export function processAgyMark(event: AgyPostToolUseEvent): Record<string, unknown> {
  if (isHookDisabled()) return {};

  const conversationId = event.conversationId;
  if (!conversationId || event.error) return {};

  const planPath = isPlanFileCandidate(event);
  if (!planPath || !existsSync(planPath)) return {};

  try {
    const st = statSync(planPath);
    if (!st.isFile() || st.size > MAX_PLAN_BYTES) return {};
    const content = readFileSync(planPath, "utf8");
    const hash = sha256(content);
    const normHash = sha256(normalizeCheckboxes(content));
    const prev = loadPendingAgyPlan(conversationId);
    const turn = parseTranscriptTurn(event.transcriptPath, event.artifactDirectoryPath);

    if (
      isPlanApprovedForCurrentTurn(prev, turn.userStepIdx) ||
      turn.hadExitPlanCompleted ||
      turn.hadNonPlanCodeWrite
    ) {
      savePendingAgyPlan({
        ...(prev ?? { conversationId, autoRounds: 0 }),
        conversationId,
        path: planPath,
        sha256: hash,
        lastReviewedHash: hash,
        approvedHash: hash,
        approvedNormalizedHash: normHash,
        approvedTurnUserStep:
          turn.userStepIdx !== -1 ? turn.userStepIdx : prev?.approvedTurnUserStep,
        approvedForExecution: true,
        updatedAt: new Date().toISOString(),
      });
      return {};
    }

    if (prev?.path === planPath && prev.approvedNormalizedHash === normHash) {
      savePendingAgyPlan({
        ...prev,
        sha256: hash,
        lastReviewedHash: hash,
        approvedHash: hash,
        updatedAt: new Date().toISOString(),
      });
      return {};
    }

    const samePath = prev?.path === planPath;
    savePendingAgyPlan({
      conversationId,
      path: planPath,
      sha256: hash,
      lastReviewedHash: samePath ? prev.lastReviewedHash : undefined,
      approvedHash: samePath ? prev.approvedHash : undefined,
      approvedNormalizedHash: samePath ? prev.approvedNormalizedHash : undefined,
      approvedTurnUserStep: samePath ? prev.approvedTurnUserStep : undefined,
      approvedForExecution: false,
      autoRounds: samePath ? prev.autoRounds ?? 0 : 0,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // non-fatal
  }

  return {};
}

export async function runAgyMarkHook(rawStdin?: string): Promise<void> {
  const text = rawStdin ?? (await Bun.stdin.text());
  if (!text.trim()) {
    process.stdout.write("{}\n");
    return;
  }
  try {
    const event = JSON.parse(text) as AgyPostToolUseEvent;
    const out = processAgyMark(event);
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {
    process.stdout.write("{}\n");
  }
}

export function buildAgyStopOutput(
  action: DecisionAction,
  formattedFeedback: string,
  opts?: { inlineOrchestratorPlan?: boolean; hasNonBlockingNotes?: boolean }
): { decision: string; reason?: string } {
  if (action === "approve") {
    let reason = opts?.inlineOrchestratorPlan
      ? "The user approved the plan in Revu. Call exit_plan_mode now with the complete approved plan so execution starts immediately."
      : "The user approved the plan in Revu. Proceed with implementing the approved plan.";
    if (opts?.hasNonBlockingNotes && formattedFeedback.trim()) {
      reason += `\n\n${formattedFeedback}`;
    }
    return {
      decision: "continue",
      reason,
    };
  }
  const intro = opts?.inlineOrchestratorPlan
    ? "The user reviewed your plan in Revu and requested changes. Address every annotation below and present the revised plan (or call exit_plan_mode when ready):"
    : "The user reviewed your plan in Revu and requested changes. Address every annotation below and update the plan file:";
  return {
    decision: "continue",
    reason: `${intro}\n\n${formattedFeedback}`,
  };
}

export async function runAgyStopHook(rawStdin?: string): Promise<void> {
  if (isHookDisabled()) {
    process.stdout.write(JSON.stringify({ decision: "" }) + "\n");
    return;
  }

  const text = rawStdin ?? (await Bun.stdin.text());
  if (!text.trim()) {
    process.stdout.write(JSON.stringify({ decision: "" }) + "\n");
    return;
  }

  let event: AgyStopEvent;
  try {
    event = JSON.parse(text) as AgyStopEvent;
  } catch {
    process.stdout.write(JSON.stringify({ decision: "" }) + "\n");
    return;
  }

  if (
    !event.conversationId ||
    (event.terminationReason && event.terminationReason !== "NO_TOOL_CALL")
  ) {
    process.stdout.write(JSON.stringify({ decision: "" }) + "\n");
    return;
  }

  const marker = loadPendingAgyPlan(event.conversationId);
  const turn = parseTranscriptTurn(event.transcriptPath, event.artifactDirectoryPath);

  if (
    turn.hadExitPlanCompleted ||
    turn.hadNonPlanCodeWrite ||
    isPlanApprovedForCurrentTurn(marker, turn.userStepIdx)
  ) {
    process.stdout.write(JSON.stringify({ decision: "" }) + "\n");
    return;
  }

  const cwd = event.cwd ?? process.cwd();
  const autoRounds = marker?.autoRounds ?? 0;

  // Path 1: disk plan file (standalone models writing docs/tasks/plan-*.md or RequestFeedback artifacts)
  if (marker && marker.path !== AGY_INLINE_PLAN_PATH && existsSync(marker.path)) {
    const content = readFileSync(marker.path, "utf8");
    const currentHash = sha256(content);
    const normHash = sha256(normalizeCheckboxes(content));

    if (
      currentHash === marker.lastReviewedHash ||
      currentHash === marker.approvedHash ||
      normHash === marker.approvedNormalizedHash ||
      autoRounds >= MAX_AUTO_ROUNDS
    ) {
      process.stdout.write(JSON.stringify({ decision: "" }) + "\n");
      return;
    }

    const result = await runReviewSession({
      cwd,
      sessionId: `agy-${event.conversationId}`,
      targets: [marker.path],
      title: `AGY Plan — ${basename(marker.path)}`,
      quiet: true,
    });

    const hasNonBlockingNotes = Boolean(
      result.decision.generalNote.trim() || result.comments.some((c) => !c.resolved)
    );
    savePendingAgyPlan({
      ...marker,
      sha256: currentHash,
      lastReviewedHash: currentHash,
      approvedHash: result.decision.approved ? currentHash : marker.approvedHash,
      approvedNormalizedHash: result.decision.approved ? normHash : marker.approvedNormalizedHash,
      approvedTurnUserStep:
        result.decision.approved && turn.userStepIdx !== -1
          ? turn.userStepIdx
          : marker.approvedTurnUserStep,
      approvedForExecution: result.decision.approved,
      autoRounds: result.decision.approved ? 0 : autoRounds + 1,
      updatedAt: new Date().toISOString(),
    });

    const out = buildAgyStopOutput(result.decision.action, result.formattedFeedback, {
      hasNonBlockingNotes,
    });
    process.stdout.write(JSON.stringify(out) + "\n");
    return;
  }

  // Path 2: inline Orchestrator Neon plan presented in chat in /plan mode when write_file was blocked or skipped
  if (isExplicitPlanRequest(event.lastUserInput)) {
    const planText = looksLikeMarkdownPlan(turn.lastAssistantText)
      ? turn.lastAssistantText
      : turn.attemptedBlockedPlanWrite?.content.trim()
      ? turn.attemptedBlockedPlanWrite.content
      : "";

    if (planText) {
      const planHash = sha256(planText);
      const normHash = sha256(normalizeCheckboxes(planText));

      if (
        planHash !== marker?.lastReviewedHash &&
        planHash !== marker?.approvedHash &&
        normHash !== marker?.approvedNormalizedHash &&
        autoRounds < MAX_AUTO_ROUNDS
      ) {
        const result = await runReviewSession({
          cwd,
          sessionId: `agy-${event.conversationId}`,
          inlinePlan: {
            title: `AGY Plan — ${extractPlanTitle(planText, "plan.md")}`,
            path: AGY_INLINE_PLAN_PATH,
            content: planText,
          },
          quiet: true,
        });

        const hasNonBlockingNotes = Boolean(
          result.decision.generalNote.trim() || result.comments.some((c) => !c.resolved)
        );
        savePendingAgyPlan({
          conversationId: event.conversationId,
          path: AGY_INLINE_PLAN_PATH,
          sha256: planHash,
          lastReviewedHash: planHash,
          approvedHash: result.decision.approved ? planHash : marker?.approvedHash,
          approvedNormalizedHash: result.decision.approved ? normHash : marker?.approvedNormalizedHash,
          approvedTurnUserStep:
            result.decision.approved && turn.userStepIdx !== -1
              ? turn.userStepIdx
              : marker?.approvedTurnUserStep,
          approvedForExecution: result.decision.approved,
          autoRounds: result.decision.approved ? 0 : autoRounds + 1,
          updatedAt: new Date().toISOString(),
        });

        const out = buildAgyStopOutput(result.decision.action, result.formattedFeedback, {
          inlineOrchestratorPlan: true,
          hasNonBlockingNotes,
        });
        process.stdout.write(JSON.stringify(out) + "\n");
        return;
      }
    }
  }

  process.stdout.write(JSON.stringify({ decision: "" }) + "\n");
}
