export type ReviewMode = "markdown" | "diff" | "html" | "live";

export type CommentKind = "comment" | "replace" | "delete" | "pin";

export type DiffSide = "old" | "new" | "file";

export interface CommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  file: string;
  kind: CommentKind;
  lineStart?: number;
  lineEnd?: number;
  side?: DiffSide;
  quote?: string;
  anchor?: string;
  drifted?: boolean;
  selector?: string;
  route?: string;
  textExcerpt?: string;
  x?: number;
  y?: number;
  body: string;
  suggestion?: string;
  author: string;
  resolved: boolean;
  round: number;
  createdAt: string;
  replies: CommentReply[];
}

export interface DiffLine {
  type: "context" | "add" | "del";
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "M" | "A" | "D" | "R" | "?";
  additions: number;
  deletions: number;
  isBinary: boolean;
  hunks: DiffHunk[];
  content?: string;
}

export interface ReviewDocument {
  path: string;
  displayPath: string;
  content: string;
  previousContent?: string;
  roundDiff?: DiffFile;
  isMarkdown: boolean;
}

export type DecisionAction = "approve" | "approve_and_proceed" | "request_changes";

export interface ReviewDecision {
  approved: boolean;
  action: DecisionAction;
  generalNote: string;
  round: number;
  decidedAt: string;
}

export interface SessionMeta {
  id: string;
  key: string;
  mode: ReviewMode;
  cwd: string;
  repoRoot?: string;
  title: string;
  target: string;
  files: string[];
  range?: string;
  staged?: boolean;
  liveUrl?: string;
  round: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  port?: number;
  pid?: number;
  allowProceedAction?: boolean;
  lastDecision?: ReviewDecision;
}

export interface ReviewStatePayload {
  session: SessionMeta;
  documents: ReviewDocument[];
  diffFiles: DiffFile[];
  roundDiffFiles: DiffFile[];
  comments: ReviewComment[];
  generalNote: string;
}
