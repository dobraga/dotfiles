import {
  appState,
  apiAddComment,
  escapeHtml,
  openComposerModal,
  renderCurrentView,
} from "./app.js";
import { renderSingleDiffTable } from "./diff-view.js";

const popover = document.getElementById("selection-popover");
let currentSelectionCtx = null;

popover.querySelectorAll("button[data-kind]").forEach((btn) => {
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    if (!currentSelectionCtx) return;
    openComposerModal({
      ...currentSelectionCtx,
      kind: btn.dataset.kind,
    });
    window.getSelection()?.removeAllRanges();
  });
});

function estimateLineRange(sourceText, quote) {
  if (!sourceText || !quote) return {};
  const lines = sourceText.split(/\r?\n/);
  const needle = quote.trim().split(/\r?\n/)[0].trim();
  if (!needle) return {};
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx === -1) return {};
  const quoteLines = quote.trim().split(/\r?\n/).length;
  return {
    lineStart: idx + 1,
    lineEnd: Math.min(lines.length, idx + quoteLines),
    anchor: lines[idx].trim().slice(0, 80),
  };
}

function applyHighlights(container, comments, file) {
  const relevant = comments.filter((c) => !c.resolved && c.file === file && c.quote);
  if (relevant.length === 0) return;

  for (const c of relevant) {
    const needle = c.quote.trim();
    if (!needle || needle.length < 2) continue;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest("mark, pre, code")) continue;
      const idx = node.nodeValue.indexOf(needle);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);
        const mark = document.createElement("mark");
        mark.className = `revu-mark kind-${c.kind}`;
        mark.dataset.cid = c.id;
        mark.title = c.body;
        try {
          range.surroundContents(mark);
        } catch {
          // ignore cross-node ranges
        }
        break;
      }
    }
  }
}

