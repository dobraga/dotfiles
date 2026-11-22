import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runReviewSession } from "../runner.ts";
import { deriveSessionKey } from "../session.ts";

export interface ClaudeHookEvent {
  hook_event_name?: string;
  tool_name?: string;
  session_id?: string;
  cwd?: string;
  tool_input?: {
    plan?: string;
    planFilePath?: string;
    [key: string]: unknown;
  };
}

const MAX_PLAN_BYTES = 5 * 1024 * 1024;

export function resolveClaudePlanContent(toolInput?: ClaudeHookEvent["tool_input"]): {
  planContent: string;
  planPath: string;
} {
  const inlinePlan = typeof toolInput?.plan === "string" ? toolInput.plan : "";
  const filePath = typeof toolInput?.planFilePath === "string" ? toolInput.planFilePath : "";

  if (filePath && isAbsolute(filePath) && /\.md$/i.test(filePath) && existsSync(filePath)) {
    try {
      const st = statSync(filePath);
      if (st.isFile() && st.size <= MAX_PLAN_BYTES) {
        const disk = readFileSync(filePath, "utf8");
        if (disk.trim().length > 0) {
          return { planContent: disk, planPath: filePath };
        }
      }
    } catch {
      // fall back to inline plan
    }
  }

  return {
    planContent: inlinePlan,
    planPath: filePath || "claude-plan.md",
  };
}

export function buildClaudeHookOutput(
  event: ClaudeHookEvent,
  planContent: string,
  approved: boolean,
  feedback: string
): Record<string, unknown> {
  if (approved) {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          // Required for Claude Code >= 2.1.199 so ExitPlanMode accepts the hook approval
          updatedInput: {
            ...(event.tool_input ?? {}),
            plan: planContent,
          },
        },
      },
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: feedback || "Reviewer requested changes to the plan. Please revise and call ExitPlanMode again.",
      },
    },
  };
}

export async function runClaudeHook(rawStdin?: string): Promise<void> {
  if (process.env.REVU_PLAN_HOOK === "0" || process.env.REVU_PLAN_HOOK === "false") {
    return;
  }

  const inputText = rawStdin ?? (await Bun.stdin.text());
  if (!inputText.trim()) return;

  let event: ClaudeHookEvent;
  try {
    event = JSON.parse(inputText) as ClaudeHookEvent;
  } catch {
    return;
  }

  if (event.tool_name && event.tool_name !== "ExitPlanMode") {
    return;
  }

  const { planContent, planPath } = resolveClaudePlanContent(event.tool_input);
  if (!planContent.trim()) {
    return;
  }

  const sessionId = event.session_id
    ? `claude-${event.session_id}`
    : `claude-${deriveSessionKey([event.cwd ?? process.cwd(), planPath])}`;

  const result = await runReviewSession({
    cwd: event.cwd ?? process.cwd(),
    sessionId,
    inlinePlan: {
      title: `Claude Plan — ${planPath.split("/").pop() ?? "plan.md"}`,
      path: planPath,
      content: planContent,
    },
    quiet: true,
  });

  const output = buildClaudeHookOutput(
    event,
    planContent,
    result.decision.approved,
    result.formattedFeedback
  );
  process.stdout.write(JSON.stringify(output) + "\n");
}
