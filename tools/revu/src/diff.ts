import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { DiffFile, DiffHunk, DiffLine } from "./types.ts";

export interface GitDiffOptions {
  cwd: string;
  staged?: boolean;
  range?: string;
  paths?: string[];
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
  };
}

export function findRepoRoot(cwd: string): string | undefined {
  const res = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!res.ok) return undefined;
  return res.stdout.trim() || undefined;
}

export function getGitBranch(cwd: string): string | undefined {
  const res = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!res.ok) return undefined;
  return res.stdout.trim() || undefined;
}

export function parseUnifiedDiff(raw: string): DiffFile[] {
  if (!raw.trim()) return [];
  const files: DiffFile[] = [];
  const lines = raw.split(/\r?\n/);
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const oldPath = match ? match[1] : undefined;
      const newPath = match ? match[2] : line.slice(11).trim();
      current = {
        path: newPath,
        oldPath: oldPath && oldPath !== newPath ? oldPath : undefined,
        status: "M",
        additions: 0,
        deletions: 0,
        isBinary: false,
        hunks: [],
      };
      currentHunk = null;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "A";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "D";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "R";
      current.oldPath = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") || line.startsWith("similarity index ") || line.startsWith("old mode ") || line.startsWith("new mode ")) {
      continue;
    }

    if (line.startsWith("@@ ")) {
      const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (hm) {
        oldLine = Number(hm[1]);
        const oldCount = hm[2] !== undefined ? Number(hm[2]) : 1;
        newLine = Number(hm[3]);
        const newCount = hm[4] !== undefined ? Number(hm[4]) : 1;
        currentHunk = {
          header: line,
          oldStart: oldLine,
          oldCount,
          newStart: newLine,
          newCount,
          lines: [],
        };
        current.hunks.push(currentHunk);
      }
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      current.additions++;
      currentHunk.lines.push({
        type: "add",
        oldLine: null,
        newLine: newLine++,
        content: line.slice(1),
      });
    } else if (line.startsWith("-")) {
      current.deletions++;
      currentHunk.lines.push({
        type: "del",
        oldLine: oldLine++,
        newLine: null,
        content: line.slice(1),
      });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({
        type: "context",
        oldLine: oldLine++,
        newLine: newLine++,
        content: line.slice(1),
      });
    } else if (line === "\\ No newline at end of file") {
      continue;
    }
  }

  if (current) files.push(current);
  return files;
}

