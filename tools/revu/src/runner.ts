import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import {
  computeRoundDiffFiles,
  computeTextDiff,
  findRepoRoot,
  getGitBranch,
  loadGitDiff,
  readFilesForSnapshot,
  toDisplayPath,
} from "./diff.ts";
import { formatDecisionFeedback } from "./format.ts";
import { openBrowser, startReviewServer } from "./server.ts";
import {
  loadComments,
  loadGeneralNote,
  upsertSession,
} from "./session.ts";
import type {
  DiffFile,
  ReviewComment,
  ReviewDecision,
  ReviewDocument,
  ReviewMode,
  ReviewStatePayload,
  SessionMeta,
} from "./types.ts";

export interface RunReviewOptions {
  cwd?: string;
  targets?: string[];
  inlinePlan?: { title: string; path: string; content: string };
  staged?: boolean;
  range?: string;
  sessionId?: string;
  title?: string;
  host?: string;
  port?: number;
  noOpen?: boolean;
  liveCookie?: string;
  allowProceedAction?: boolean;
  quiet?: boolean;
}

export interface RunReviewResult {
  session: SessionMeta;
  comments: ReviewComment[];
  decision: ReviewDecision;
  formattedFeedback: string;
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function isMarkdownPath(p: string): boolean {
  const ext = extname(p).toLowerCase();
  return ext === ".md" || ext === ".markdown" || ext === ".mdx" || ext === ".txt";
}

function isHtmlPath(p: string): boolean {
  const ext = extname(p).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

export function resolveModeAndTitle(opts: RunReviewOptions): {
  mode: ReviewMode;
  target: string;
  title: string;
  resolvedFiles: string[];
  liveUrl?: string;
  staticHtmlFile?: string;
} {
  const cwd = opts.cwd ?? process.cwd();
  const targets = (opts.targets ?? []).filter(Boolean);

  if (opts.inlinePlan) {
    return {
      mode: "markdown",
      target: opts.inlinePlan.path,
      title: opts.title ?? opts.inlinePlan.title,
      resolvedFiles: [opts.inlinePlan.path],
    };
  }

  if (targets.length === 1 && isUrl(targets[0]!)) {
    return {
      mode: "live",
      target: targets[0]!,
      title: opts.title ?? targets[0]!,
      resolvedFiles: [],
      liveUrl: targets[0]!,
    };
  }

  if (targets.length === 1 && !opts.range && !opts.staged) {
    const abs = resolve(cwd, targets[0]!);
    if (existsSync(abs) && statSync(abs).isFile() && isHtmlPath(abs)) {
      return {
        mode: "html",
        target: toDisplayPath(cwd, abs),
        title: opts.title ?? basename(abs),
        resolvedFiles: [abs],
        staticHtmlFile: abs,
      };
    }
  }

  if (targets.length > 0 && !opts.range && !opts.staged) {
    const absFiles = targets.map((t) => resolve(cwd, t));
    const allExistingFiles = absFiles.every((p) => existsSync(p) && statSync(p).isFile());
    if (allExistingFiles) {
      const displayList = absFiles.map((p) => toDisplayPath(cwd, p));
      return {
        mode: "markdown",
        target: displayList.join(","),
        title: opts.title ?? (displayList.length === 1 ? displayList[0]! : `${displayList.length} files`),
        resolvedFiles: absFiles,
      };
    }
  }

  const branch = getGitBranch(cwd);
  const label = opts.range
    ? `git ${opts.range}`
    : opts.staged
    ? `git staged (${branch ?? "HEAD"})`
    : `git diff (${branch ?? "working tree"})`;
  return {
    mode: "diff",
    target: opts.range ?? (opts.staged ? "staged" : `branch:${branch ?? "HEAD"}`),
    title: opts.title ?? label,
    resolvedFiles: targets,
  };
}

export function buildReviewState(opts: RunReviewOptions): {
  state: ReviewStatePayload;
  watchPaths: string[];
  staticHtmlFile?: string;
  liveUrl?: string;
} {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = findRepoRoot(cwd);
  const resolved = resolveModeAndTitle(opts);

  let documents: ReviewDocument[] = [];
  let diffFiles: DiffFile[] = [];
  let snapshotFiles: Record<string, string> = {};
  const watchPaths: string[] = [];

  if (resolved.mode === "markdown") {
    if (opts.inlinePlan) {
      const display = opts.inlinePlan.path;
      snapshotFiles[display] = opts.inlinePlan.content;
      documents.push({
        path: opts.inlinePlan.path,
        displayPath: display,
        content: opts.inlinePlan.content,
        isMarkdown: true,
      });
      if (existsSync(opts.inlinePlan.path)) watchPaths.push(opts.inlinePlan.path);
    } else {
      for (const abs of resolved.resolvedFiles) {
        const display = toDisplayPath(cwd, abs);
        const content = readFileSync(abs, "utf8");
        snapshotFiles[display] = content;
        documents.push({
          path: abs,
          displayPath: display,
          content,
          isMarkdown: isMarkdownPath(abs),
        });
        watchPaths.push(abs);
      }
    }
  } else if (resolved.mode === "diff") {
    diffFiles = loadGitDiff({
      cwd,
      staged: opts.staged,
      range: opts.range,
      paths: resolved.resolvedFiles.length > 0 ? resolved.resolvedFiles : undefined,
    });
    const root = repoRoot ?? cwd;
    snapshotFiles = readFilesForSnapshot(
      root,
      diffFiles.map((f) => f.path)
    );
  } else if (resolved.mode === "html" && resolved.staticHtmlFile) {
    const content = readFileSync(resolved.staticHtmlFile, "utf8");
    snapshotFiles[resolved.target] = content;
    watchPaths.push(resolved.staticHtmlFile);
  }

  const { meta, previousSnapshot } = upsertSession({
    explicitSessionId: opts.sessionId,
    mode: resolved.mode,
    cwd,
    repoRoot,
    title: resolved.title,
    target: resolved.target,
    files:
      resolved.mode === "diff"
        ? diffFiles.map((f) => f.path)
        : Object.keys(snapshotFiles),
    range: opts.range,
    staged: opts.staged,
    liveUrl: resolved.liveUrl,
    snapshotFiles,
    allowProceedAction: opts.allowProceedAction,
  });

  // Attach per-document round diff for Markdown mode
  let roundDiffFiles: DiffFile[] = [];
  if (previousSnapshot) {
    roundDiffFiles = computeRoundDiffFiles(previousSnapshot, snapshotFiles);
    for (const doc of documents) {
      const prev = previousSnapshot[doc.displayPath];
      if (prev !== undefined && prev !== doc.content) {
        doc.previousContent = prev;
        doc.roundDiff = computeTextDiff(doc.displayPath, prev, doc.content);
      }
    }
  }

  const state: ReviewStatePayload = {
    session: meta,
    documents,
    diffFiles,
    roundDiffFiles,
    comments: loadComments(meta.id),
    generalNote: loadGeneralNote(meta.id),
  };

  return {
    state,
    watchPaths,
    staticHtmlFile: resolved.staticHtmlFile,
    liveUrl: resolved.liveUrl,
  };
}

export async function runReviewSession(opts: RunReviewOptions): Promise<RunReviewResult> {
  let built = buildReviewState(opts);

  const handle = startReviewServer({
    host: opts.host,
    port: opts.port,
    getState: () => ({
      ...built.state,
      comments: loadComments(built.state.session.id),
      generalNote: loadGeneralNote(built.state.session.id),
    }),
    onRefresh: () => {
      built = buildReviewState({
        ...opts,
        sessionId: built.state.session.id,
      });
      return built.state;
    },
    watchPaths: built.watchPaths,
    staticHtmlFile: built.staticHtmlFile,
    liveUrl: built.liveUrl,
    liveCookie: opts.liveCookie,
  });

  if (!opts.quiet) {
    console.error(
      `Revu open at ${handle.url} (session ${built.state.session.id}, round ${built.state.session.round})`
    );
  }
  openBrowser(handle.url, opts.noOpen);

  try {
    const decision = await handle.waitForDecision();
    const comments = loadComments(built.state.session.id);
    const formattedFeedback = formatDecisionFeedback(built.state.session, comments, decision);
    return {
      session: built.state.session,
      comments,
      decision,
      formattedFeedback,
    };
  } finally {
    handle.stop();
  }
}
