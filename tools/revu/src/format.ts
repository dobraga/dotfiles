import type { ReviewComment, ReviewDecision, SessionMeta } from "./types.ts";

export function formatDecisionFeedback(
  session: SessionMeta,
  comments: ReviewComment[],
  decision: ReviewDecision
): string {
  const unresolved = comments.filter((c) => !c.resolved);

  if (decision.approved) {
    const lines: string[] = [
      `# Revu: Approved (Round ${session.round})`,
      `Session: \`${session.id}\` | Target: ${session.title}`,
    ];
    if (decision.generalNote.trim()) {
      lines.push("", "## Reviewer Note", decision.generalNote.trim());
    }
    if (unresolved.length > 0) {
      lines.push("", "## Non-blocking Notes");
      for (const c of unresolved) {
        lines.push(formatSingleComment(c));
      }
    }
    return lines.join("\n");
  }

  const lines: string[] = [
    `# Revu Feedback (Round ${session.round} — Changes Requested)`,
    `Session: \`${session.id}\` | Target: ${session.title}`,
  ];

  if (decision.generalNote.trim()) {
    lines.push("", "## General Notes", decision.generalNote.trim());
  }

  if (unresolved.length === 0 && !decision.generalNote.trim()) {
    lines.push("", "Reviewer requested changes without specific inline comments.");
  } else if (unresolved.length > 0) {
    // Group by file / live target
    const byFile = new Map<string, ReviewComment[]>();
    for (const c of unresolved) {
      const key = c.file || session.liveUrl || "General";
      const list = byFile.get(key) ?? [];
      list.push(c);
      byFile.set(key, list);
    }

    for (const [file, list] of byFile) {
      const heading = session.mode === "live" && file === session.liveUrl
        ? `## Live App: \`${file}\``
        : `## File: \`${file}\``;
      lines.push("", heading);
      for (const c of list) {
        lines.push(formatSingleComment(c));
      }
    }
  }

  lines.push(
    "",
    `After addressing comments, reply with: \`revu comment --session ${session.id} --reply-to <id> --author "<Agent>" "<what you did>"\``
  );

  return lines.join("\n");
}

function formatSingleComment(c: ReviewComment): string {
  const kindTag = `[${c.kind.toUpperCase()}]`;
  const locParts: string[] = [];

  if (c.selector) {
    locParts.push(`\`${c.selector}\``);
    if (c.route) locParts.push(`route \`${c.route}\``);
    if (c.textExcerpt) locParts.push(`text: \`"${truncate(c.textExcerpt, 60)}"\``);
  } else if (c.lineStart) {
    const range =
      c.lineEnd && c.lineEnd !== c.lineStart
        ? `Lines ${c.lineStart}–${c.lineEnd}`
        : `Line ${c.lineStart}`;
    locParts.push(range);
    if (c.side && c.side !== "new") locParts.push(`(${c.side})`);
  }

  if (c.quote) {
    locParts.push(`quote: \`"${truncate(c.quote.replace(/\s+/g, " "), 80)}"\``);
  }
  if (c.drifted) {
    locParts.push("(drifted — check quote/context)");
  }

  const header = `- **[#${c.id}] ${kindTag}${locParts.length ? " " + locParts.join(" · ") : ""}**:`;
  const parts = [header];

  if (c.body.trim()) {
    const indented = c.body
      .trim()
      .split("\n")
      .map((l) => `  > ${l}`)
      .join("\n");
    parts.push(indented);
  }

  if (c.suggestion !== undefined && c.suggestion !== "") {
    parts.push("  ```suggestion");
    for (const l of c.suggestion.split("\n")) {
      parts.push(`  ${l}`);
    }
    parts.push("  ```");
  }

  if (c.replies.length > 0) {
    for (const r of c.replies) {
      parts.push(`  - *${r.author}*: ${r.body}`);
    }
  }

  return parts.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
