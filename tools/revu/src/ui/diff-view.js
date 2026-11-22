import {
  appState,
  apiAddComment,
  escapeHtml,
  renderCurrentView,
} from "./app.js";
import { highlightLine, langFromPath } from "./highlight.js";

let fileFilter = "";
let activeInlineForm = null; // { file, lineStart, lineEnd, side, quote }
let dragStartLine = null;

export function renderDiffView(toolbarEl, bodyEl) {
  const data = appState.data;
  const hasRoundDiff = data.roundDiffFiles && data.roundDiffFiles.length > 0;
  if (appState.diffScope === "round" && !hasRoundDiff) {
    appState.diffScope = "all";
  }

  const files = appState.diffScope === "round" ? data.roundDiffFiles : data.diffFiles;
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  toolbarEl.innerHTML = `
    <div class="toolbar-group">
      <button class="btn btn-tab ${appState.diffScope === "all" ? "active" : ""}" data-scope="all">
        All Changes (${data.diffFiles.length})
      </button>
      ${
        hasRoundDiff
          ? `<button class="btn btn-tab ${appState.diffScope === "round" ? "active" : ""}" data-scope="round">
              Round ${data.session.round - 1} → ${data.session.round} (${data.roundDiffFiles.length})
            </button>`
          : ""
      }
      <span class="mono" style="margin-left:8px;font-size:12px">
        <span class="stat-add">+${totalAdd}</span> <span class="stat-del">-${totalDel}</span>
      </span>
    </div>
    <div class="toolbar-group">
      <button class="btn btn-tab ${appState.diffLayout === "split" ? "active" : ""}" data-layout="split">Split</button>
      <button class="btn btn-tab ${appState.diffLayout === "unified" ? "active" : ""}" data-layout="unified">Unified</button>
    </div>
  `;

  toolbarEl.querySelectorAll("[data-scope]").forEach((b) => {
    b.addEventListener("click", () => {
      appState.diffScope = b.dataset.scope;
      appState.activeFile = null;
      renderCurrentView();
    });
  });

  toolbarEl.querySelectorAll("[data-layout]").forEach((b) => {
    b.addEventListener("click", () => {
      appState.diffLayout = b.dataset.layout;
      renderCurrentView();
    });
  });

  if (files.length === 0) {
    bodyEl.innerHTML = `<div class="empty-state">No changes found in this diff scope.</div>`;
    return;
  }

  if (!appState.activeFile || !files.some((f) => f.path === appState.activeFile)) {
    appState.activeFile = files[0].path;
  }

  const commentCounts = new Map();
  for (const c of data.comments) {
    if (c.resolved) continue;
    commentCounts.set(c.file, (commentCounts.get(c.file) || 0) + 1);
  }

  const filteredFiles = fileFilter
    ? files.filter((f) => f.path.toLowerCase().includes(fileFilter.toLowerCase()))
    : files;

  bodyEl.innerHTML = `
    <div class="diff-layout">
      <aside class="file-tree">
        <div class="file-tree-filter">
          <input type="text" id="file-filter-input" placeholder="Filter files…" value="${escapeHtml(fileFilter)}" />
        </div>
        <div class="file-tree-list">
          ${filteredFiles
            .map((f) => {
              const cnt = commentCounts.get(f.path) || 0;
              return `
                <div class="file-item ${f.path === appState.activeFile ? "active" : ""}" data-file="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
                  <span class="file-status ${escapeHtml(f.status)}">${escapeHtml(f.status)}</span>
                  <span class="file-name">${escapeHtml(f.path)}</span>
                  <span class="file-stats">
                    ${cnt > 0 ? `<span class="kind-badge">${cnt}</span>` : ""}
                    <span class="stat-add">+${f.additions}</span>
                    <span class="stat-del">-${f.deletions}</span>
                  </span>
                </div>
              `;
            })
            .join("")}
        </div>
      </aside>
      <div class="diff-content" id="diff-host"></div>
    </div>
  `;

  const filterInput = bodyEl.querySelector("#file-filter-input");
  filterInput.addEventListener("input", () => {
    fileFilter = filterInput.value;
    renderCurrentView();
  });

  bodyEl.querySelectorAll(".file-item").forEach((item) => {
    item.addEventListener("click", () => {
      appState.activeFile = item.dataset.file;
      activeInlineForm = null;
      renderCurrentView();
    });
  });

  const activeFileObj = files.find((f) => f.path === appState.activeFile) || files[0];
  const host = bodyEl.querySelector("#diff-host");
  renderSingleDiffTable(host, activeFileObj, appState.diffLayout);
}

