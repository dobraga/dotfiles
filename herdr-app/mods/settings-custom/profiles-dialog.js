// Unified Profiles & Git Accounts (GitHub / Bitbucket Cloud) management dialog.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { appHome, closeOverlay, exec, home, props, setShared, shared, theme, checking } from "herdr";
import * as fs from "fs/promises";

const SPACE_FOLDERS_FILE = "~/.config/herdr-space-folders.json";
const DEFAULT_PROFILES = [
  { id: "personal", name: "Personal" },
  { id: "work", name: "Work" },
];

const emptyGh = () => ({
  enabled: false,
  username: "",
  orgs: [],
  repos: [],
  authMode: "env",
  envVar: "GITHUB_TOKEN",
  apiBase: "https://api.github.com",
  hasToken: false,
  tokenPreview: "",
  envFound: false,
  pendingToken: "",
  tokenAction: "keep",
});

const emptyBb = () => ({
  enabled: false,
  workspace: "",
  username: "",
  repos: [],
  authMode: "env",
  userEnvVar: "BB_USER",
  tokenEnvVar: "BB_TOKEN",
  user: "",
  hasToken: false,
  tokenPreview: "",
  userEnvFound: false,
  tokenEnvFound: false,
  pendingToken: "",
  tokenAction: "keep",
});

function cloneProfileForge(raw) {
  const g = raw?.github ?? {};
  const b = raw?.bitbucket ?? {};
  return {
    github: {
      ...emptyGh(),
      ...g,
      orgs: Array.isArray(g.orgs) ? [...g.orgs] : [],
      repos: Array.isArray(g.repos) ? [...g.repos] : [],
      pendingToken: "",
      tokenAction: "keep",
    },
    bitbucket: {
      ...emptyBb(),
      ...b,
      repos: Array.isArray(b.repos) ? [...b.repos] : [],
      pendingToken: "",
      tokenAction: "keep",
    },
  };
}