function isProbablyBinary(buf: Uint8Array): boolean {
  const len = Math.min(buf.length, 4096);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function loadGitDiff(opts: GitDiffOptions): DiffFile[] {
  const root = findRepoRoot(opts.cwd) ?? opts.cwd;
  const pathArgs = opts.paths && opts.paths.length > 0 ? ["--", ...opts.paths] : [];

  let diffArgs: string[];
  if (opts.range) {
    diffArgs = ["diff", "--no-color", "-U3", opts.range, ...pathArgs];
  } else if (opts.staged) {
    diffArgs = ["diff", "--no-color", "-U3", "--cached", ...pathArgs];
  } else {
    // Compare working tree against HEAD if HEAD exists, else staged
    const hasHead = runGit(["rev-parse", "--verify", "HEAD"], root).ok;
    diffArgs = hasHead
      ? ["diff", "--no-color", "-U3", "HEAD", ...pathArgs]
      : ["diff", "--no-color", "-U3", ...pathArgs];
  }

  const diffRes = runGit(diffArgs, root);
  const files = parseUnifiedDiff(diffRes.stdout);

  // Include untracked files in working-tree mode
  if (!opts.staged && !opts.range) {
    const untrackedRes = runGit(["ls-files", "--others", "--exclude-standard", ...pathArgs], root);
    if (untrackedRes.ok && untrackedRes.stdout.trim()) {
      const seen = new Set(files.map((f) => f.path));
      for (const relPath of untrackedRes.stdout.trim().split(/\r?\n/)) {
        if (!relPath || seen.has(relPath)) continue;
        const abs = resolve(root, relPath);
        if (!existsSync(abs)) continue;
        try {
          const st = statSync(abs);
          if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
          const bytes = readFileSync(abs);
          if (isProbablyBinary(bytes)) {
            files.push({
              path: relPath,
              status: "?",
              additions: 0,
              deletions: 0,
              isBinary: true,
              hunks: [],
            });
            continue;
          }
          const text = bytes.toString("utf8");
          const contentLines = text.length === 0 ? [] : text.split(/\r?\n/);
          const lines: DiffLine[] = contentLines.map((content, idx) => ({
            type: "add",
            oldLine: null,
            newLine: idx + 1,
            content,
          }));
          files.push({
            path: relPath,
            status: "?",
            additions: lines.length,
            deletions: 0,
            isBinary: false,
            hunks:
              lines.length > 0
                ? [
                    {
                      header: `@@ -0,0 +1,${lines.length} @@`,
                      oldStart: 0,
                      oldCount: 0,
                      newStart: 1,
                      newCount: lines.length,
                      lines,
                    },
                  ]
                : [],
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  return files;
}

/**
 * Compute a unified-style DiffFile between two text snapshots (used for Round-to-Round diffs).
 * Uses LCS with prefix/suffix trimming for speed and zero external dependencies.
 */
export function computeTextDiff(
  path: string,
  oldText: string,
  newText: string,
  contextLines = 3
): DiffFile {
  if (oldText === newText) {
    return {
      path,
      status: "M",
      additions: 0,
      deletions: 0,
      isBinary: false,
      hunks: [],
    };
  }

  const oldLines = oldText === "" ? [] : oldText.split(/\r?\n/);
  const newLines = newText === "" ? [] : newText.split(/\r?\n/);

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const a = oldLines.slice(start, oldEnd);
  const b = newLines.slice(start, newEnd);

  const ops: DiffLine[] = [];

  for (let i = 0; i < start; i++) {
    ops.push({ type: "context", oldLine: i + 1, newLine: i + 1, content: oldLines[i]! });
  }

  // Guard against huge quadratic DP tables (> 3000 changed lines fallback to coarse replace)
  if (a.length * b.length > 4_000_000) {
    for (let i = 0; i < a.length; i++) {
      ops.push({ type: "del", oldLine: start + i + 1, newLine: null, content: a[i]! });
    }
    for (let j = 0; j < b.length; j++) {
      ops.push({ type: "add", oldLine: null, newLine: start + j + 1, content: b[j]! });
    }
  } else {
    const m = a.length;
    const n = b.length;
    const dp = new Int32Array((m + 1) * (n + 1));
    const cols = n + 1;

    for (let i = m - 1; i >= 0; i--) {
      const row = i * cols;
      const nextRow = (i + 1) * cols;
      for (let j = n - 1; j >= 0; j--) {
        if (a[i] === b[j]) {
          dp[row + j] = dp[nextRow + j + 1]! + 1;
        } else {
          const down = dp[nextRow + j]!;
          const right = dp[row + j + 1]!;
          dp[row + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        ops.push({
          type: "context",
          oldLine: start + i + 1,
          newLine: start + j + 1,
          content: a[i]!,
        });
        i++;
        j++;
      } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + j + 1]!) {
        ops.push({ type: "del", oldLine: start + i + 1, newLine: null, content: a[i]! });
        i++;
      } else {
        ops.push({ type: "add", oldLine: null, newLine: start + j + 1, content: b[j]! });
        j++;
      }
    }
    while (i < m) {
      ops.push({ type: "del", oldLine: start + i + 1, newLine: null, content: a[i]! });
      i++;
    }
    while (j < n) {
      ops.push({ type: "add", oldLine: null, newLine: start + j + 1, content: b[j]! });
      j++;
    }
  }

  for (let i = oldEnd, j = newEnd; i < oldLines.length; i++, j++) {
    ops.push({ type: "context", oldLine: i + 1, newLine: j + 1, content: oldLines[i]! });
  }

  // Slice into unified hunks around non-context lines
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;

  const changeIndices: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    const t = ops[idx]!.type;
    if (t === "add") {
      additions++;
      changeIndices.push(idx);
    } else if (t === "del") {
      deletions++;
      changeIndices.push(idx);
    }
  }

  if (changeIndices.length > 0) {
    let rangeStart = Math.max(0, changeIndices[0]! - contextLines);
    let rangeEnd = Math.min(ops.length - 1, changeIndices[0]! + contextLines);

    const flushHunk = (s: number, e: number) => {
      const slice = ops.slice(s, e + 1);
      const firstOld = slice.find((l) => l.oldLine !== null)?.oldLine ?? 0;
      const firstNew = slice.find((l) => l.newLine !== null)?.newLine ?? 0;
      const oldCount = slice.filter((l) => l.type !== "add").length;
      const newCount = slice.filter((l) => l.type !== "del").length;
      hunks.push({
        header: `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`,
        oldStart: firstOld,
        oldCount,
        newStart: firstNew,
        newCount,
        lines: slice,
      });
    };

    for (let k = 1; k < changeIndices.length; k++) {
      const idx = changeIndices[k]!;
      if (idx - contextLines <= rangeEnd + 1) {
        rangeEnd = Math.min(ops.length - 1, idx + contextLines);
      } else {
        flushHunk(rangeStart, rangeEnd);
        rangeStart = Math.max(0, idx - contextLines);
        rangeEnd = Math.min(ops.length - 1, idx + contextLines);
      }
    }
    flushHunk(rangeStart, rangeEnd);
  }

  const status: DiffFile["status"] =
    oldText === "" ? "A" : newText === "" ? "D" : "M";

  return {
    path,
    status,
    additions,
    deletions,
    isBinary: false,
    hunks,
  };
}

export function computeRoundDiffFiles(
  prevFiles: Record<string, string>,
  currFiles: Record<string, string>
): DiffFile[] {
  const allPaths = Array.from(
    new Set([...Object.keys(prevFiles), ...Object.keys(currFiles)])
  ).sort();

  const out: DiffFile[] = [];
  for (const p of allPaths) {
    const prev = prevFiles[p] ?? "";
    const curr = currFiles[p] ?? "";
    if (prev === curr) continue;
    out.push(computeTextDiff(p, prev, curr));
  }
  return out;
}

export function readFilesForSnapshot(root: string, relPaths: string[]): Record<string, string> {
  const snap: Record<string, string> = {};
  for (const p of relPaths) {
    const abs = resolve(root, p);
    if (!existsSync(abs)) {
      snap[p] = "";
      continue;
    }
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      const buf = readFileSync(abs);
      if (isProbablyBinary(buf)) continue;
      snap[p] = buf.toString("utf8");
    } catch {
      // skip
    }
  }
  return snap;
}

export function toDisplayPath(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath);
  if (!rel.startsWith("..") && !rel.startsWith("/")) return rel || absPath;
  return absPath;
}