function buildSplitRows(hunk) {
  const rows = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === "context") {
      rows.push({ left: l, right: l });
      i++;
    } else {
      const dels = [];
      const adds = [];
      while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
      const max = Math.max(dels.length, adds.length);
      for (let k = 0; k < max; k++) {
        rows.push({ left: dels[k] || null, right: adds[k] || null });
      }
    }
  }
  return rows;
}

function renderInlineCommentsHtml(file, lineNum, side) {
  const comments = (appState.data?.comments || []).filter(
    (c) =>
      c.file === file &&
      (c.lineEnd || c.lineStart) === lineNum &&
      (!c.side || c.side === side || side === "any")
  );
  if (comments.length === 0) return "";
  return comments
    .map(
      (c) => `
      <div class="comment-card kind-${escapeHtml(c.kind)} ${c.resolved ? "resolved" : ""}" style="margin:6px 0">
        <div class="comment-head">
          <span class="kind-badge ${escapeHtml(c.kind)}">${escapeHtml(c.kind)}</span>
          <span class="comment-loc">L${c.lineStart}${c.lineEnd && c.lineEnd !== c.lineStart ? `–${c.lineEnd}` : ""} · ${escapeHtml(c.author)}</span>
        </div>
        <div class="comment-body">${escapeHtml(c.body)}</div>
        ${c.suggestion ? `<div class="comment-suggestion">${escapeHtml(c.suggestion)}</div>` : ""}
        ${
          c.replies?.length
            ? `<div class="comment-replies">${c.replies
                .map((r) => `<div class="reply-item"><strong>${escapeHtml(r.author)}:</strong> ${escapeHtml(r.body)}</div>`)
                .join("")}</div>`
            : ""
        }
      </div>`
    )
    .join("");
}

function renderInlineComposerHtml(colSpan) {
  if (!activeInlineForm) return "";
  const f = activeInlineForm;
  const rangeLabel =
    f.lineEnd && f.lineEnd !== f.lineStart ? `Lines ${f.lineStart}–${f.lineEnd}` : `Line ${f.lineStart}`;
  return `
    <tr class="inline-thread-row">
      <td colspan="${colSpan}">
        <div class="inline-composer" id="inline-composer-box">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted)">
            <span>Comment on <strong>${escapeHtml(f.file)}</strong> (${rangeLabel})</span>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-toggle-suggest">+ Suggest code</button>
          </div>
          <textarea id="inline-comment-body" rows="3" placeholder="Leave inline review comment… (Ctrl/Cmd+Enter to save)"></textarea>
          <div id="inline-suggest-wrap" class="hidden">
            <label class="field-label">Suggested replacement code</label>
            <textarea id="inline-comment-suggest" rows="3" class="mono">${escapeHtml(f.quote || "")}</textarea>
          </div>
          <div class="inline-composer-actions">
            <span style="font-size:11.5px;color:var(--text-muted)">Tip: Shift+click another line for a multi-line range</span>
            <div style="display:flex;gap:6px">
              <button type="button" class="btn btn-ghost btn-sm" id="inline-cancel">Cancel</button>
              <button type="button" class="btn btn-primary btn-sm" id="inline-save">Add comment</button>
            </div>
          </div>
        </div>
      </td>
    </tr>
  `;
}