export function renderMarkdownView(toolbarEl, bodyEl) {
  const docs = appState.data.documents || [];
  if (docs.length === 0) {
    toolbarEl.innerHTML = "";
    bodyEl.innerHTML = `<div class="empty-state">No document content to display.</div>`;
    return;
  }

  const doc = docs[Math.min(appState.activeDocIndex, docs.length - 1)];
  const hasRoundDiff = Boolean(doc.roundDiff && doc.roundDiff.hunks.length > 0);
  if (appState.mdSubMode === "round-diff" && !hasRoundDiff) {
    appState.mdSubMode = "rendered";
  }

  // Toolbar: file switcher + mode tabs
  const docTabs =
    docs.length > 1
      ? `<div class="toolbar-group">${docs
          .map(
            (d, i) =>
              `<button class="btn btn-tab ${i === appState.activeDocIndex ? "active" : ""}" data-doc-idx="${i}">${escapeHtml(
                d.displayPath
              )}</button>`
          )
          .join("")}</div>`
      : `<div class="toolbar-group"><span class="mono" style="color:var(--text-muted)">${escapeHtml(
          doc.displayPath
        )}</span></div>`;

  const modeTabs = `
    <div class="toolbar-group">
      ${
        doc.isMarkdown
          ? `<button class="btn btn-tab ${appState.mdSubMode === "rendered" ? "active" : ""}" data-md-mode="rendered">Rendered</button>`
          : ""
      }
      <button class="btn btn-tab ${
        appState.mdSubMode === "source" || !doc.isMarkdown ? "active" : ""
      }" data-md-mode="source">Source</button>
      ${
        hasRoundDiff
          ? `<button class="btn btn-tab ${
              appState.mdSubMode === "round-diff" ? "active" : ""
            }" data-md-mode="round-diff">Round Diff (+${doc.roundDiff.additions}/-${doc.roundDiff.deletions})</button>`
          : ""
      }
    </div>
  `;

  toolbarEl.innerHTML = docTabs + modeTabs;

  toolbarEl.querySelectorAll("[data-doc-idx]").forEach((b) => {
    b.addEventListener("click", () => {
      appState.activeDocIndex = Number(b.dataset.docIdx);
      renderCurrentView();
    });
  });

  toolbarEl.querySelectorAll("[data-md-mode]").forEach((b) => {
    b.addEventListener("click", () => {
      appState.mdSubMode = b.dataset.mdMode;
      renderCurrentView();
    });
  });

  // Render active sub-mode
  if (appState.mdSubMode === "round-diff" && doc.roundDiff) {
    bodyEl.innerHTML = `<div class="diff-content" id="md-round-diff-host"></div>`;
    const host = bodyEl.querySelector("#md-round-diff-host");
    renderSingleDiffTable(host, doc.roundDiff, "unified");
    return;
  }

  if (!doc.isMarkdown || appState.mdSubMode === "source") {
    renderSourceLinesView(bodyEl, doc);
    return;
  }

  // Rendered Markdown view
  const renderedHtml = window.marked
    ? window.marked.parse(doc.content, { gfm: true, breaks: false })
    : `<pre>${escapeHtml(doc.content)}</pre>`;

  bodyEl.innerHTML = `<article class="md-container md-rendered" id="md-article">${renderedHtml}</article>`;
  const article = bodyEl.querySelector("#md-article");
  applyHighlights(article, appState.data.comments, doc.displayPath);

  article.addEventListener("mouseup", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      popover.classList.add("hidden");
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      popover.classList.add("hidden");
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const loc = estimateLineRange(doc.content, text);
    currentSelectionCtx = {
      file: doc.displayPath,
      quote: text,
      side: "file",
      ...loc,
    };
    popover.style.left = `${Math.max(12, Math.min(window.innerWidth - 260, rect.left + rect.width / 2 - 110))}px`;
    popover.style.top = `${Math.max(58, rect.top - 44)}px`;
    popover.classList.remove("hidden");
  });

  article.addEventListener("click", (e) => {
    const mark = e.target.closest("mark[data-cid]");
    if (mark) {
      const card = document.querySelector(`.comment-card[data-cid="${mark.dataset.cid}"]`);
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

function renderSourceLinesView(bodyEl, doc) {
  const lines = doc.content.split(/\r?\n/);
  const commentsByEndLine = new Map();
  for (const c of appState.data.comments) {
    if (c.file !== doc.displayPath) continue;
    const key = c.lineEnd || c.lineStart || 1;
    const arr = commentsByEndLine.get(key) || [];
    arr.push(c);
    commentsByEndLine.set(key, arr);
  }

  let anchorLine = null;
  const rows = lines
    .map((line, i) => {
      const n = i + 1;
      const existing = commentsByEndLine.get(n) || [];
      const threadRow =
        existing.length > 0
          ? `<tr class="inline-thread-row"><td colspan="2">${existing
              .map(
                (c) =>
                  `<div class="comment-card kind-${escapeHtml(c.kind)}" style="margin:4px 0"><div class="comment-head"><span class="kind-badge ${escapeHtml(
                    c.kind
                  )}">${escapeHtml(c.kind)}</span><span class="comment-loc">L${c.lineStart || n}${
                    c.lineEnd && c.lineEnd !== c.lineStart ? `–${c.lineEnd}` : ""
                  }</span></div><div class="comment-body">${escapeHtml(c.body)}</div></div>`
              )
              .join("")}</td></tr>`
          : "";
      return `<tr class="diff-row" data-ln="${n}"><td class="ln" data-pick="${n}">${n}</td><td class="code">${escapeHtml(
        line
      )}</td></tr>${threadRow}`;
    })
    .join("");

  bodyEl.innerHTML = `<div class="diff-content"><div class="diff-file-card"><div class="diff-file-header"><span>${escapeHtml(
    doc.displayPath
  )}</span><span style="color:var(--text-muted);font-weight:400">Click line number (Shift+click for range)</span></div><table class="diff-table"><tbody>${rows}</tbody></table></div></div>`;

  bodyEl.querySelectorAll("td[data-pick]").forEach((td) => {
    td.addEventListener("click", (e) => {
      const ln = Number(td.dataset.pick);
      if (e.shiftKey && anchorLine !== null) {
        const start = Math.min(anchorLine, ln);
        const end = Math.max(anchorLine, ln);
        const quote = lines.slice(start - 1, end).join("\n");
        openComposerModal({
          file: doc.displayPath,
          kind: "comment",
          lineStart: start,
          lineEnd: end,
          side: "file",
          quote,
        });
        anchorLine = null;
      } else {
        anchorLine = ln;
        openComposerModal({
          file: doc.displayPath,
          kind: "comment",
          lineStart: ln,
          lineEnd: ln,
          side: "file",
          quote: lines[ln - 1] || "",
        });
      }
    });
  });
}
