// Docked right-side Pull Requests panel (GitHub & Bitbucket) + Profiles dialog host.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { appHome, checking, exec, focused, openOverlay, panes, setShared, shared, spaces, theme } from "herdr";
import { formatRelTime, renderDetailView } from "./detail-view.js";
import { normalizeRemoteSlug, discoverRepoRoots, repoName } from "./repos.js";

const DEFAULT_PROFILES = [
  { id: "personal", name: "Personal" },
  { id: "work", name: "Work" },
];

export default class PrsPanel extends View {
  init(_props, cx) {
    this.tab = "all"; // "mine" | "review" | "all"
    this.selectedKey = null;
    this.detailCache = {};
    this.detailLoading = false;
    this.lastFocusSeq = 0;
    this.sessionRepos = []; // repos of the workspace: [{ root, name, repoSlug, branch }]
    this.sessionKey = null;
    this.sessionLoading = false;
    this.repoFilter = null; // repoSlug or null (all)
    this.copiedField = null;
    this.wtBusy = false;
    this.wtStatus = null;
    this.showAgentPicker = false;
    this.showDescription = false;
    this.searchQuery = "";

    this.searchInput = InputState.new({ placeholder: "Filter PRs…" });
    this.searchInput.on("change", (_e, cx) => {
      this.searchQuery = this.searchInput.value().trim().toLowerCase();
      cx.notify();
    });
    cx.timer.every(10000, (cx) => this.refreshSession(cx, true));
  }

  profileList() {
    const list = shared("space-folders")?.[""]?.profiles;
    return Array.isArray(list) && list.length ? list : DEFAULT_PROFILES;
  }

  activeSpaceProfile() {
    const p = shared("space-folders.profile");
    return p && this.profileList().some((x) => x.id === p) ? p : null;
  }

  // The profile filter is owned by the Spaces list (All / Personal / Work); no local override.
  effectiveProfile() {
    return this.activeSpaceProfile();
  }

  openProfilesModal(selectId) {
    openOverlay({
      mod: "settings-custom",
      kind: "dialog",
      width: 900,
      height: 640,
      props: { section: "git", selectProfile: selectId ?? this.activeSpaceProfile() },
    });
  }

  loadDetail(pr, cx) {
    if (!pr || checking() || this.detailLoading) return;
    if (this.detailCache[pr.key]?.ok) return;
    this.detailLoading = true;
    const helper = `${appHome()}/mods/prs-panel/forge-helper.py`;
    cx.spawn(async (cx) => {
      try {
        const res = await exec("python3", [
          helper,
          "detail",
          "--profile", pr.profileId,
          "--provider", pr.provider,
          "--repo", pr.repo,
          "--number", String(pr.number),
        ]);
        if (res.code !== 0) throw new Error(res.stderr || "detail failed");
        this.detailCache[pr.key] = JSON.parse(res.stdout);
      } catch (e) {
        this.detailCache[pr.key] = { ok: false, error: String(e) };
      } finally {
        this.detailLoading = false;
        cx.notify();
      }
    });
  }

  focusLocation() {
    const space = spaces().find((s) => s.active);
    const f = focused();
    const allPanes = panes();
    const pane = f?.pane ? allPanes.find((p) => p.pane === f.pane) : null;
    const spaceTabIds = new Set((space?.tabs ?? []).map((t) => t.id));
    const cwd = pane?.cwd || f?.cwd || allPanes.find((p) => spaceTabIds.has(p.tab) && p.cwd)?.cwd || space?.folder || null;
    return { cwd, folder: space?.folder ?? null, on: space?.machine ?? null };
  }

