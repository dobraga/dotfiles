import { renderMarkdownView } from "./markdown-view.js";
import { renderDiffView } from "./diff-view.js";
import { renderLiveView, focusLivePin, syncPinsToIframe, toggleLivePinMode } from "./live-view.js";

export const appState = {
  data: null,
  activeDocIndex: 0,
  mdSubMode: "rendered", // rendered | source | round-diff
  diffLayout: "split", // split | unified
  diffScope: "all", // all | round
  activeFile: null,
  activeCommentId: null,
  showResolved: false,
  pinMode: true,
  decided: false,
  pendingComposer: null,
};

const els = {
  modeBadge: document.getElementById("mode-badge"),
  roundBadge: document.getElementById("round-badge"),
  title: document.getElementById("review-title"),
  commentCount: document.getElementById("comment-count"),
  btnCopyMd: document.getElementById("btn-copy-md"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnTheme: document.getElementById("btn-theme"),
  btnHelp: document.getElementById("btn-help"),
  btnRequestChanges: document.getElementById("btn-request-changes"),
  btnApprove: document.getElementById("btn-approve"),
  decisionBanner: document.getElementById("decision-banner"),
  toolbar: document.getElementById("view-toolbar"),
  body: document.getElementById("view-body"),
  commentsList: document.getElementById("comments-list"),
  chkShowResolved: document.getElementById("chk-show-resolved"),
  generalNote: document.getElementById("general-note"),
  popover: document.getElementById("selection-popover"),
  composerModal: document.getElementById("composer-modal"),
  composerTitle: document.getElementById("composer-title"),
  composerContext: document.getElementById("composer-context"),
  composerBody: document.getElementById("composer-body"),
  composerSuggestionWrap: document.getElementById("composer-suggestion-wrap"),
  composerSuggestion: document.getElementById("composer-suggestion"),
  composerSubmit: document.getElementById("composer-submit"),
  composerCancel: document.getElementById("composer-cancel"),
  composerClose: document.getElementById("composer-close"),
  helpModal: document.getElementById("help-modal"),
  helpClose: document.getElementById("help-close"),
  toast: document.getElementById("toast"),
};

let toastTimer = null;
export function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Theme
function initTheme() {
  const saved = localStorage.getItem("revu-theme");
  const pref = saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", pref);
}
initTheme();

els.btnTheme.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("revu-theme", next);
});

// API helpers
export async function apiAddComment(payload) {
  const res = await fetch("/api/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to add comment");
  const created = await res.json();
  appState.data.comments.push(created);
  renderSidebar();
  renderCurrentView();
  showToast("Annotation saved");
  return created;
}

export async function apiPatchComment(id, patch) {
  const res = await fetch(`/api/comments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return;
  const updated = await res.json();
  const idx = appState.data.comments.findIndex((c) => c.id === id);
  if (idx !== -1) appState.data.comments[idx] = updated;
  renderSidebar();
  renderCurrentView();
}

export async function apiDeleteComment(id) {
  const res = await fetch(`/api/comments/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) return;
  appState.data.comments = appState.data.comments.filter((c) => c.id !== id);
  renderSidebar();
  renderCurrentView();
  showToast("Annotation deleted");
}