function splitCsv(text) {
  return String(text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export class ProfilesDialogController {
  constructor(cx, options = {}) {
    const p = props() ?? {};
    this.overlay = p.overlay;
    this.embedded = Boolean(options?.embedded);
    this.helperPath = `${appHome()}/mods/prs-panel/forge-helper.py`;
    this.loaded = false;
    this.loading = !checking() && !options?.deferLoad;
    this.saving = false;
    this.savedBanner = null;
    this.detecting = false;
    this.testingGh = false;
    this.testingBb = false;
    this.ghTestResult = null;
    this.bbTestResult = null;
    this.detectBanner = null;
    this.error = null;
    this.confirmDelete = false;
    this.showGhToken = false;
    this.showBbToken = false;
    this.syncingInputs = false;

    const sfLocal = shared("space-folders")?.[""] ?? {};
    const initialProfiles = Array.isArray(sfLocal.profiles) && sfLocal.profiles.length
      ? sfLocal.profiles.map((x) => ({ ...x }))
      : DEFAULT_PROFILES.map((x) => ({ ...x }));

    const initSelect = options?.selectProfile ?? p.selectProfile;
    this.profiles = initialProfiles;
    this.selectedId = (initSelect && initialProfiles.some((x) => x.id === initSelect))
      ? initSelect
      : (initialProfiles[0]?.id ?? "personal");

    this.pollIntervalSec = 90;
    this.notifications = { enabled: true, ci: true, reviews: true, comments: true, reviewRequests: true };
    this.draftForge = {};
    for (const prof of this.profiles) {
      this.draftForge[prof.id] = cloneProfileForge(null);
    }

    // Allocate all InputState instances once in init (never inside render).
    this.nameInput = InputState.new({ placeholder: "Profile name" });
    this.ghUsernameInput = InputState.new({ placeholder: "e.g. dobraga (empty = @me)" });
    this.ghEnvVarInput = InputState.new({ placeholder: "GITHUB_TOKEN" });
    this.ghTokenInput = InputState.new({ placeholder: "ghp_... (stored local chmod 600)" });
    this.ghTokenInput.set_masked(true);
    this.ghOrgsInput = InputState.new({ placeholder: "Optional: org1, org2" });
    this.ghReposInput = InputState.new({ placeholder: "Optional: owner/repo1, owner/repo2" });

    this.bbWorkspaceInput = InputState.new({ placeholder: "e.g. tricura" });
    this.bbUsernameInput = InputState.new({ placeholder: "Optional username / account" });
    this.bbUserEnvVarInput = InputState.new({ placeholder: "BB_USER" });
    this.bbTokenEnvVarInput = InputState.new({ placeholder: "BB_TOKEN" });
    this.bbBasicUserInput = InputState.new({ placeholder: "Atlassian email or username" });
    this.bbTokenInput = InputState.new({ placeholder: "Token (stored local chmod 600)" });
    this.bbTokenInput.set_masked(true);
    this.bbReposInput = InputState.new({ placeholder: "Optional: repo1, repo2" });

    this.bindInputHandlers();
    this.loadInputsForSelected();

    if (checking() || options?.deferLoad) return;
    this.loadAll(cx);
  }

  ensureLoaded(cx, selectProfileId = null) {
    if (selectProfileId && this.profiles.some((x) => x.id === selectProfileId)) {
      this.selectedId = selectProfileId;
      this.loadInputsForSelected();
    }
    if (checking() || this.loaded || this.loading) return;
    this.loading = true;
    this.loadAll(cx);
  }

  bindInputHandlers() {
    const syncText = (fn) => (_e, cx) => {
      if (this.syncingInputs) return;
      fn();
      cx.notify();
    };
    this.nameInput.on("change", syncText(() => {
      const p = this.profiles.find((x) => x.id === this.selectedId);
      if (p) p.name = this.nameInput.value();
    }));
    this.ghUsernameInput.on("change", syncText(() => {
      this.currentForge().github.username = this.ghUsernameInput.value().trim();
    }));
    this.ghEnvVarInput.on("change", syncText(() => {
      this.currentForge().github.envVar = this.ghEnvVarInput.value().trim();
    }));
    this.ghTokenInput.on("change", syncText(() => {
      const val = this.ghTokenInput.value().trim();
      const gh = this.currentForge().github;
      gh.pendingToken = val;
      if (val) gh.tokenAction = "set";
      else if (gh.tokenAction === "set") gh.tokenAction = "keep";
    }));
    this.ghOrgsInput.on("change", syncText(() => {
      this.currentForge().github.orgs = splitCsv(this.ghOrgsInput.value());
    }));
    this.ghReposInput.on("change", syncText(() => {
      this.currentForge().github.repos = splitCsv(this.ghReposInput.value());
    }));

    this.bbWorkspaceInput.on("change", syncText(() => {
      this.currentForge().bitbucket.workspace = this.bbWorkspaceInput.value().trim();
    }));
    this.bbUsernameInput.on("change", syncText(() => {
      this.currentForge().bitbucket.username = this.bbUsernameInput.value().trim();
    }));
    this.bbUserEnvVarInput.on("change", syncText(() => {
      this.currentForge().bitbucket.userEnvVar = this.bbUserEnvVarInput.value().trim();
    }));
    this.bbTokenEnvVarInput.on("change", syncText(() => {
      this.currentForge().bitbucket.tokenEnvVar = this.bbTokenEnvVarInput.value().trim();
    }));
    this.bbBasicUserInput.on("change", syncText(() => {
      this.currentForge().bitbucket.user = this.bbBasicUserInput.value().trim();
    }));
    this.bbTokenInput.on("change", syncText(() => {
      const val = this.bbTokenInput.value().trim();
      const bb = this.currentForge().bitbucket;
      bb.pendingToken = val;
      if (val) bb.tokenAction = "set";
      else if (bb.tokenAction === "set") bb.tokenAction = "keep";
    }));
    this.bbReposInput.on("change", syncText(() => {
      this.currentForge().bitbucket.repos = splitCsv(this.bbReposInput.value());
    }));
  }

  currentForge() {
    this.draftForge[this.selectedId] ??= cloneProfileForge(null);
    return this.draftForge[this.selectedId];
  }

  loadInputsForSelected() {
    const prof = this.profiles.find((x) => x.id === this.selectedId);
    const f = this.currentForge();
    this.syncingInputs = true;
    try {
      this.nameInput.set_value(prof?.name ?? "");
      this.ghUsernameInput.set_value(f.github.username ?? "");
      this.ghEnvVarInput.set_value(f.github.envVar ?? "GITHUB_TOKEN");
      this.ghTokenInput.set_value(f.github.pendingToken ?? "");
      this.ghOrgsInput.set_value((f.github.orgs ?? []).join(", "));
      this.ghReposInput.set_value((f.github.repos ?? []).join(", "));

      this.bbWorkspaceInput.set_value(f.bitbucket.workspace ?? "");
      this.bbUsernameInput.set_value(f.bitbucket.username ?? "");
      this.bbUserEnvVarInput.set_value(f.bitbucket.userEnvVar ?? "BB_USER");
      this.bbTokenEnvVarInput.set_value(f.bitbucket.tokenEnvVar ?? "BB_TOKEN");
      this.bbBasicUserInput.set_value(f.bitbucket.user ?? "");
      this.bbTokenInput.set_value(f.bitbucket.pendingToken ?? "");
      this.bbReposInput.set_value((f.bitbucket.repos ?? []).join(", "));
    } finally {
      this.syncingInputs = false;
    }
  }

  selectProfile(id, cx) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.confirmDelete = false;
    this.ghTestResult = null;
    this.bbTestResult = null;
    this.detectBanner = null;
    this.loadInputsForSelected();
    cx.notify();
  }

  loadAll(cx) {
    cx.spawn(async (cx) => {
      try {
        const [sfRes, cfgRes] = await Promise.all([
          exec("sh", ["-c", `cat ${SPACE_FOLDERS_FILE} 2>/dev/null`]).catch(() => null),
          exec("python3", [this.helperPath, "get-config"]),
        ]);
        if (sfRes?.code === 0 && sfRes.stdout.trim()) {
          try {
            const parsedSf = JSON.parse(sfRes.stdout);
            if (Array.isArray(parsedSf.profiles) && parsedSf.profiles.length) {
              this.profiles = parsedSf.profiles.map((x) => ({ ...x }));
              if (!this.profiles.some((x) => x.id === this.selectedId)) {
                this.selectedId = this.profiles[0].id;
              }
            }
          } catch {}
        }
        if (cfgRes?.code === 0) {
          const cfg = JSON.parse(cfgRes.stdout);
          this.pollIntervalSec = cfg.pollIntervalSec ?? 90;
          this.notifications = { ...this.notifications, ...(cfg.notifications ?? {}) };
          for (const prof of this.profiles) {
            this.draftForge[prof.id] = cloneProfileForge(cfg.profiles?.[prof.id]);
          }
          for (const [pid, pcfg] of Object.entries(cfg.profiles ?? {})) {
            this.draftForge[pid] ??= cloneProfileForge(pcfg);
          }
        }
        this.loadInputsForSelected();
      } catch (e) {
        this.error = String(e);
      } finally {
        this.loaded = true;
        this.loading = false;
        cx.notify();
      }
    });
  }

  async writeSpaceFoldersProfiles(nextProfiles, cleanDeletedId = null) {
    const sfAll = shared("space-folders") ?? {};
    let current = sfAll[""] ?? null;
    if (!current) {
      const r = await exec("sh", ["-c", `cat ${SPACE_FOLDERS_FILE} 2>/dev/null`]).catch(() => null);
      if (r?.code === 0 && r.stdout.trim()) {
        try { current = JSON.parse(r.stdout); } catch {}
      }
    }
    const base = {
      list: current?.list ?? [],
      of: current?.of ?? {},
      spaceProfiles: current?.spaceProfiles ?? {},
    };
    const nextList = cleanDeletedId
      ? base.list.map((f) => (f.profile === cleanDeletedId ? { ...f, profile: null } : f))
      : base.list;
    const nextSpaceProfs = cleanDeletedId
      ? Object.fromEntries(Object.entries(base.spaceProfiles).filter(([, v]) => v !== cleanDeletedId))
      : base.spaceProfiles;
    const next = {
      ...base,
      list: nextList,
      spaceProfiles: nextSpaceProfs,
      profiles: nextProfiles,
      at: Date.now(),
    };
    setShared("space-folders", { ...sfAll, "": next });
    await exec("sh", [
      "-c",
      `mkdir -p ~/.config && printf '%s\\n' "$1" > ${SPACE_FOLDERS_FILE}.tmp && mv ${SPACE_FOLDERS_FILE}.tmp ${SPACE_FOLDERS_FILE}`,
      "sh",
      JSON.stringify(next),
    ]);
  }

  createProfile(cx) {
    const newId = `p${Date.now().toString(36)}`;
    const newProf = { id: newId, name: "New profile" };
    this.profiles = [...this.profiles, newProf];
    this.draftForge[newId] = cloneProfileForge(null);
    this.selectedId = newId;
    this.confirmDelete = false;
    this.ghTestResult = null;
    this.bbTestResult = null;
    this.loadInputsForSelected();
    this.nameInput.set_selected_range({ start: 0, end: newProf.name.length });
    this.nameInput.focus();
    cx.notify();
  }

  deleteSelectedProfile(cx) {
    if (this.profiles.length <= 1) {
      this.error = "At least one profile must exist.";
      this.confirmDelete = false;
      cx.notify();
      return;
    }
    const targetId = this.selectedId;
    const remaining = this.profiles.filter((p) => p.id !== targetId);
    this.profiles = remaining;
    delete this.draftForge[targetId];
    this.selectedId = remaining[0].id;
    this.confirmDelete = false;
    this.loadInputsForSelected();
    cx.spawn(async (cx) => {
      try {
        await this.writeSpaceFoldersProfiles(remaining, targetId);
        if (shared("space-folders.profile") === targetId) {
          localStorage.setItem("space-folders.profile", "");
          setShared("space-folders.profile", null);
        }
        await exec("python3", [this.helperPath, "delete-profile", "--id", targetId]);
        setShared("forge.refreshReq", Date.now());
      } catch (e) {
        this.error = String(e);
      } finally {
        cx.notify();
      }
    });
    cx.notify();
  }

  autoDetect(cx) {
    if (this.detecting) return;
    this.detecting = true;
    this.detectBanner = null;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.writeSpaceFoldersProfiles(this.profiles);
        const res = await exec("python3", [this.helperPath, "detect"]);
        if (res.code !== 0) throw new Error(res.stderr || "detect failed");
        const parsed = JSON.parse(res.stdout);
        const sug = parsed.suggestions?.[this.selectedId];
        if (!sug) {
          this.detectBanner = "No matching local repos found for this profile.";
        } else {
          const cur = this.currentForge();
          if (sug.github?.enabled) {
            cur.github.enabled = true;
            cur.github.authMode = sug.github.authMode || cur.github.authMode;
            if (sug.github.envVar) cur.github.envVar = sug.github.envVar;
            if (sug.github.username && !cur.github.username) cur.github.username = sug.github.username;
          }
          if (sug.bitbucket?.enabled) {
            cur.bitbucket.enabled = true;
            cur.bitbucket.authMode = sug.bitbucket.authMode || cur.bitbucket.authMode;
            if (sug.bitbucket.workspace) cur.bitbucket.workspace = sug.bitbucket.workspace;
            if (sug.bitbucket.userEnvVar) cur.bitbucket.userEnvVar = sug.bitbucket.userEnvVar;
            if (sug.bitbucket.tokenEnvVar) cur.bitbucket.tokenEnvVar = sug.bitbucket.tokenEnvVar;
            if (sug.bitbucket.username && !cur.bitbucket.username) cur.bitbucket.username = sug.bitbucket.username;
          }
          this.loadInputsForSelected();
          this.detectBanner = sug.reasons?.length
            ? sug.reasons.join(" · ")
            : "No GitHub/Bitbucket remotes detected for this profile's folders.";
        }
      } catch (e) {
        this.error = String(e);
      } finally {
        this.detecting = false;
        cx.notify();
      }
    });
  }

  buildProviderPayload(provider, cfg) {
    if (provider === "github") {
      return {
        enabled: Boolean(cfg.enabled),
        username: cfg.username ?? "",
        orgs: cfg.orgs ?? [],
        repos: cfg.repos ?? [],
        authMode: cfg.authMode ?? "env",
        envVar: cfg.envVar || "GITHUB_TOKEN",
        apiBase: cfg.apiBase || "https://api.github.com",
        token: cfg.tokenAction === "set" ? (cfg.pendingToken ?? "") : "",
        tokenAction: cfg.tokenAction ?? "keep",
      };
    }
    return {
      enabled: Boolean(cfg.enabled),
      workspace: cfg.workspace ?? "",
      username: cfg.username ?? "",
      repos: cfg.repos ?? [],
      authMode: cfg.authMode ?? "env",
      userEnvVar: cfg.userEnvVar || "BB_USER",
      tokenEnvVar: cfg.tokenEnvVar || "BB_TOKEN",
      user: cfg.user ?? "",
      token: cfg.tokenAction === "set" ? (cfg.pendingToken ?? "") : "",
      tokenAction: cfg.tokenAction ?? "keep",
    };
  }

  testProvider(provider, cx) {
    const isGh = provider === "github";
    if ((isGh && this.testingGh) || (!isGh && this.testingBb)) return;
    if (isGh) { this.testingGh = true; this.ghTestResult = null; }
    else { this.testingBb = true; this.bbTestResult = null; }
    cx.notify();

    const pid = this.selectedId;
    const cfg = this.buildProviderPayload(provider, this.currentForge()[provider]);
    cx.spawn(async (cx) => {
      const dir = `${appHome()}/data/prs-panel`;
      const tmp = `${dir}/.test-${Date.now()}.json`;
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(tmp, JSON.stringify({ provider, profileId: pid, config: cfg }));
        const res = await exec("python3", [this.helperPath, "test", "--from-file", tmp]);
        if (res.code !== 0) throw new Error(res.stderr || "test failed");
        const parsed = JSON.parse(res.stdout);
        if (isGh) {
          this.ghTestResult = parsed;
          if (parsed.ok && parsed.identity && !this.currentForge().github.username) {
            this.currentForge().github.username = parsed.identity;
            if (this.selectedId === pid) this.loadInputsForSelected();
          }
        } else {
          this.bbTestResult = parsed;
          if (parsed.ok && parsed.identity && !this.currentForge().bitbucket.username && parsed.identity !== "(workspace token)") {
            this.currentForge().bitbucket.username = parsed.identity;
            if (this.selectedId === pid) this.loadInputsForSelected();
          }
        }
      } catch (e) {
        const errObj = { ok: false, error: String(e) };
        if (isGh) this.ghTestResult = errObj;
        else this.bbTestResult = errObj;
      } finally {
        if (isGh) this.testingGh = false;
        else this.testingBb = false;
        cx.notify();
      }
    });
  }

  saveAll(cx) {
    if (this.saving) return;
    this.saving = true;
    this.savedBanner = null;
    this.error = null;
    cx.notify();

    const cleanProfiles = this.profiles.map((p) => ({
      id: p.id,
      name: (p.name ?? "").trim() || "Profile",
    }));
    const profilesPayload = {};
    for (const p of cleanProfiles) {
      const f = this.draftForge[p.id] ?? cloneProfileForge(null);
      profilesPayload[p.id] = {
        github: this.buildProviderPayload("github", f.github),
        bitbucket: this.buildProviderPayload("bitbucket", f.bitbucket),
      };
    }

    const payload = {
      pollIntervalSec: this.pollIntervalSec,
      notifications: this.notifications,
      profiles: profilesPayload,
    };

    cx.spawn(async (cx) => {
      const dir = `${appHome()}/data/prs-panel`;
      const tmp = `${dir}/.save-${Date.now()}.json`;
      try {
        await this.writeSpaceFoldersProfiles(cleanProfiles);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(payload));
        const res = await exec("python3", [this.helperPath, "save-config", "--from-file", tmp]);
        if (res.code !== 0) throw new Error(res.stderr || "save-config failed");
        setShared("forge.configVersion", Date.now());
        setShared("forge.refreshReq", Date.now());
        if (this.embedded) {
          this.saving = false;
          this.savedBanner = "Saved & synced.";
          this.loadAll(cx);
          cx.notify();
        } else {
          closeOverlay(this.overlay);
        }
      } catch (e) {
        this.error = String(e);
        this.saving = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const prof = this.profiles.find((x) => x.id === this.selectedId);
    const forge = this.currentForge();
    const gh = forge.github;
    const bb = forge.bitbucket;

    const btn = (id, label, primary, action, disabled = false) =>
      h_flex()
        .id(id)
        .h(30)
        .px(12)
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(7)
        .border_1()
        .border_color(primary ? t.solid : t.input)
        .bg(primary ? t.solid : t.raised)
        .text_color(disabled ? t.dim : primary ? t.solid_foreground : t.foreground)
        .text_size(12)
        .font_medium()
        .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
        .child(label);

    const chip = (id, label, active, action) =>
      div()
        .id(id)
        .px(9)
        .py(4)
        .rounded(6)
        .cursor_pointer()
        .text_size(11.5)
        .border_1()
        .border_color(active ? t.accent : t.border)
        .bg(active ? t.selected : t.background)
        .text_color(active ? t.foreground : t.muted)
        .when(active, (el) => el.font_medium())
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(action)
        .child(label);

    const field = (label, inputState, rightExtra = null, hint = null) =>
      v_flex()
        .gap(5)
        .child(div().text_size(11.5).font_medium().text_color(t.muted).child(label))
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(
              div()
                .flex_1()
                .min_w(0)
                .h(32)
                .px(9)
                .flex()
                .items_center()
                .rounded(7)
                .border_1()
                .border_color(t.input)
                .bg(t.background)
                .child(Input.new(inputState).w_full().text_size(12.5).text_color(t.foreground)),
            )
            .when(Boolean(rightExtra), (el) => el.child(rightExtra)),
        )
        .when(Boolean(hint), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(hint)));

    const testBadge = (res) => {
      if (!res) return null;
      if (res.ok) {
        const extra = [res.identity, res.scopes ? `scopes: ${res.scopes}` : ""].filter(Boolean).join(" · ");
        return div()
          .p(8)
          .rounded(6)
          .bg(t.ansi2 + "1f")
          .border_1()
          .border_color(t.ansi2 + "55")
          .text_size(11.5)
          .text_color(t.ansi2)
          .child(`Connected as ${extra || "verified"}`);
      }
      return v_flex()
        .p(8)
        .gap(3)
        .rounded(6)
        .bg(t.ansi1 + "1f")
        .border_1()
        .border_color(t.ansi1 + "55")
        .text_size(11.5)
        .text_color(t.ansi1)
        .child(res.error || "Connection failed")
        .when(Boolean(res.hint), (el) => el.child(div().text_size(10.5).text_color(t.muted).child(res.hint)));
    };

    const togglePill = (id, on, labelOn, labelOff, onClick) =>
      div()
        .id(id)
        .px(9)
        .py(3)
        .rounded(6)
        .cursor_pointer()
        .text_size(11)
        .font_medium()
        .border_1()
        .border_color(on ? t.ansi2 + "88" : t.border)
        .bg(on ? t.ansi2 + "22" : t.raised)
        .text_color(on ? t.ansi2 : t.dim)
        .hover((s) => s.opacity(0.9))
        .on_click(onClick)
        .child(on ? labelOn : labelOff);

    const root = v_flex()
      .id("profiles-dialog")
      .size_full()
      .when(!this.embedded, (el) =>
        el
          .bg(t.popover)
          .on_key_down((e, cx) => {
            if (e.key === "escape") {
              closeOverlay(this.overlay);
              cx.stop_propagation();
            }
          }),
      )
      .text_color(t.foreground);

    if (!this.embedded) {
      root.child(
        h_flex()
          .h(46)
          .flex_none()
          .px(18)
          .gap(10)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().flex_1().text_size(14.5).font_semibold().child("Profiles & Git Accounts"))
          .child(
            div()
              .id("prof-dlg-close")
              .p(5)
              .rounded(6)
              .cursor_pointer()
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => closeOverlay(this.overlay))
              .child(svg("mods/pane/close.svg").size(13)),
          ),
      );
    }

    return root
      // Body: left rail + right editor
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          // Left profile rail
          .child(
            v_flex()
              .w(this.embedded ? 164 : 188)
              .flex_none()
              .h_full()
              .p(10)
              .gap(4)
              .border_r(1)
              .border_color(t.border)
              .when(!this.embedded, (el) => el.bg(t.chrome))
              .child(div().px(6).pb(4).text_size(11).font_medium().text_color(t.dim).child("PROFILES"))
              .child(
                v_flex()
                  .flex_1()
                  .min_h(0)
                  .gap(3)
                  .overflow_y_scrollbar()
                  .children(
                    this.profiles.map((p) => {
                      const active = p.id === this.selectedId;
                      const pf = this.draftForge[p.id];
                      const hasGh = Boolean(pf?.github?.enabled);
                      const hasBb = Boolean(pf?.bitbucket?.enabled);
                      return h_flex()
                        .id(`dlg-prof-${p.id}`)
                        .h(32)
                        .flex_none()
                        .px(8)
                        .gap(6)
                        .items_center()
                        .rounded(7)
                        .cursor_pointer()
                        .bg(active ? t.selected : t.chrome)
                        .text_color(active ? t.foreground : t.muted)
                        .hover((s) => s.bg(active ? t.selected : t.hover).text_color(t.foreground))
                        .on_click((_e, cx) => this.selectProfile(p.id, cx))
                        .child(div().flex_1().min_w(0).truncate().text_size(12.5).when(active, (e) => e.font_medium()).child(p.name || "Untitled"))
                        .when(hasGh, (e) => e.child(div().px(4).py(1).rounded(4).bg(t.raised).text_size(9.5).text_color(t.muted).child("GH")))
                        .when(hasBb, (e) => e.child(div().px(4).py(1).rounded(4).bg(t.raised).text_size(9.5).text_color(t.muted).child("BB")));
                    }),
                  ),
              )
              .child(
                h_flex()
                  .id("dlg-prof-add")
                  .h(30)
                  .px(8)
                  .gap(6)
                  .items_center()
                  .rounded(7)
                  .cursor_pointer()
                  .border_1()
                  .border_color(t.border)
                  .bg(t.background)
                  .text_size(12)
                  .text_color(t.foreground)
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.createProfile(cx))
                  .child("+")
                  .child("New profile"),
              ),
          )
          // Right scrollable editor
          .child(
            div()
              .flex_1()
              .min_w(0)
              .h_full()
              .relative()
              .child(
                v_flex()
                  .id("prof-editor-scroll")
                  .absolute()
                  .inset_0()
                  .overflow_y_scroll()
                  .p(16)
                  .gap(14)
                  .when(this.loading, (el) => el.child(div().text_size(12).text_color(t.dim).child("Loading configuration…")))
                  // Profile name + delete + auto-detect
                  .child(
                    v_flex()
                      .gap(8)
                      .child(
                        h_flex()
                          .gap(8)
                          .items_end()
                          .child(div().flex_1().min_w(0).child(field("Profile name", this.nameInput)))
                          .when(!this.confirmDelete, (el) =>
                            el.child(
                              btn("dlg-prof-del", "Delete", false, (_e, cx) => {
                                this.confirmDelete = true;
                                cx.notify();
                              }, this.profiles.length <= 1),
                            ),
                          )
                          .when(this.confirmDelete, (el) =>
                            el
                              .child(btn("dlg-prof-del-confirm", "Confirm delete", false, (_e, cx) => this.deleteSelectedProfile(cx)))
                              .child(btn("dlg-prof-del-cancel", "Cancel", false, (_e, cx) => { this.confirmDelete = false; cx.notify(); })),
                          ),
                      )
                      .child(
                        h_flex()
                          .gap(8)
                          .items_center()
                          .child(
                            btn(
                              "dlg-auto-detect",
                              this.detecting ? "Detecting…" : "Auto-detect from repos & ~/.env",
                              false,
                              (_e, cx) => this.autoDetect(cx),
                              this.detecting,
                            ),
                          )
                          .when(Boolean(prof), (el) =>
                            el.child(div().text_size(11).text_color(t.dim).child(`ID: ${prof.id}`)),
                          ),
                      )
                      .when(Boolean(this.detectBanner), (el) =>
                        el.child(
                          div()
                            .p(8)
                            .rounded(6)
                            .bg(t.selected)
                            .border_1()
                            .border_color(t.border)
                            .text_size(11.5)
                            .text_color(t.muted)
                            .child(this.detectBanner),
                        ),
                      ),
                  )
                  // GitHub card
                  .child(
                    v_flex()
                      .p(12)
                      .gap(10)
                      .rounded(9)
                      .bg(t.chrome)
                      .border_1()
                      .border_color(t.border)
                      .child(
                        h_flex()
                          .gap(8)
                          .items_center()
                          .child(svg("mods/prs-panel/github.svg").size(15).text_color(t.foreground))
                          .child(div().flex_1().text_size(13).font_semibold().child("GitHub"))
                          .child(
                            togglePill("gh-toggle", gh.enabled, "Enabled", "Disabled", (_e, cx) => {
                              gh.enabled = !gh.enabled;
                              cx.notify();
                            }),
                          ),
                      )
                      .when(gh.enabled, (el) =>
                        el
                          .child(
                            h_flex()
                              .gap(6)
                              .items_center()
                              .child(div().text_size(11.5).text_color(t.muted).child("Auth:"))
                              .child(
                                chip("gh-auth-env", "Env var (~/.env)", gh.authMode === "env", (_e, cx) => {
                                  gh.authMode = "env";
                                  cx.notify();
                                }),
                              )
                              .child(
                                chip("gh-auth-direct", "Direct token (0600)", gh.authMode === "direct", (_e, cx) => {
                                  gh.authMode = "direct";
                                  cx.notify();
                                }),
                              ),
                          )
                          .when(gh.authMode === "env", (e2) =>
                            e2.child(
                              field(
                                "Token env var",
                                this.ghEnvVarInput,
                                div()
                                  .px(7)
                                  .py(4)
                                  .rounded(5)
                                  .text_size(10.5)
                                  .bg(gh.envFound ? t.ansi2 + "22" : t.raised)
                                  .text_color(gh.envFound ? t.ansi2 : t.dim)
                                  .child(gh.envFound ? "Found" : "Not set"),
                              ),
                            ),
                          )
                          .when(gh.authMode === "direct", (e2) =>
                            e2.child(
                              field(
                                "Personal Access Token",
                                this.ghTokenInput,
                                h_flex()
                                  .gap(4)
                                  .child(
                                    btn("gh-tok-vis", this.showGhToken ? "Hide" : "Show", false, (_e, cx) => {
                                      this.showGhToken = !this.showGhToken;
                                      this.ghTokenInput.set_masked(!this.showGhToken);
                                      cx.notify();
                                    }),
                                  )
                                  .when(gh.hasToken, (b) =>
                                    b.child(
                                      btn("gh-tok-clear", "Clear", false, (_e, cx) => {
                                        gh.tokenAction = "clear";
                                        gh.hasToken = false;
                                        gh.tokenPreview = "";
                                        gh.pendingToken = "";
                                        this.syncingInputs = true;
                                        this.ghTokenInput.set_value("");
                                        this.syncingInputs = false;
                                        cx.notify();
                                      }),
                                    ),
                                  ),
                                gh.hasToken ? `Saved token: ${gh.tokenPreview} (leave blank to keep)` : "Stored only in ~/.config/herdr-forge.json (chmod 600)",
                              ),
                            ),
                          )
                          .child(field("Username (optional)", this.ghUsernameInput))
                          .child(field("Filter Orgs (comma-separated, optional)", this.ghOrgsInput))
                          .child(field("Filter Repos (owner/repo, comma-separated, optional)", this.ghReposInput))
                          .child(
                            h_flex()
                              .gap(8)
                              .items_center()
                              .child(
                                btn("gh-test", this.testingGh ? "Testing…" : "Test GitHub", false, (_e, cx) => this.testProvider("github", cx), this.testingGh),
                              ),
                          )
                          .when(Boolean(this.ghTestResult), (e2) => e2.child(testBadge(this.ghTestResult))),
                      ),
                  )
                  // Bitbucket Cloud card
                  .child(
                    v_flex()
                      .p(12)
                      .gap(10)
                      .rounded(9)
                      .bg(t.chrome)
                      .border_1()
                      .border_color(t.border)
                      .child(
                        h_flex()
                          .gap(8)
                          .items_center()
                          .child(svg("mods/prs-panel/bitbucket.svg").size(15).text_color(t.foreground))
                          .child(div().flex_1().text_size(13).font_semibold().child("Bitbucket Cloud"))
                          .child(
                            togglePill("bb-toggle", bb.enabled, "Enabled", "Disabled", (_e, cx) => {
                              bb.enabled = !bb.enabled;
                              cx.notify();
                            }),
                          ),
                      )
                      .when(bb.enabled, (el) =>
                        el
                          .child(field("Workspace slug", this.bbWorkspaceInput))
                          .child(
                            h_flex()
                              .gap(6)
                              .flex_wrap()
                              .items_center()
                              .child(div().text_size(11.5).text_color(t.muted).child("Auth:"))
                              .child(
                                chip("bb-auth-env", "Env var (BB_USER / BB_TOKEN)", bb.authMode === "env", (_e, cx) => {
                                  bb.authMode = "env";
                                  cx.notify();
                                }),
                              )
                              .child(
                                chip("bb-auth-basic", "Direct Basic", bb.authMode === "basic", (_e, cx) => {
                                  bb.authMode = "basic";
                                  cx.notify();
                                }),
                              )
                              .child(
                                chip("bb-auth-bearer", "Bearer", bb.authMode === "bearer", (_e, cx) => {
                                  bb.authMode = "bearer";
                                  cx.notify();
                                }),
                              ),
                          )
                          .when(bb.authMode === "env", (e2) =>
                            e2
                              .child(
                                field(
                                  "User env var",
                                  this.bbUserEnvVarInput,
                                  div()
                                    .px(7)
                                    .py(4)
                                    .rounded(5)
                                    .text_size(10.5)
                                    .bg(bb.userEnvFound ? t.ansi2 + "22" : t.raised)
                                    .text_color(bb.userEnvFound ? t.ansi2 : t.dim)
                                    .child(bb.userEnvFound ? "Found" : "Not set"),
                                ),
                              )
                              .child(
                                field(
                                  "Token env var",
                                  this.bbTokenEnvVarInput,
                                  div()
                                    .px(7)
                                    .py(4)
                                    .rounded(5)
                                    .text_size(10.5)
                                    .bg(bb.tokenEnvFound ? t.ansi2 + "22" : t.raised)
                                    .text_color(bb.tokenEnvFound ? t.ansi2 : t.dim)
                                    .child(bb.tokenEnvFound ? "Found" : "Not set"),
                                ),
                              ),
                          )
                          .when(bb.authMode === "basic", (e2) => e2.child(field("User / Atlassian Email", this.bbBasicUserInput)))
                          .when(bb.authMode === "basic" || bb.authMode === "bearer", (e2) =>
                            e2.child(
                              field(
                                bb.authMode === "bearer" ? "Access Token (Bearer)" : "App Password / API Token",
                                this.bbTokenInput,
                                h_flex()
                                  .gap(4)
                                  .child(
                                    btn("bb-tok-vis", this.showBbToken ? "Hide" : "Show", false, (_e, cx) => {
                                      this.showBbToken = !this.showBbToken;
                                      this.bbTokenInput.set_masked(!this.showBbToken);
                                      cx.notify();
                                    }),
                                  )
                                  .when(bb.hasToken, (b) =>
                                    b.child(
                                      btn("bb-tok-clear", "Clear", false, (_e, cx) => {
                                        bb.tokenAction = "clear";
                                        bb.hasToken = false;
                                        bb.tokenPreview = "";
                                        bb.pendingToken = "";
                                        this.syncingInputs = true;
                                        this.bbTokenInput.set_value("");
                                        this.syncingInputs = false;
                                        cx.notify();
                                      }),
                                    ),
                                  ),
                                bb.hasToken ? `Saved token: ${bb.tokenPreview} (leave blank to keep)` : "Stored only in ~/.config/herdr-forge.json (chmod 600)",
                              ),
                            ),
                          )
                          .child(field("Username / Nickname filter (optional)", this.bbUsernameInput))
                          .child(field("Filter Repos (comma-separated, optional)", this.bbReposInput))
                          .child(
                            h_flex()
                              .gap(8)
                              .items_center()
                              .child(
                                btn("bb-test", this.testingBb ? "Testing…" : "Test Bitbucket", false, (_e, cx) => this.testProvider("bitbucket", cx), this.testingBb),
                              ),
                          )
                          .when(Boolean(this.bbTestResult), (e2) => e2.child(testBadge(this.bbTestResult))),
                      ),
                  )
                  // Global Sync & Notifications card
                  .child(
                    v_flex()
                      .p(12)
                      .gap(10)
                      .rounded(9)
                      .bg(t.chrome)
                      .border_1()
                      .border_color(t.border)
                      .child(div().text_size(13).font_semibold().child("Global Sync & Notifications"))
                      .child(
                        h_flex()
                          .gap(6)
                          .flex_wrap()
                          .items_center()
                          .child(div().text_size(11.5).text_color(t.muted).child("Poll interval:"))
                          .children(
                            [60, 90, 180, 300].map((sec) =>
                              chip(`poll-${sec}`, `${sec}s`, this.pollIntervalSec === sec, (_e, cx) => {
                                this.pollIntervalSec = sec;
                                cx.notify();
                              }),
                            ),
                          ),
                      )
                      .child(
                        h_flex()
                          .gap(6)
                          .flex_wrap()
                          .items_center()
                          .child(div().text_size(11.5).text_color(t.muted).child("Alerts:"))
                          .child(
                            chip("notif-all", this.notifications.enabled ? "Enabled" : "Muted", this.notifications.enabled, (_e, cx) => {
                              this.notifications.enabled = !this.notifications.enabled;
                              cx.notify();
                            }),
                          )
                          .when(this.notifications.enabled, (el) =>
                            el
                              .child(chip("notif-ci", "CI", this.notifications.ci, (_e, cx) => { this.notifications.ci = !this.notifications.ci; cx.notify(); }))
                              .child(chip("notif-rev", "Reviews", this.notifications.reviews, (_e, cx) => { this.notifications.reviews = !this.notifications.reviews; cx.notify(); }))
                              .child(chip("notif-cmt", "Comments", this.notifications.comments, (_e, cx) => { this.notifications.comments = !this.notifications.comments; cx.notify(); }))
                              .child(chip("notif-req", "Review requests", this.notifications.reviewRequests, (_e, cx) => { this.notifications.reviewRequests = !this.notifications.reviewRequests; cx.notify(); })),
                          ),
                      ),
                  ),
              )
              .child(Scrollbar.vertical("prof-editor-scroll").absolute().inset_0()),
          ),
      )
      // Footer
      .child(
        h_flex()
          .h(52)
          .flex_none()
          .px(18)
          .gap(10)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11)
              .text_color(this.error ? t.ansi1 : this.savedBanner ? t.ansi2 : t.dim)
              .child(this.error || this.savedBanner || `Secrets stay local in ${home()}/.config/herdr-forge.json (0600)`),
          )
          .when(!this.embedded, (el) => el.child(btn("prof-dlg-cancel", "Cancel", false, () => closeOverlay(this.overlay))))
          .child(btn("prof-dlg-save", this.saving ? "Saving…" : "Save & Sync", true, (_e, cx) => this.saveAll(cx), this.saving)),
      );
  }
}
