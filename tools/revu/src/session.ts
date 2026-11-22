import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CommentKind,
  CommentReply,
  DiffSide,
  ReviewComment,
  ReviewDecision,
  ReviewMode,
  SessionMeta,
} from "./types.ts";

export function getDataDir(): string {
  const envDir = process.env.REVU_DATA_DIR?.trim();
  if (envDir) return envDir;
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "revu");
  return join(homedir(), ".local", "share", "revu");
}

export function getSessionsDir(): string {
  const dir = join(getDataDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getPendingAgyDir(): string {
  const dir = join(getDataDir(), "pending-agy");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function deriveSessionKey(parts: string[]): string {
  return sha256(parts.join("|")).slice(0, 12);
}

export function getSessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(getSessionsDir(), safe);
}

export function loadSessionMeta(sessionId: string): SessionMeta | null {
  const file = join(getSessionDir(sessionId), "session.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

export function saveSessionMeta(meta: SessionMeta): void {
  const dir = getSessionDir(meta.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

export function loadComments(sessionId: string): ReviewComment[] {
  const file = join(getSessionDir(sessionId), "comments.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as ReviewComment[]) : [];
  } catch {
    return [];
  }
}

export function saveComments(sessionId: string, comments: ReviewComment[]): void {
  const dir = getSessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "comments.json"), JSON.stringify(comments, null, 2) + "\n", "utf8");
}

export function loadGeneralNote(sessionId: string): string {
  const file = join(getSessionDir(sessionId), "note.txt");
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function saveGeneralNote(sessionId: string, note: string): void {
  const dir = getSessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "note.txt"), note, "utf8");
}

export function saveRoundSnapshot(
  sessionId: string,
  round: number,
  files: Record<string, string>
): void {
  const dir = join(getSessionDir(sessionId), "snapshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `round-${round}.json`),
    JSON.stringify(files, null, 2),
    "utf8"
  );
}

export function loadRoundSnapshot(
  sessionId: string,
  round: number
): Record<string, string> | null {
  if (round < 1) return null;
  const file = join(getSessionDir(sessionId), "snapshots", `round-${round}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return null;
  }
}

export interface UpsertSessionInput {
  explicitSessionId?: string;
  mode: ReviewMode;
  cwd: string;
  repoRoot?: string;
  title: string;
  target: string;
  files: string[];
  range?: string;
  staged?: boolean;
  liveUrl?: string;
  snapshotFiles: Record<string, string>;
  allowProceedAction?: boolean;
}

export function hashSnapshot(snapshotFiles: Record<string, string>, extra = ""): string {
  const keys = Object.keys(snapshotFiles).sort();
  const h = createHash("sha256");
  h.update(extra);
  for (const k of keys) {
    h.update("\0" + k + "\0" + (snapshotFiles[k] ?? ""));
  }
  return h.digest("hex");
}

export function upsertSession(input: UpsertSessionInput): {
  meta: SessionMeta;
  previousSnapshot: Record<string, string> | null;
  roundBumped: boolean;
} {
  const key =
    input.explicitSessionId ??
    deriveSessionKey([
      input.repoRoot ?? input.cwd,
      input.mode,
      input.target,
      input.range ?? "",
      input.staged ? "staged" : "",
    ]);

  const now = new Date().toISOString();
  const contentHash = hashSnapshot(
    input.snapshotFiles,
    `${input.mode}|${input.target}|${input.liveUrl ?? ""}`
  );
  const existing = loadSessionMeta(key);

  if (!existing) {
    const meta: SessionMeta = {
      id: key,
      key,
      mode: input.mode,
      cwd: input.cwd,
      repoRoot: input.repoRoot,
      title: input.title,
      target: input.target,
      files: input.files,
      range: input.range,
      staged: input.staged,
      liveUrl: input.liveUrl,
      round: 1,
      contentHash,
      createdAt: now,
      updatedAt: now,
      allowProceedAction: input.allowProceedAction,
    };
    saveSessionMeta(meta);
    saveRoundSnapshot(meta.id, 1, input.snapshotFiles);
    return { meta, previousSnapshot: null, roundBumped: false };
  }

  let roundBumped = false;
  let round = existing.round;
  if (existing.contentHash !== contentHash && Object.keys(input.snapshotFiles).length > 0) {
    round = existing.round + 1;
    roundBumped = true;
    saveRoundSnapshot(existing.id, round, input.snapshotFiles);
  }

  const meta: SessionMeta = {
    ...existing,
    mode: input.mode,
    cwd: input.cwd,
    repoRoot: input.repoRoot,
    title: input.title,
    target: input.target,
    files: input.files,
    range: input.range,
    staged: input.staged,
    liveUrl: input.liveUrl,
    round,
    contentHash,
    updatedAt: now,
    allowProceedAction: input.allowProceedAction ?? existing.allowProceedAction,
  };
  saveSessionMeta(meta);

  const previousSnapshot = round > 1 ? loadRoundSnapshot(meta.id, round - 1) : null;

  // Re-anchor comments if files changed in a new round
  if (roundBumped) {
    const comments = loadComments(meta.id);
    if (comments.length > 0) {
      const updated = reanchorComments(comments, input.snapshotFiles);
      saveComments(meta.id, updated);
    }
  }

  return { meta, previousSnapshot, roundBumped };
}

export function reanchorComments(
  comments: ReviewComment[],
  currentFiles: Record<string, string>
): ReviewComment[] {
  return comments.map((c) => {
    if (c.kind === "pin" || !c.file) return c;
    const content = currentFiles[c.file];
    if (content === undefined) return { ...c, drifted: true };
    if (!c.quote && !c.anchor) return c;

    const lines = content.split(/\r?\n/);
    const needle = (c.quote || c.anchor || "").trim();
    if (!needle) return c;

    // Check if still at recorded line range
    if (c.lineStart && c.lineStart >= 1 && c.lineStart <= lines.length) {
      const end = Math.min(lines.length, c.lineEnd ?? c.lineStart);
      const currentSlice = lines.slice(c.lineStart - 1, end).join("\n");
      if (currentSlice.includes(needle)) {
        return { ...c, drifted: false };
      }
    }

    // Search for needle elsewhere in file
    const firstNeedleLine = needle.split(/\r?\n/)[0]!.trim();
    if (firstNeedleLine) {
      const foundIdx = lines.findIndex((l) => l.includes(firstNeedleLine));
      if (foundIdx !== -1) {
        const span = Math.max(1, (c.lineEnd ?? c.lineStart ?? 1) - (c.lineStart ?? 1) + 1);
        return {
          ...c,
          lineStart: foundIdx + 1,
          lineEnd: Math.min(lines.length, foundIdx + span),
          drifted: false,
        };
      }
    }

    return { ...c, drifted: true };
  });
}

export interface AddCommentInput {
  file: string;
  kind?: CommentKind;
  lineStart?: number;
  lineEnd?: number;
  side?: DiffSide;
  quote?: string;
  anchor?: string;
  selector?: string;
  route?: string;
  textExcerpt?: string;
  x?: number;
  y?: number;
  body: string;
  suggestion?: string;
  author?: string;
}

export function addComment(sessionId: string, input: AddCommentInput): ReviewComment {
  const comments = loadComments(sessionId);
  const meta = loadSessionMeta(sessionId);
  const nextNum = comments.length + 1;
  const id = `c${nextNum}-${randomBytes(2).toString("hex")}`;
  const comment: ReviewComment = {
    id,
    file: input.file,
    kind: input.kind ?? (input.selector ? "pin" : "comment"),
    lineStart: input.lineStart,
    lineEnd: input.lineEnd ?? input.lineStart,
    side: input.side,
    quote: input.quote,
    anchor: input.anchor,
    selector: input.selector,
    route: input.route,
    textExcerpt: input.textExcerpt,
    x: input.x,
    y: input.y,
    body: input.body,
    suggestion: input.suggestion,
    author: input.author ?? "Reviewer",
    resolved: false,
    round: meta?.round ?? 1,
    createdAt: new Date().toISOString(),
    replies: [],
  };
  comments.push(comment);
  saveComments(sessionId, comments);
  return comment;
}

export function addReply(
  sessionId: string,
  commentId: string,
  body: string,
  author = "Agent"
): CommentReply | null {
  const comments = loadComments(sessionId);
  const target = comments.find((c) => c.id === commentId || c.id.startsWith(commentId));
  if (!target) return null;
  const reply: CommentReply = {
    id: `r${target.replies.length + 1}-${randomBytes(2).toString("hex")}`,
    author,
    body,
    createdAt: new Date().toISOString(),
  };
  target.replies.push(reply);
  saveComments(sessionId, comments);
  return reply;
}

export function updateComment(
  sessionId: string,
  commentId: string,
  patch: Partial<Pick<ReviewComment, "body" | "suggestion" | "resolved" | "kind">>
): ReviewComment | null {
  const comments = loadComments(sessionId);
  const target = comments.find((c) => c.id === commentId);
  if (!target) return null;
  if (patch.body !== undefined) target.body = patch.body;
  if (patch.suggestion !== undefined) target.suggestion = patch.suggestion;
  if (patch.resolved !== undefined) target.resolved = patch.resolved;
  if (patch.kind !== undefined) target.kind = patch.kind;
  saveComments(sessionId, comments);
  return target;
}

export function deleteComment(sessionId: string, commentId: string): boolean {
  const comments = loadComments(sessionId);
  const next = comments.filter((c) => c.id !== commentId);
  if (next.length === comments.length) return false;
  saveComments(sessionId, next);
  return true;
}

export function recordDecision(sessionId: string, decision: ReviewDecision): SessionMeta | null {
  const meta = loadSessionMeta(sessionId);
  if (!meta) return null;
  meta.lastDecision = decision;
  meta.updatedAt = decision.decidedAt;
  saveSessionMeta(meta);
  return meta;
}

export function listSessions(): SessionMeta[] {
  const dir = getSessionsDir();
  if (!existsSync(dir)) return [];
  const metas: SessionMeta[] = [];
  for (const entry of readdirSync(dir)) {
    const meta = loadSessionMeta(entry);
    if (meta) metas.push(meta);
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function findLatestSessionForCwd(cwd: string): SessionMeta | null {
  const sessions = listSessions();
  const exact = sessions.find((s) => s.cwd === cwd || s.repoRoot === cwd);
  return exact ?? sessions[0] ?? null;
}

export function cleanOldSessions(maxAgeDays = 14): number {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let removed = 0;
  for (const meta of listSessions()) {
    const ts = Date.parse(meta.updatedAt);
    if (!Number.isNaN(ts) && ts < cutoff) {
      rmSync(getSessionDir(meta.id), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

// Pending AGY plan marker helpers
export interface PendingAgyPlan {
  conversationId: string;
  path: string;
  sha256: string;
  lastReviewedHash?: string;
  autoRounds?: number;
  updatedAt: string;
}

export function getPendingAgyFile(conversationId: string): string {
  const safe = conversationId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(getPendingAgyDir(), `${safe}.json`);
}

export function loadPendingAgyPlan(conversationId: string): PendingAgyPlan | null {
  const file = getPendingAgyFile(conversationId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PendingAgyPlan;
  } catch {
    return null;
  }
}

export function savePendingAgyPlan(marker: PendingAgyPlan): void {
  const file = getPendingAgyFile(marker.conversationId);
  writeFileSync(file, JSON.stringify(marker, null, 2) + "\n", "utf8");
}