  // Every repo of the workspace with its current branch (one entry for a single-repo space).
  // Re-reads on a focus/folder change and on the 10 s timer, because branches move.
  refreshSession(cx, force = false) {
    if (checking() || this.sessionLoading) return;
    const { cwd, folder, on } = this.focusLocation();
    if (!cwd) return;
    const key = JSON.stringify([cwd, folder, on]);
    if (!force && key === this.sessionKey) return;
    this.sessionKey = key;
    this.sessionLoading = true;
    const git = (root, args) => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: root, on });
    cx.spawn(async (cx) => {
      try {
        const roots = await discoverRepoRoots(exec, { cwd, folder, on });
        const list = await Promise.all(
          roots.map(async (root) => {
            const [url, br] = await Promise.all([git(root, ["config", "--get", "remote.origin.url"]), git(root, ["rev-parse", "--abbrev-ref", "HEAD"])]);
            return {
              root,
              name: repoName(root),
              repoSlug: url.code === 0 ? normalizeRemoteSlug(url.stdout) : null,
              branch: br.code === 0 ? br.stdout.trim() || null : null,
            };
          }),
        );
        if (this.sessionKey === key) this.sessionRepos = list;
      } catch {
        if (this.sessionKey === key) this.sessionRepos = [];
      } finally {
        this.sessionLoading = false;
        cx.notify();
      }
    });
  }

  renderPrCard(pr, t, showProfilePill, isActiveBranch, cx) {
    const ciColor = pr.ciState === "failure" ? t.ansi1 : pr.ciState === "success" ? t.ansi2 : pr.ciState === "pending" ? t.working : t.dim;
    const ciMark = pr.ciState === "failure" ? "✕ CI" : pr.ciState === "success" ? "✓ CI" : pr.ciState === "pending" ? "● CI" : null;
    const revColor = pr.reviewState === "changes_requested" ? t.ansi1 : pr.reviewState === "approved" ? t.ansi2 : t.blocked;
    const revText = pr.reviewState === "changes_requested"
      ? "! Changes"
      : pr.reviewState === "approved"
        ? `✓ ${pr.approvals}`
        : pr.isReviewRequested
          ? "Review you"
          : "Pending";
    const profName = this.profileList().find((x) => x.id === pr.profileId)?.name ?? pr.profileId;

    return v_flex()
      .id(`pr-row-${pr.key}`)
      .flex_none()
      .p(9)
      .gap(5)
      .rounded(8)
      .cursor_pointer()
      .border_1()
      .border_color(isActiveBranch ? t.accent : t.border)
      .bg(isActiveBranch ? t.selected : t.chrome)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.selectedKey = pr.key;
        this.showAgentPicker = false;
        this.showDescription = false;
        this.loadDetail(pr, cx);
        cx.notify();
      })
      // Row 1: provider icon, repo #num, badges, time
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(svg(`mods/prs-panel/${pr.provider}.svg`).size(12).flex_none().text_color(t.muted))
          .child(div().min_w(0).truncate().text_size(11).font_medium().text_color(t.muted).child(`${pr.repoShort} #${pr.number}`))
          .when(pr.draft, (el) => el.child(div().px(4).py(1).rounded(4).bg(t.raised).text_size(9.5).text_color(t.dim).child("Draft")))
          .when(showProfilePill, (el) => el.child(div().px(4).py(1).rounded(4).bg(t.raised).text_size(9.5).text_color(t.dim).child(profName)))
          .child(div().flex_1())
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(formatRelTime(pr.updatedAt))),
      )
      // Row 2: title
      .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(pr.title))
      // Row 3: CI, review, conflicts, comments/tasks, diffstats
      .child(
        h_flex()
          .gap(5)
          .flex_wrap()
          .items_center()
          .when(Boolean(ciMark), (el) =>
            el.child(div().px(5).py(1).rounded(4).bg(ciColor + "20").text_size(10).font_medium().text_color(ciColor).child(ciMark)),
          )
          .child(div().px(5).py(1).rounded(4).bg(revColor + "20").text_size(10).font_medium().text_color(revColor).child(revText))
          .when(pr.conflicts === true, (el) =>
            el.child(div().px(5).py(1).rounded(4).bg(t.ansi1 + "20").text_size(10).text_color(t.ansi1).child("Conflict")),
          )
          .when(pr.commentCount > 0 || pr.unresolvedCount > 0, (el) =>
            el.child(
              div()
                .text_size(10.5)
                .text_color(pr.unresolvedCount > 0 ? t.blocked : t.dim)
                .child(pr.unresolvedCount > 0 ? `☐ ${pr.unresolvedCount} · ${pr.commentCount} cmt` : `${pr.commentCount} cmt`),
            ),
          )
          .child(div().flex_1())
          .when(pr.additions > 0 || pr.deletions > 0, (el) =>
            el.child(
              h_flex()
                .gap(4)
                .text_size(10.5)
                .child(div().text_color(t.ansi2).child(`+${pr.additions}`))
                .child(div().text_color(t.ansi1).child(`−${pr.deletions}`)),
            ),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const state = shared("forge.state") ?? {};
    const loading = Boolean(shared("forge.loading"));
    const allPrs = state.prs ?? [];

    // Handle jump requests from status bar, space-folders, changes-tabs, or notifications
    const focusReq = shared("forge.focusPrKey");
    if (focusReq?.seq && focusReq.seq > this.lastFocusSeq) {
      this.lastFocusSeq = focusReq.seq;
      if (focusReq.key) {
        const target = allPrs.find((p) => p.key === focusReq.key);
        this.selectedKey = focusReq.key;
        this.showAgentPicker = false;
        this.showDescription = false;
        if (target && !checking()) this.loadDetail(target, cx);
      }
    }

    const activeProf = this.activeSpaceProfile();
    const effectiveProf = this.effectiveProfile();
    const profiles = this.profileList();
    const activeProfName = effectiveProf ? (profiles.find((p) => p.id === effectiveProf)?.name ?? effectiveProf) : "All";
    const configured = state.configuredProfiles ?? [];
    const inScopeConfigured = effectiveProf ? configured.includes(effectiveProf) : configured.length > 0;

    const scopedPrs = effectiveProf ? allPrs.filter((p) => p.profileId === effectiveProf) : allPrs;
    const mineCount = scopedPrs.filter((p) => p.isMine).length;
    const revCount = scopedPrs.filter((p) => p.isReviewRequested && !p.isMine).length;

    this.refreshSession(cx);
    const sessionRepos = this.sessionRepos;
    const multiRepo = sessionRepos.length > 1;
    if (this.repoFilter && !sessionRepos.some((r) => r.repoSlug === this.repoFilter)) this.repoFilter = null;
    // One PR per repo whose current branch has one open (a card that touches 3 repos shows 3 PRs here).
    const activeKeys = new Set(
      sessionRepos.map((r) => (r.repoSlug && r.branch ? state.byBranch?.[`${r.repoSlug}::${r.branch}`]?.key ?? null : null)).filter(Boolean),
    );
    const prSlug = (p) => `${p.provider}:${String(p.repo ?? "").toLowerCase()}`;

    const filtered = scopedPrs.filter((p) => {
      if (this.tab === "mine" && !p.isMine) return false;
      if (this.tab === "review" && !(p.isReviewRequested && !p.isMine)) return false;
      if (this.repoFilter && prSlug(p) !== this.repoFilter) return false;
      if (this.searchQuery) {
        const hay = `${p.title} ${p.repo} ${p.sourceBranch} ${p.author} #${p.number}`.toLowerCase();
        if (!hay.includes(this.searchQuery)) return false;
      }
      return true;
    });

    const activeBranchPrs = allPrs.filter((p) => activeKeys.has(p.key) && (!this.repoFilter || prSlug(p) === this.repoFilter));
    const restPrs = filtered.filter((p) => !activeKeys.has(p.key));
    const selectedPr = this.selectedKey ? allPrs.find((p) => p.key === this.selectedKey) ?? null : null;

    const scopedErrors = Object.entries(state.errors ?? {}).filter(([k]) => !effectiveProf || k.startsWith(`${effectiveProf}:`));

    const iconBtn = (id, labelOrSvg, tip, action) =>
      div()
        .id(id)
        .size(26)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .cursor_pointer()
        .text_color(t.muted)
        .tooltip(tip)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(action)
        .child(labelOrSvg);

    const filterChip = (id, label, active, action) =>
      div()
        .id(id)
        .px(8)
        .py(3)
        .rounded(6)
        .cursor_pointer()
        .text_size(11.5)
        .bg(active ? t.selected : t.background)
        .border_1()
        .border_color(active ? t.accent : t.border)
        .text_color(active ? t.foreground : t.muted)
        .when(active, (e) => e.font_medium())
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(action)
        .child(label);

    return v_flex()
      .id("prs-panel")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      // Header (matches files-tabs & changes-tabs 42px)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("PRs"))
          .child(div().flex_1())
          .child(
            iconBtn(
              "prs-refresh",
              loading ? svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.working).spin(900) : div().text_size(13).child("↻"),
              "Refresh PRs",
              () => setShared("forge.refreshReq", Date.now()),
            ),
          )
          .child(
            iconBtn(
              "prs-settings",
              svg("mods/workspace-chrome/settings.svg").size(14),
              "Configure profiles & GitHub/Bitbucket",
              () => this.openProfilesModal(activeProf),
            ),
          ),
      )
      // Detail view or List view
      .when(Boolean(selectedPr), (el) =>
        el.child(renderDetailView(this, selectedPr, this.detailCache[selectedPr.key] ?? null, t, cx)),
      )
      .when(!selectedPr, (el) =>
        el
          // Filter tabs & search
          .child(
            v_flex()
              .flex_none()
              .p(10)
              .gap(8)
              .border_b(1)
              .border_color(t.border)
              .child(
                h_flex()
                  .gap(6)
                  .child(filterChip("prs-tab-all", `All (${scopedPrs.length})`, this.tab === "all", (_e, cx) => { this.tab = "all"; cx.notify(); }))
                  .child(filterChip("prs-tab-mine", `Mine (${mineCount})`, this.tab === "mine", (_e, cx) => { this.tab = "mine"; cx.notify(); }))
                  .child(filterChip("prs-tab-rev", `Review (${revCount})`, this.tab === "review", (_e, cx) => { this.tab = "review"; cx.notify(); })),
              )
              .when(multiRepo, (e2) =>
                e2.child(
                  h_flex()
                    .gap(6)
                    .flex_wrap()
                    .child(filterChip("prs-repo-all", "All repos", !this.repoFilter, (_e, cx) => { this.repoFilter = null; cx.notify(); }))
                    .children(
                      sessionRepos
                        .filter((r) => r.repoSlug)
                        .map((r) => filterChip(`prs-repo-${r.root}`, r.name, this.repoFilter === r.repoSlug, (_e, cx) => { this.repoFilter = this.repoFilter === r.repoSlug ? null : r.repoSlug; cx.notify(); })),
                    ),
                ),
              )
              .child(
                div()
                  .h(30)
                  .px(9)
                  .flex()
                  .items_center()
                  .rounded(7)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.chrome)
                  .child(Input.new(this.searchInput).w_full().text_size(12).text_color(t.foreground)),
              ),
          )
          // Non-blocking error banner
          .when(scopedErrors.length > 0, (e2) =>
            e2.child(
              h_flex()
                .flex_none()
                .px(12)
                .py(8)
                .gap(8)
                .items_center()
                .bg(t.ansi1 + "1a")
                .border_b(1)
                .border_color(t.ansi1 + "44")
                .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.ansi1).child(scopedErrors.map(([k, v]) => `${k}: ${v}`).join(" | ")))
                .child(
                  div()
                    .id("prs-fix-cfg")
                    .flex_none()
                    .px(7)
                    .py(2)
                    .rounded(5)
                    .cursor_pointer()
                    .bg(t.raised)
                    .text_size(11)
                    .text_color(t.foreground)
                    .on_click(() => this.openProfilesModal(activeProf))
                    .child("Fix config"),
                ),
            ),
          )
          // Main scrollable list
          .child(
            div()
              .flex_1()
              .min_h(0)
              .relative()
              .child(
                v_flex()
                  .id("prs-list")
                  .absolute()
                  .inset_0()
                  .overflow_y_scroll()
                  .p(8)
                  .gap(7)
                  .when(!inScopeConfigured && filtered.length === 0, (e2) =>
                    e2.child(
                      v_flex()
                        .p(14)
                        .gap(10)
                        .rounded(9)
                        .bg(t.chrome)
                        .border_1()
                        .border_color(t.border)
                        .child(div().text_size(13).font_semibold().child(`No forge accounts enabled for ${activeProfName}`))
                        .child(
                          div()
                            .text_size(12)
                            .text_color(t.muted)
                            .child("Link GitHub or Bitbucket Cloud to your profiles to track open PRs, CI status, reviews, and alerts."),
                        )
                        .child(
                          h_flex()
                            .pt(2)
                            .child(
                              div()
                                .id("prs-empty-cfg")
                                .px(12)
                                .py(6)
                                .rounded(7)
                                .cursor_pointer()
                                .bg(t.solid)
                                .text_size(12)
                                .font_medium()
                                .text_color(t.solid_foreground)
                                .hover((s) => s.opacity(0.9))
                                .on_click(() => this.openProfilesModal(activeProf))
                                .child("Configure GitHub / Bitbucket"),
                            ),
                        ),
                    ),
                  )
                  .when(inScopeConfigured && filtered.length === 0 && activeBranchPrs.length === 0, (e2) =>
                    e2.child(
                      div()
                        .p(12)
                        .text_size(12)
                        .text_color(t.dim)
                        .child(loading ? "Syncing pull requests…" : "No matching open pull requests"),
                    ),
                  )
                  .when(activeBranchPrs.length > 0, (e2) =>
                    e2
                      .child(div().px(4).text_size(10.5).font_semibold().text_color(t.accent).child(multiRepo ? "ACTIVE BRANCHES" : "ACTIVE BRANCH"))
                      .children(activeBranchPrs.map((pr) => this.renderPrCard(pr, t, !effectiveProf, true, cx))),
                  )
                  .when(activeBranchPrs.length > 0 && restPrs.length > 0, (e2) =>
                    e2.child(div().px(4).pt(4).text_size(10.5).font_semibold().text_color(t.dim).child("OTHER PULL REQUESTS")),
                  )
                  .children(restPrs.map((pr) => this.renderPrCard(pr, t, !effectiveProf, false, cx))),
              )
              .child(Scrollbar.vertical("prs-list").absolute().inset_0()),
          )
          // Footer
          .child(
            h_flex()
              .h(26)
              .flex_none()
              .px(12)
              .items_center()
              .justify_between()
              .border_t(1)
              .border_color(t.border)
              .bg(t.chrome)
              .text_size(10.5)
              .text_color(t.dim)
              .child(state.updatedAt ? `Updated ${formatRelTime(state.updatedAt)}` : loading ? "Syncing…" : "Not synced yet")
              .child(`${scopedPrs.length} open`),
          ),
      );
  }
}
