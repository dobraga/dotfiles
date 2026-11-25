// Inline PR detail view with CI checks, reviewers, unresolved comments/tasks, and workflow actions.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView } from "gpui-base";
import { appHome, exec, notify, openOverlay, panes, run, spaces } from "herdr";

const EMOJI = { mag: "🔍", clipboard: "📋", white_check_mark: "✅", x: "❌", warning: "⚠️", bulb: "💡", memo: "📝", rocket: "🚀", bug: "🐛", lock: "🔒", eyes: "👀", question: "❓", information_source: "ℹ️", tada: "🎉", wrench: "🔧", sparkles: "✨" };

// Comment bodies are GitHub-flavoured Markdown; map :shortcodes: and drop the ```expand fence label.
export function prepMarkdown(text, max) {
  return String(text || "")
    .slice(0, max)
    .replace(/:([a-z0-9_+-]+):/g, (m, k) => EMOJI[k] ?? m)
    .replace(/^```expand\s*$/gm, "");
}

export function formatRelTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function buildPrPrompt(pr, detail) {
  const lines = [
    `Pull Request #${pr.number}: ${pr.title}`,
    `Provider: ${pr.provider} | Repo: ${pr.repo}`,
    `Branch: ${pr.sourceBranch} -> ${pr.targetBranch}`,
    `Author: ${pr.author} | CI: ${pr.ciState} | Review: ${pr.reviewState}`,
    `URL: ${pr.url}`,
  ];
  const failing = (pr.checks ?? []).filter((c) => c.status === "failure").map((c) => c.name);
  if (failing.length) lines.push(`Failing checks: ${failing.join(", ")}`);
  if (pr.unresolvedCount > 0) lines.push(`Unresolved threads/tasks: ${pr.unresolvedCount}`);
  if (detail?.comments?.length) {
    lines.push("", "Recent comments:");
    for (const c of detail.comments.slice(0, 5)) {
      const where = c.path ? ` (${c.path})` : "";
      lines.push(`- ${c.author}${where}: ${c.text.slice(0, 200)}`);
    }
  }
  lines.push("", "Please inspect this PR, check the failing checks/review comments if any, and help address or review it.");
  return lines.join("\n");
}

function findSpaceForPr(pr) {
  if (!pr?.localPath) return null;
  const allPanes = panes();
  const norm = pr.localPath.replace(/\/+$/, "");
  for (const s of spaces()) {
    if (s.machine) continue;
    const tabIds = new Set((s.tabs ?? []).map((tb) => tb.id));
    const cwd = (allPanes.find((p) => tabIds.has(p.tab) && p.cwd)?.cwd || s.folder || "").replace(/\/+$/, "");
    const branch = s.branch || allPanes.find((p) => tabIds.has(p.tab) && p.branch)?.branch || "";
    if (!cwd || !branch) continue;
    const repoMatches = cwd === norm || cwd.startsWith(norm + "/") || cwd.endsWith(`/${pr.repoShort}`);
    if (repoMatches && branch === pr.sourceBranch) return s;
  }
  return null;
}

