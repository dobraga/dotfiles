import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { runReviewSession } from "../runner.ts";
import {
  loadPendingAgyPlan,
  savePendingAgyPlan,
  sha256,
} from "../session.ts";

export interface AgyPostToolUseEvent {
  conversationId?: string;
  cwd?: string;
  artifactDirectoryPath?: string;
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
  terminationReason?: string;
  continuationActive?: boolean;
  fullyIdle?: boolean;
}

const MAX_AUTO_ROUNDS = 8;

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

export function processAgyMark(event: AgyPostToolUseEvent): Record<string, unknown> {
  if (process.env.REVU_PLAN_HOOK === "0" || process.env.REVU_PLAN_HOOK === "false") {
    return {};
  }

  const conversationId = event.conversationId;
  if (!conversationId) return {};

  const planPath = isPlanFileCandidate(event);
  if (!planPath || !existsSync(planPath)) return {};

  try {
    const st = statSync(planPath);
    if (!st.isFile() || st.size > 5 * 1024 * 1024) return {};
    const content = readFileSync(planPath, "utf8");
    const hash = sha256(content);
    const prev = loadPendingAgyPlan(conversationId);
    savePendingAgyPlan({
      conversationId,
      path: planPath,
      sha256: hash,
      lastReviewedHash: prev?.path === planPath ? prev.lastReviewedHash : undefined,
      autoRounds: prev?.path === planPath ? prev.autoRounds ?? 0 : 0,
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
  action: "approve" | "approve_and_proceed" | "request_changes",
  formattedFeedback: string
): { decision: string; reason?: string } {
  if (action === "approve") {
    return { decision: "" };
  }
  if (action === "approve_and_proceed") {
    return {
      decision: "continue",
      reason:
        "The user approved the plan in Revu and clicked 'Approve & Proceed'. Proceed with implementing the approved plan.",
    };
  }
  return {
    decision: "continue",
    reason: `The user reviewed your plan in Revu and requested changes. Address every annotation below and update the plan file:\n\n${formattedFeedback}`,
  };
}

export async function runAgyStopHook(rawStdin?: string): Promise<void> {
  if (process.env.REVU_PLAN_HOOK === "0" || process.env.REVU_PLAN_HOOK === "false") {
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
  if (!marker || !existsSync(marker.path)) {
    process.stdout.write(JSON.stringify({ decision: "" }) + "\n");
    return;
  }

  const content = readFileSync(marker.path, "utf8");
  const currentHash = sha256(content);
  const autoRounds = marker.autoRounds ?? 0;

  if (currentHash === marker.lastReviewedHash || autoRounds >= MAX_AUTO_ROUNDS) {
    process.stdout.write(JSON.stringify({ decision: "" }) + "\n");
    return;
  }

  const result = await runReviewSession({
    cwd: event.cwd ?? process.cwd(),
    sessionId: `agy-${event.conversationId}`,
    targets: [marker.path],
    title: `AGY Plan — ${basename(marker.path)}`,
    allowProceedAction: true,
    quiet: true,
  });

  savePendingAgyPlan({
    ...marker,
    sha256: currentHash,
    lastReviewedHash: currentHash,
    autoRounds: result.decision.approved ? 0 : autoRounds + 1,
    updatedAt: new Date().toISOString(),
  });

  const out = buildAgyStopOutput(result.decision.action, result.formattedFeedback);
  process.stdout.write(JSON.stringify(out) + "\n");
}