export function renderSingleDiffTable(hostEl, fileObj, layout) {
  if (fileObj.isBinary) {
    hostEl.innerHTML = `<div class="diff-file-card"><div class="diff-file-header"><span>${escapeHtml(
      fileObj.path
    )}</span></div><div class="empty-state">Binary file changed.</div></div>`;
    return;
  }
  if (fileObj.hunks.length === 0) {
    hostEl.innerHTML = `<div class="diff-file-card"><div class="diff-file-header"><span>${escapeHtml(
      fileObj.path
    )}</span></div><div class="empty-state">No textual diff hunks.</div></div>`;
    return;
  }

  const lineLookup = new Map();
  for (const h of fileObj.hunks) {
    for (const l of h.lines) {
      if (l.newLine !== null) lineLookup.set(`new:${l.newLine}`, l.content);
      if (l.oldLine !== null) lineLookup.set(`old:${l.oldLine}`, l.content);
    }
  }

  let bodyRows = "";
  const colSpan = layout === "split" ? 4 : 3;
  const lang = langFromPath(fileObj.path);

  for (const hunk of fileObj.hunks) {
    bodyRows += `<tr class="diff-hunk-row"><td colspan="${colSpan}">${escapeHtml(hunk.header)}</td></tr>`;

    if (layout === "unified") {
      for (const l of hunk.lines) {
        const prefix = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
        const targetSide = l.newLine !== null ? "new" : "old";
        const targetLn = l.newLine ?? l.oldLine;
        const isSelected =
          activeInlineForm &&
          activeInlineForm.file === fileObj.path &&
          activeInlineForm.side === targetSide &&
          targetLn >= activeInlineForm.lineStart &&
          targetLn <= activeInlineForm.lineEnd;
        bodyRows += `
          <tr class="diff-row ${l.type} ${isSelected ? "selected" : ""}">
            <td class="ln" data-pick-ln="${l.oldLine ?? ""}" data-pick-side="old">${l.oldLine ?? ""}</td>
            <td class="ln" data-pick-ln="${l.newLine ?? ""}" data-pick-side="new">${l.newLine ?? ""}</td>
            <td class="code">${prefix}${highlightLine(l.content, lang)}</td>
          </tr>
        `;
        const inlineHtml = targetLn ? renderInlineCommentsHtml(fileObj.path, targetLn, targetSide) : "";
        if (inlineHtml) {
          bodyRows += `<tr class="inline-thread-row"><td colspan="3">${inlineHtml}</td></tr>`;
        }
        if (
          activeInlineForm &&
          activeInlineForm.file === fileObj.path &&
          activeInlineForm.side === targetSide &&
          activeInlineForm.lineEnd === targetLn
        ) {
          bodyRows += renderInlineComposerHtml(3);
        }
      }
    } else {
      const splitRows = buildSplitRows(hunk);
      for (const sr of splitRows) {
        const l = sr.left;
        const r = sr.right;
        const lSel =
          l &&
          activeInlineForm &&
          activeInlineForm.file === fileObj.path &&
          activeInlineForm.side === "old" &&
          l.oldLine >= activeInlineForm.lineStart &&
          l.oldLine <= activeInlineForm.lineEnd;
        const rSel =
          r &&
          activeInlineForm &&
          activeInlineForm.file === fileObj.path &&
          activeInlineForm.side === "new" &&
          r.newLine >= activeInlineForm.lineStart &&
          r.newLine <= activeInlineForm.lineEnd;
        bodyRows += `
          <tr class="diff-row">
            <td class="ln" data-pick-ln="${l?.oldLine ?? ""}" data-pick-side="old">${l?.oldLine ?? ""}</td>
            <td class="diff-cell ${l?.type === "del" ? "del" : ""} ${lSel ? "selected" : ""}">${l ? highlightLine(l.content, lang) : ""}</td>
            <td class="ln" data-pick-ln="${r?.newLine ?? ""}" data-pick-side="new">${r?.newLine ?? ""}</td>
            <td class="diff-cell ${r?.type === "add" ? "add" : ""} ${rSel ? "selected" : ""}">${r ? highlightLine(r.content, lang) : ""}</td>
          </tr>
        `;
        const leftComments = l?.oldLine ? renderInlineCommentsHtml(fileObj.path, l.oldLine, "old") : "";
        const rightComments = r?.newLine ? renderInlineCommentsHtml(fileObj.path, r.newLine, "new") : "";
        if (leftComments || rightComments) {
          bodyRows += `<tr class="inline-thread-row"><td colspan="4">${leftComments}${rightComments}</td></tr>`;
        }
        const matchLeft =
          l?.oldLine &&
          activeInlineForm &&
          activeInlineForm.file === fileObj.path &&
          activeInlineForm.side === "old" &&
          activeInlineForm.lineEnd === l.oldLine;
        const matchRight =
          r?.newLine &&
          activeInlineForm &&
          activeInlineForm.file === fileObj.path &&
          activeInlineForm.side === "new" &&
          activeInlineForm.lineEnd === r.newLine;
        if (matchLeft || matchRight) {
          bodyRows += renderInlineComposerHtml(4);
        }
      }
    }
  }

  const colgroup =
    layout === "split"
      ? `<colgroup><col style="width:48px"/><col style="width:calc(50% - 48px)"/><col style="width:48px"/><col style="width:calc(50% - 48px)"/></colgroup>`
      : `<colgroup><col style="width:48px"/><col style="width:48px"/><col/></colgroup>`;

  hostEl.innerHTML = `
    <div class="diff-file-card">
      <div class="diff-file-header">
        <span>${escapeHtml(fileObj.oldPath ? `${fileObj.oldPath} → ${fileObj.path}` : fileObj.path)}</span>
        <span class="file-stats">
          <span class="stat-add">+${fileObj.additions}</span>
          <span class="stat-del">-${fileObj.deletions}</span>
        </span>
      </div>
      <table class="diff-table">${colgroup}<tbody>${bodyRows}</tbody></table>
    </div>
  `;

  // Line picking (click or Shift+click range)
  hostEl.querySelectorAll("td[data-pick-ln]").forEach((td) => {
    td.addEventListener("click", (e) => {
      const ln = Number(td.dataset.pickLn);
      const side = td.dataset.pickSide;
      if (!ln) return;
      let start = ln;
      let end = ln;
      if (e.shiftKey && dragStartLine && dragStartLine.file === fileObj.path && dragStartLine.side === side) {
        start = Math.min(dragStartLine.ln, ln);
        end = Math.max(dragStartLine.ln, ln);
      } else {
        dragStartLine = { file: fileObj.path, side, ln };
      }
      const quoteLines = [];
      for (let k = start; k <= end; k++) {
        const text = lineLookup.get(`${side}:${k}`);
        if (text !== undefined) quoteLines.push(text);
      }
      activeInlineForm = {
        file: fileObj.path,
        lineStart: start,
        lineEnd: end,
        side,
        quote: quoteLines.join("\n"),
      };
      renderSingleDiffTable(hostEl, fileObj, layout);
      hostEl.querySelector("#inline-comment-body")?.focus();
    });
  });

  // Wire inline composer buttons if open
  const box = hostEl.querySelector("#inline-composer-box");
  if (box) {
    const bodyInput = box.querySelector("#inline-comment-body");
    const suggestWrap = box.querySelector("#inline-suggest-wrap");
    const suggestInput = box.querySelector("#inline-comment-suggest");
    box.querySelector("#btn-toggle-suggest").addEventListener("click", () => {
      suggestWrap.classList.toggle("hidden");
    });
    box.querySelector("#inline-cancel").addEventListener("click", () => {
      activeInlineForm = null;
      renderSingleDiffTable(hostEl, fileObj, layout);
    });
    const save = async () => {
      const text = bodyInput.value.trim();
      const hasSuggest = !suggestWrap.classList.contains("hidden");
      const suggestion = hasSuggest ? suggestInput.value : undefined;
      if (!text && !suggestion) return;
      const form = activeInlineForm;
      activeInlineForm = null;
      await apiAddComment({
        file: form.file,
        kind: hasSuggest ? "replace" : "comment",
        lineStart: form.lineStart,
        lineEnd: form.lineEnd,
        side: form.side,
        quote: form.quote,
        body: text || "Suggested code change",
        suggestion,
      });
    };
    box.querySelector("#inline-save").addEventListener("click", save);
    box.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
  }
}