export async function apiReplyComment(id, body) {
  const res = await fetch(`/api/comments/${encodeURIComponent(id)}/replies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, author: "Reviewer" }),
  });
  if (!res.ok) return;
  const reply = await res.json();
  const target = appState.data.comments.find((c) => c.id === id);
  if (target) target.replies.push(reply);
  renderSidebar();
  renderCurrentView();
}

// Modal Composer (shared by Markdown selection & Live DOM pin)
export function openComposerModal(ctx) {
  appState.pendingComposer = ctx;
  els.popover.classList.add("hidden");
  const labels = {
    comment: "Add comment",
    replace: "Suggest replacement",
    delete: "Mark for deletion (redline)",
    pin: "Pin comment to DOM element",
  };
  els.composerTitle.textContent = labels[ctx.kind] || "Add annotation";

  const ctxLines = [];
  if (ctx.selector) {
    ctxLines.push(`Selector: ${ctx.selector}`);
    if (ctx.route) ctxLines.push(`Route: ${ctx.route}`);
    if (ctx.textExcerpt) ctxLines.push(`Text: "${ctx.textExcerpt}"`);
  } else {
    if (ctx.file) ctxLines.push(`File: ${ctx.file}${ctx.lineStart ? `:${ctx.lineStart}${ctx.lineEnd && ctx.lineEnd !== ctx.lineStart ? `-${ctx.lineEnd}` : ""}` : ""}`);
    if (ctx.quote) ctxLines.push(`"${ctx.quote}"`);
  }
  els.composerContext.textContent = ctxLines.join("\n");
  els.composerBody.value = ctx.kind === "delete" ? "Remove this." : "";

  if (ctx.kind === "replace") {
    els.composerSuggestionWrap.classList.remove("hidden");
    els.composerSuggestion.value = ctx.quote || "";
  } else {
    els.composerSuggestionWrap.classList.add("hidden");
    els.composerSuggestion.value = "";
  }

  els.composerModal.classList.remove("hidden");
  els.composerBody.focus();
  els.composerBody.select();
}

function closeComposerModal() {
  els.composerModal.classList.add("hidden");
  appState.pendingComposer = null;
}

async function submitComposerModal() {
  const ctx = appState.pendingComposer;
  if (!ctx) return;
  const body = els.composerBody.value.trim();
  const suggestion = ctx.kind === "replace" ? els.composerSuggestion.value : undefined;
  if (!body && !suggestion) {
    showToast("Write a comment first");
    return;
  }
  await apiAddComment({
    ...ctx,
    body: body || (ctx.kind === "replace" ? "Suggested replacement" : ""),
    suggestion,
  });
  closeComposerModal();
}

els.composerSubmit.addEventListener("click", submitComposerModal);
els.composerCancel.addEventListener("click", closeComposerModal);
els.composerClose.addEventListener("click", closeComposerModal);
els.composerModal.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    submitComposerModal();
  }
});

// General note autosave
let noteTimer = null;
els.generalNote.addEventListener("input", () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    fetch("/api/note", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: els.generalNote.value }),
    });
  }, 350);
});

els.chkShowResolved.addEventListener("change", () => {
  appState.showResolved = els.chkShowResolved.checked;
  renderSidebar();
});

// Submit final decision
async function submitDecision(action) {
  if (appState.decided) return;
  els.btnApprove.disabled = true;
  els.btnRequestChanges.disabled = true;

  const res = await fetch("/api/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, generalNote: els.generalNote.value }),
  });
  if (!res.ok) {
    els.btnApprove.disabled = false;
    els.btnRequestChanges.disabled = false;
    showToast("Failed to send decision");
    return;
  }
  const { decision } = await res.json();
  showDecisionBanner(decision);
}

function showDecisionBanner(decision) {
  appState.decided = true;
  els.decisionBanner.classList.remove("hidden", "approved", "changes");
  if (decision.approved) {
    els.decisionBanner.classList.add("approved");
    els.decisionBanner.textContent =
      "✓ Approved and returned to agent. You can close this tab.";
  } else {
    els.decisionBanner.classList.add("changes");
    els.decisionBanner.textContent =
      "✎ Changes requested — structured feedback sent back to your agent. You can close this tab.";
  }
}

els.btnApprove.addEventListener("click", () => submitDecision("approve"));
els.btnRequestChanges.addEventListener("click", () => submitDecision("request_changes"));

els.btnRefresh.addEventListener("click", async () => {
  const res = await fetch("/api/refresh", { method: "POST" });
  if (res.ok) {
    appState.data = await res.json();
    renderAll();
    showToast(`Refreshed (Round ${appState.data.session.round})`);
  }
});

function buildFeedbackMarkdown() {
  const data = appState.data;
  if (!data) return "";
  const open = data.comments.filter((c) => !c.resolved);
  const lines = [`# Revu Feedback (Round ${data.session.round})`, `Target: ${data.session.title}`];
  const note = els.generalNote.value.trim();
  if (note) lines.push("", "## General Notes", note);
  for (const c of open) {
    const loc = c.selector || `${c.file}${c.lineStart ? `:${c.lineStart}` : ""}`;
    lines.push("", `- **[#${c.id}] [${c.kind.toUpperCase()}] ${loc}**: ${c.body}`);
    if (c.suggestion) lines.push("  ```suggestion", c.suggestion, "  ```");
  }
  return lines.join("\n");
}

els.btnCopyMd.addEventListener("click", async () => {
  const md = buildFeedbackMarkdown();
  try {
    await navigator.clipboard.writeText(md);
    showToast("Copied feedback Markdown");
  } catch {
    showToast("Clipboard unavailable");
  }
});

function focusComment(c) {
  if (!c) return;
  const mode = appState.data?.session.mode;
  if (c.kind === "pin") {
    focusLivePin(c);
  } else if (mode === "diff" && c.file) {
    appState.activeFile = c.file;
    renderCurrentView();
  } else if (mode === "markdown") {
    const docs = appState.data.documents || [];
    const docIdx = docs.findIndex((d) => d.displayPath === c.file);
    if (docIdx !== -1 && docIdx !== appState.activeDocIndex) {
      appState.activeDocIndex = docIdx;
      renderCurrentView();
    }
    const mark = document.querySelector(`mark[data-cid="${c.id}"]`);
    if (mark) {
      mark.scrollIntoView({ behavior: "smooth", block: "center" });
      mark.classList.remove("revu-pulse");
      void mark.offsetWidth;
      mark.classList.add("revu-pulse");
      setTimeout(() => mark.classList.remove("revu-pulse"), 1200);
    }
  }
}

// Help modal
els.btnHelp.addEventListener("click", () => els.helpModal.classList.remove("hidden"));
els.helpClose.addEventListener("click", () => els.helpModal.classList.add("hidden"));

// Render sidebar annotations
export function renderSidebar() {
  const data = appState.data;
  if (!data) return;
  const openCount = data.comments.filter((c) => !c.resolved).length;
  els.commentCount.textContent = `${openCount} open${data.comments.length !== openCount ? ` / ${data.comments.length}` : ""}`;

  const visible = appState.showResolved
    ? data.comments
    : data.comments.filter((c) => !c.resolved);

  if (visible.length === 0) {
    els.commentsList.innerHTML = `<div class="empty-state">No annotations yet.<br/><br/>${
      data.session.mode === "markdown"
        ? "Select any text in the document to comment, replace, or redline."
        : data.session.mode === "diff"
        ? "Click or drag line numbers in the diff to add inline comments."
        : "Use Pin mode to click any element in the page and leave a comment."
    }</div>`;
    syncPinsToIframe(data.comments);
    return;
  }

  els.commentsList.innerHTML = visible
    .map((c, idx) => {
      const loc = c.selector
        ? `${c.selector}${c.route ? ` (${c.route})` : ""}`
        : `${c.file}${c.lineStart ? `:${c.lineStart}${c.lineEnd && c.lineEnd !== c.lineStart ? `-${c.lineEnd}` : ""}` : ""}`;
      const repliesHtml =
        c.replies && c.replies.length > 0
          ? `<div class="comment-replies">${c.replies
              .map((r) => `<div class="reply-item"><strong>${escapeHtml(r.author)}:</strong> ${escapeHtml(r.body)}</div>`)
              .join("")}</div>`
          : "";
      return `
        <div class="comment-card kind-${escapeHtml(c.kind)} ${c.resolved ? "resolved" : ""} ${
        appState.activeCommentId === c.id ? "active" : ""
      }" data-cid="${escapeHtml(c.id)}">
          <div class="comment-head">
            <span class="kind-badge ${escapeHtml(c.kind)}">${c.kind === "pin" ? `#${idx + 1} PIN` : escapeHtml(c.kind)}</span>
            <span class="comment-loc" title="${escapeHtml(loc)}">${escapeHtml(loc)}</span>
          </div>
          ${c.quote ? `<div class="comment-quote">${escapeHtml(c.quote)}</div>` : ""}
          ${c.textExcerpt && !c.quote ? `<div class="comment-quote">"${escapeHtml(c.textExcerpt)}"</div>` : ""}
          <div class="comment-body">${escapeHtml(c.body)}</div>
          ${c.suggestion ? `<div class="comment-suggestion">${escapeHtml(c.suggestion)}</div>` : ""}
          ${repliesHtml}
          <div class="comment-actions">
            <button class="btn btn-ghost btn-sm" data-act="reply" data-cid="${escapeHtml(c.id)}">Reply</button>
            <button class="btn btn-ghost btn-sm" data-act="resolve" data-cid="${escapeHtml(c.id)}">${
        c.resolved ? "Unresolve" : "Resolve"
      }</button>
            <button class="btn btn-ghost btn-sm" data-act="delete" data-cid="${escapeHtml(c.id)}">Delete</button>
          </div>
        </div>
      `;
    })
    .join("");

  // Wire card actions
  els.commentsList.querySelectorAll(".comment-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      const cid = card.dataset.cid;
      if (btn) {
        e.stopPropagation();
        const act = btn.dataset.act;
        const c = data.comments.find((x) => x.id === cid);
        if (!c) return;
        if (act === "resolve") apiPatchComment(cid, { resolved: !c.resolved });
        else if (act === "delete") apiDeleteComment(cid);
        else if (act === "reply") {
          const text = window.prompt("Reply to annotation:");
          if (text && text.trim()) apiReplyComment(cid, text.trim());
        }
        return;
      }
      appState.activeCommentId = cid;
      const c = data.comments.find((x) => x.id === cid);
      if (c) focusComment(c);
      renderSidebar();
    });
  });

  syncPinsToIframe(data.comments);
}

export function renderHeader() {
  const { session } = appState.data;
  const modeLabels = {
    markdown: "PLAN / MD",
    diff: "GIT DIFF",
    html: "HTML",
    live: "LIVE PROXY",
  };
  els.modeBadge.textContent = modeLabels[session.mode] || session.mode;
  els.roundBadge.textContent = `Round ${session.round}`;
  els.roundBadge.classList.toggle("multi", session.round > 1);
  els.title.textContent = session.title;
  document.title = `Revu — ${session.title}`;
  if (els.generalNote.value !== (appState.data.generalNote || "")) {
    els.generalNote.value = appState.data.generalNote || "";
  }
}

export function renderCurrentView() {
  const data = appState.data;
  if (!data) return;
  const mode = data.session.mode;
  if (mode === "markdown") {
    renderMarkdownView(els.toolbar, els.body);
  } else if (mode === "diff") {
    renderDiffView(els.toolbar, els.body);
  } else {
    renderLiveView(els.toolbar, els.body);
  }
}

export function renderAll() {
  renderHeader();
  renderSidebar();
  renderCurrentView();
}

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  const inInput = tag === "TEXTAREA" || tag === "INPUT";

  if (e.key === "Escape") {
    els.popover.classList.add("hidden");
    els.helpModal.classList.add("hidden");
    closeComposerModal();
    return;
  }
  if (inInput) return;

  if (e.key === "?") {
    els.helpModal.classList.toggle("hidden");
  } else if (e.key === "d" && appState.data?.session.mode === "diff") {
    appState.diffLayout = appState.diffLayout === "split" ? "unified" : "split";
    renderCurrentView();
  } else if (e.key === "r" && appState.data?.session.round > 1) {
    if (appState.data.session.mode === "diff") {
      appState.diffScope = appState.diffScope === "round" ? "all" : "round";
    } else if (appState.data.session.mode === "markdown") {
      appState.mdSubMode = appState.mdSubMode === "round-diff" ? "rendered" : "round-diff";
    }
    renderCurrentView();
  } else if (e.key === "p" && (appState.data?.session.mode === "live" || appState.data?.session.mode === "html")) {
    toggleLivePinMode();
  } else if (e.key === "]" || e.key === "[") {
    const open = (appState.data?.comments || []).filter((c) => !c.resolved);
    if (open.length === 0) return;
    const curIdx = open.findIndex((c) => c.id === appState.activeCommentId);
    const nextIdx =
      e.key === "]"
        ? (curIdx + 1) % open.length
        : (curIdx <= 0 ? open.length - 1 : curIdx - 1);
    const target = open[nextIdx];
    appState.activeCommentId = target.id;
    renderSidebar();
    focusComment(target);
  } else if (e.key === "j" || e.key === "k") {
    const mode = appState.data?.session.mode;
    if (mode === "diff") {
      const files =
        appState.diffScope === "round" && appState.data.roundDiffFiles.length > 0
          ? appState.data.roundDiffFiles
          : appState.data.diffFiles;
      if (files.length === 0) return;
      const curIdx = Math.max(0, files.findIndex((f) => f.path === appState.activeFile));
      const nextIdx = e.key === "j" ? Math.min(files.length - 1, curIdx + 1) : Math.max(0, curIdx - 1);
      appState.activeFile = files[nextIdx].path;
      renderCurrentView();
    } else {
      const list = appState.data?.comments.filter((c) => appState.showResolved || !c.resolved) || [];
      if (list.length === 0) return;
      const curIdx = list.findIndex((c) => c.id === appState.activeCommentId);
      const nextIdx =
        e.key === "j"
          ? Math.min(list.length - 1, curIdx + 1)
          : Math.max(0, curIdx <= 0 ? 0 : curIdx - 1);
      appState.activeCommentId = list[nextIdx].id;
      renderSidebar();
    }
  }
});

// Boot + SSE live updates
async function boot() {
  const res = await fetch("/api/state");
  appState.data = await res.json();
  if (appState.data.diffFiles?.length > 0) {
    appState.activeFile = appState.data.diffFiles[0].path;
  }
  renderAll();

  const ev = new EventSource("/api/events");
  ev.addEventListener("comments-updated", (msg) => {
    const payload = JSON.parse(msg.data);
    appState.data.comments = payload.comments;
    renderSidebar();
    renderCurrentView();
  });
  ev.addEventListener("state-updated", async () => {
    const r = await fetch("/api/state");
    appState.data = await r.json();
    renderAll();
    showToast(`Updated (Round ${appState.data.session.round})`);
  });
  ev.addEventListener("decision-recorded", (msg) => {
    showDecisionBanner(JSON.parse(msg.data));
  });
}

boot();