export function renderDetailView(panel, pr, detail, t, cx) {
  const helperPath = `${appHome()}/mods/prs-panel/forge-helper.py`;
  const matchingSpace = findSpaceForPr(pr);
  const ciColor = pr.ciState === "failure" ? t.ansi1 : pr.ciState === "success" ? t.ansi2 : pr.ciState === "pending" ? t.working : t.dim;
  const ciLabel = pr.ciState === "failure" ? "CI Failed" : pr.ciState === "success" ? "CI Passed" : pr.ciState === "pending" ? "CI Running" : "No CI";
  const revColor = pr.reviewState === "changes_requested" ? t.ansi1 : pr.reviewState === "approved" ? t.ansi2 : t.blocked;
  const revLabel = pr.reviewState === "changes_requested" ? "Changes requested" : pr.reviewState === "approved" ? `Approved (${pr.approvals})` : "Pending review";

  const pillBtn = (id, label, accent, action, disabled = false) =>
    div()
      .id(id)
      .h(26)
      .px(9)
      .flex()
      .items_center()
      .rounded(6)
      .border_1()
      .border_color(accent ? t.accent : t.border)
      .bg(accent ? t.selected : t.raised)
      .text_size(11.5)
      .text_color(disabled ? t.dim : accent ? t.foreground : t.muted)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action))
      .child(label);

  const launchWorktree = (cx) => {
    if (!pr.localPath || panel.wtBusy) return;
    panel.wtBusy = true;
    panel.wtStatus = "Preparing worktree…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await exec("python3", [helperPath, "prepare-worktree", "--repo-path", pr.localPath, "--branch", pr.sourceBranch]);
        const data = JSON.parse(res.stdout || "{}");
        if (!data.ok) throw new Error(data.error || "prepare-worktree failed");
        if (data.existingWorktreePath) {
          const normWt = data.existingWorktreePath.replace(/\/+$/, "");
          const existingSp = spaces().find((s) => !s.machine && (s.folder || "").replace(/\/+$/, "") === normWt);
          if (existingSp) run("space.select", { id: existingSp.id });
          else run("space.new", { folder: normWt, name: pr.sourceBranch });
        } else {
          openOverlay({
            mod: "worktree",
            kind: "dialog",
            width: 520,
            props: { folder: pr.localPath, action: "new", branch: pr.sourceBranch },
          });
        }
        panel.wtStatus = null;
      } catch (e) {
        panel.wtStatus = String(e);
      } finally {
        panel.wtBusy = false;
        cx.notify();
      }
    });
  };

  const launchAgent = (provider, mode, cx) => {
    const prompt = buildPrPrompt(pr, detail);
    const cwd = matchingSpace?.folder || pr.localPath || undefined;
    const tabName = `PR #${pr.number}`;
    panel.showAgentPicker = false;
    if (mode === "chat") {
      cx.write_to_clipboard(prompt);
      const chatId = `c-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
      run("tab.new", {
        name: tabName,
        ...(matchingSpace ? { space: matchingSpace.id } : {}),
        mod: "chat",
        props: { chat: chatId, provider, ...(cwd ? { cwd } : {}) },
      });
      notify({
        title: `PR #${pr.number} context copied`,
        body: "Paste (Ctrl+V) into the new chat tab",
        level: "info",
        timeout: 4500,
      });
    } else {
      run("tab.new", {
        name: tabName,
        ...(matchingSpace ? { space: matchingSpace.id } : {}),
        ...(cwd ? { folder: cwd } : {}),
        argv: [provider],
        task: prompt,
      });
    }
    cx.notify();
  };

  const checks = pr.checks ?? [];
  const reviewers = pr.reviewers ?? [];
  const comments = detail?.comments ?? [];

  return v_flex()
    .id("pr-detail-view")
    .flex_1()
    .min_h(0)
    // Subheader bar
    .child(
      h_flex()
        .h(36)
        .flex_none()
        .px(12)
        .gap(8)
        .items_center()
        .border_b(1)
        .border_color(t.border)
        .bg(t.chrome)
        .child(
          h_flex()
            .id("pr-back")
            .px(7)
            .py(3)
            .gap(5)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .text_size(12)
            .text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              panel.selectedKey = null;
              panel.showAgentPicker = false;
              panel.showDescription = false;
              cx.notify();
            })
            .child("← Back"),
        )
        .child(svg(`mods/prs-panel/${pr.provider}.svg`).size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(`${pr.repoShort} #${pr.number}`))
        .when(pr.draft, (el) => el.child(div().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child("Draft")))
        .when(pr.conflicts === true, (el) => el.child(div().px(5).py(1).rounded(4).bg(t.ansi1 + "22").text_size(10).text_color(t.ansi1).child("Conflict"))),
    )
    // Scrollable detail body
    .child(
      div()
        .flex_1()
        .min_h(0)
        .relative()
        .child(
          v_flex()
            .id("pr-detail-scroll")
            .absolute()
            .inset_0()
            .overflow_y_scroll()
            .p(12)
            .gap(12)
            // Title & meta
            .child(
              v_flex()
                .gap(6)
                .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(pr.title))
                .child(
                  h_flex()
                    .gap(6)
                    .flex_wrap()
                    .items_center()
                    .text_size(11.5)
                    .text_color(t.dim)
                    .child(pr.author || "unknown")
                    .child("·")
                    .child(formatRelTime(pr.updatedAt))
                    .child("·")
                    .child(div().text_color(t.ansi2).child(`+${pr.additions}`))
                    .child(div().text_color(t.ansi1).child(`−${pr.deletions}`))
                    .child(`(${pr.changedFiles} files)`),
                )
                .child(
                  h_flex()
                    .px(8)
                    .py(4)
                    .gap(6)
                    .items_center()
                    .rounded(6)
                    .bg(t.chrome)
                    .border_1()
                    .border_color(t.border)
                    .text_size(11)
                    .text_color(t.muted)
                    .child(svg("mods/workspace-chrome/branch.svg").size(11).flex_none().text_color(t.dim))
                    .child(div().flex_1().min_w(0).truncate().child(`${pr.sourceBranch} → ${pr.targetBranch}`)),
                ),
            )
            // Actions row
            .child(
              v_flex()
                .gap(6)
                .child(
                  h_flex()
                    .gap(6)
                    .flex_wrap()
                    .when(Boolean(pr.url && /^https?:\/\//.test(pr.url)), (el) =>
                      el.child(pillBtn("pr-act-open", "Open", true, (_e, cx) => cx.open_url(pr.url))),
                    )
                    .when(Boolean(pr.url), (el) =>
                      el.child(
                        pillBtn("pr-act-copy-url", panel.copiedField === "url" ? "Copied URL" : "Copy URL", false, (_e, cx) => {
                          cx.write_to_clipboard(pr.url);
                          panel.copiedField = "url";
                          cx.notify();
                          cx.timer.after(1500, (cx) => { panel.copiedField = null; cx.notify(); });
                        }),
                      ),
                    )
                    .when(Boolean(pr.sourceBranch), (el) =>
                      el.child(
                        pillBtn("pr-act-copy-br", panel.copiedField === "branch" ? "Copied branch" : "Copy branch", false, (_e, cx) => {
                          cx.write_to_clipboard(pr.sourceBranch);
                          panel.copiedField = "branch";
                          cx.notify();
                          cx.timer.after(1500, (cx) => { panel.copiedField = null; cx.notify(); });
                        }),
                      ),
                    )
                    .when(Boolean(matchingSpace), (el) =>
                      el.child(
                        pillBtn("pr-act-go-space", "Go to Space", true, () => run("space.select", { id: matchingSpace.id })),
                      ),
                    )
                    .when(!matchingSpace && Boolean(pr.localPath), (el) =>
                      el.child(
                        pillBtn("pr-act-worktree", panel.wtBusy ? "Preparing…" : "Worktree", false, (_e, cx) => launchWorktree(cx), panel.wtBusy),
                      ),
                    )
                    .child(
                      pillBtn("pr-act-agent", panel.showAgentPicker ? "Agent ▴" : "Agent ▾", panel.showAgentPicker, (_e, cx) => {
                        panel.showAgentPicker = !panel.showAgentPicker;
                        cx.notify();
                      }),
                    ),
                )
                .when(Boolean(panel.wtStatus), (el) => el.child(div().text_size(11).text_color(t.muted).child(panel.wtStatus)))
                .when(panel.showAgentPicker, (el) =>
                  el.child(
                    h_flex()
                      .p(8)
                      .gap(6)
                      .flex_wrap()
                      .rounded(7)
                      .bg(t.chrome)
                      .border_1()
                      .border_color(t.border)
                      .child(pillBtn("ag-claude-chat", "Claude Chat", false, (_e, cx) => launchAgent("claude", "chat", cx)))
                      .child(pillBtn("ag-agy-chat", "Antigravity Chat", false, (_e, cx) => launchAgent("agy", "chat", cx)))
                      .child(pillBtn("ag-claude-tui", "Claude TUI", false, (_e, cx) => launchAgent("claude", "tui", cx)))
                      .child(pillBtn("ag-agy-tui", "Antigravity TUI", false, (_e, cx) => launchAgent("agy", "tui", cx))),
                  ),
                ),
            )
            // CI & Checks
            .child(
              v_flex()
                .p(10)
                .gap(7)
                .rounded(8)
                .bg(t.chrome)
                .border_1()
                .border_color(t.border)
                .child(
                  h_flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("Checks / CI"))
                    .child(div().text_size(11.5).font_medium().text_color(ciColor).child(ciLabel)),
                )
                .when(checks.length === 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("No check runs reported")))
                .when(checks.length > 0, (el) =>
                  el.children(
                    checks.map((c, idx) => {
                      const col = c.status === "failure" ? t.ansi1 : c.status === "success" ? t.ansi2 : t.working;
                      const mark = c.status === "failure" ? "✕" : c.status === "success" ? "✓" : "●";
                      const canOpen = Boolean(c.url && /^https?:\/\//.test(c.url));
                      return h_flex()
                        .id(`pr-chk-${idx}`)
                        .gap(7)
                        .py(2)
                        .px(4)
                        .rounded(5)
                        .items_center()
                        .when(canOpen, (row) => row.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => cx.open_url(c.url)))
                        .child(div().w(12).text_size(11).font_bold().text_color(col).child(mark))
                        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(c.name))
                        .when(canOpen, (row) => row.child(div().text_size(10).text_color(t.dim).child("↗")));
                    }),
                  ),
                ),
            )
            // Reviewers
            .child(
              v_flex()
                .p(10)
                .gap(7)
                .rounded(8)
                .bg(t.chrome)
                .border_1()
                .border_color(t.border)
                .child(
                  h_flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("Reviewers"))
                    .child(div().text_size(11.5).font_medium().text_color(revColor).child(revLabel)),
                )
                .when(reviewers.length === 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("No reviewers assigned")))
                .when(reviewers.length > 0, (el) =>
                  el.children(
                    reviewers.map((r, idx) => {
                      const col = r.state === "changes_requested" ? t.ansi1 : r.state === "approved" ? t.ansi2 : t.muted;
                      const badge = r.state === "changes_requested" ? "Changes" : r.state === "approved" ? "Approved" : r.state === "commented" ? "Commented" : "Pending";
                      return h_flex()
                        .id(`pr-rev-${idx}`)
                        .gap(8)
                        .items_center()
                        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(r.name))
                        .child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(col).child(badge));
                    }),
                  ),
                ),
            )
            // Comments & Unresolved threads
            .child(
              v_flex()
                .p(10)
                .gap(7)
                .rounded(8)
                .bg(t.chrome)
                .border_1()
                .border_color(t.border)
                .child(
                  h_flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(`Comments (${pr.commentCount})`))
                    .when(pr.unresolvedCount > 0, (el) =>
                      el.child(div().px(6).py(1).rounded(4).bg(t.blocked + "22").text_size(10.5).text_color(t.blocked).child(`${pr.unresolvedCount} unresolved`)),
                    ),
                )
                .when(panel.detailLoading && !detail, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("Loading comments…")))
                .when(Boolean(detail && !detail.ok), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).child(detail.error || "Failed to load details")))
                .when(Boolean(detail?.ok && comments.length === 0), (el) => el.child(div().text_size(11.5).text_color(t.dim).child("No recent comments")))
                .when(comments.length > 0, (el) =>
                  el.children(
                    comments.map((c, idx) => {
                      const canOpen = Boolean(c.url && /^https?:\/\//.test(c.url));
                      return v_flex()
                        .id(`pr-cmt-${idx}`)
                        .p(7)
                        .gap(3)
                        .rounded(6)
                        .bg(t.background)
                        .border_1()
                        .border_color(c.unresolved ? t.blocked + "66" : t.border)
                        .when(canOpen, (row) => row.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => cx.open_url(c.url)))
                        .child(
                          h_flex()
                            .gap(6)
                            .items_center()
                            .text_size(11)
                            .child(div().font_medium().text_color(t.foreground).child(c.author))
                            .when(Boolean(c.path), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(c.path)))
                            .when(!c.path, (el) => el.child(div().flex_1()))
                            .child(div().text_color(t.dim).child(formatRelTime(c.createdAt))),
                        )
                        .child(TextView.markdown(`pr-cmt-md-${idx}`, prepMarkdown(c.text, 1500)).text_size(11.5).text_color(t.muted).max_h(260).overflow_hidden());
                    }),
                  ),
                ),
            )
            // Collapsible description
            .when(Boolean(detail?.description), (el) =>
              el.child(
                v_flex()
                  .p(10)
                  .gap(6)
                  .rounded(8)
                  .bg(t.chrome)
                  .border_1()
                  .border_color(t.border)
                  .child(
                    h_flex()
                      .id("pr-desc-toggle")
                      .items_center()
                      .justify_between()
                      .cursor_pointer()
                      .on_click((_e, cx) => {
                        panel.showDescription = !panel.showDescription;
                        cx.notify();
                      })
                      .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("Description"))
                      .child(div().text_size(11).text_color(t.dim).child(panel.showDescription ? "Hide" : "Show")),
                  )
                  .when(panel.showDescription, (e2) =>
                    e2.child(TextView.markdown("pr-desc-md", prepMarkdown(detail.description, 4000)).text_size(11.5).text_color(t.muted)),
                  ),
              ),
            ),
        )
        .child(Scrollbar.vertical("pr-detail-scroll").absolute().inset_0()),
    );
}
