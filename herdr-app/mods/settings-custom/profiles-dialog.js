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
  host: "github.com",
  account: "",
  orgs: [],
  repos: [],
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
  userIsEmail: false,
  userNeedsEmailHint: false,
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
      host: g.host || "github.com",
      account: g.account ?? g.username ?? "",
      orgs: Array.isArray(g.orgs) ? [...g.orgs] : [],
      repos: Array.isArray(g.repos) ? [...g.repos] : [],
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
    this.refreshingGh = false;
    this.testingGh = false;
    this.testingBb = false;
    this.ghTestResult = null;
    this.bbTestResult = null;
    this.detectBanner = null;
    this.error = null;
    this.confirmDelete = false;
    this.showBbToken = false;
    this.syncingInputs = false;
    this.ghInfo = { installed: true, accounts: [] };
    this.ghLogin = null;

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
    this.ghHostInput = InputState.new({ placeholder: "github.com" });
    this.ghAccountInput = InputState.new({ placeholder: "Select below or type login (empty = active)" });
    this.ghOrgsInput = InputState.new({ placeholder: "Optional: org1, org2" });
    this.ghReposInput = InputState.new({ placeholder: "Optional: owner/repo1, owner/repo2" });

    this.bbWorkspaceInput = InputState.new({ placeholder: "e.g. tricura" });
    this.bbUsernameInput = InputState.new({ placeholder: "Optional username / account" });
    this.bbUserEnvVarInput = InputState.new({ placeholder: "you@company.com or BB_EMAIL" });
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
    this.ghHostInput.on("change", syncText(() => {
      this.currentForge().github.host = this.ghHostInput.value().trim() || "github.com";
    }));
    this.ghAccountInput.on("change", syncText(() => {
      this.currentForge().github.account = this.ghAccountInput.value().trim();
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
      this.ghHostInput.set_value(f.github.host || "github.com");
      this.ghAccountInput.set_value(f.github.account ?? "");
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
    if (this.ghLogin && this.ghLogin.status !== "starting" && this.ghLogin.status !== "waiting_for_browser") {
      this.ghLogin = null;
    }
    this.loadInputsForSelected();
    cx.notify();
  }

  loadAll(cx) {
    cx.spawn(async (cx) => {
      try {
        const [sfRes, cfgRes, ghLoginRes] = await Promise.all([
          exec("sh", ["-c", `cat ${SPACE_FOLDERS_FILE} 2>/dev/null`]).catch(() => null),
          exec("python3", [this.helperPath, "get-config"]),
          exec("python3", [this.helperPath, "gh-login-status"]).catch(() => null),
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
          if (cfg.gh) this.ghInfo = cfg.gh;
          for (const prof of this.profiles) {
            this.draftForge[prof.id] = cloneProfileForge(cfg.profiles?.[prof.id]);
          }
          for (const [pid, pcfg] of Object.entries(cfg.profiles ?? {})) {
            this.draftForge[pid] ??= cloneProfileForge(pcfg);
          }
        }
        if (ghLoginRes?.code === 0 && ghLoginRes.stdout.trim()) {
          try {
            const st = JSON.parse(ghLoginRes.stdout);
            if (st.status === "starting" || st.status === "waiting_for_browser") {
              this.ghLogin = {
                sessionId: st.sessionId || "",
                status: st.status,
                host: st.host || "github.com",
                targetProfileId: this.selectedId,
                code: st.code || "",
                url: st.url || "",
                user: st.user || "",
                error: st.error || "",
                copiedCode: false,
                copiedUrl: false,
              };
              cx.spawn((c2) => this.pollGhLogin(st.sessionId || "", this.selectedId, st.host || "github.com", c2));
            }
          } catch {}
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

  refreshGhAccounts(cx) {
    if (this.refreshingGh) return;
    this.refreshingGh = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await exec("python3", [this.helperPath, "gh-accounts"]);
        if (res.code === 0 && res.stdout.trim()) {
          this.ghInfo = JSON.parse(res.stdout);
        }
      } catch (e) {
        this.error = String(e);
      } finally {
        this.refreshingGh = false;
        cx.notify();
      }
    });
  }

  startGhLogin(cx) {
    const busy = this.ghLogin?.status === "starting" || this.ghLogin?.status === "waiting_for_browser";
    if (checking() || !this.ghInfo?.installed || busy) return;
    const targetProfileId = this.selectedId;
    const gh = this.currentForge().github;
    const host = (gh.host || "github.com").trim() || "github.com";
    gh.enabled = true;
    this.ghTestResult = null;
    this.error = null;
    this.ghLogin = {
      sessionId: "",
      status: "starting",
      host,
      targetProfileId,
      code: "",
      url: "",
      user: "",
      error: "",
      copiedCode: false,
      copiedUrl: false,
    };
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("python3", [this.helperPath, "gh-login-start", "--host", host]);
        if (res.code !== 0) throw new Error(res.stderr || "Failed to start GitHub login");
        const parsed = JSON.parse(res.stdout);
        if (!parsed.ok || parsed.status === "error") {
          this.ghLogin = {
            ...(this.ghLogin ?? {}),
            status: "error",
            host,
            targetProfileId,
            error: parsed.error || "Failed to start GitHub login",
          };
          cx.notify();
          return;
        }
        if (this.ghLogin === null) return;
        const resolvedHost = parsed.host || host;
        this.ghLogin = {
          ...this.ghLogin,
          sessionId: parsed.sessionId || "",
          status: parsed.status || "waiting_for_browser",
          host: resolvedHost,
          code: parsed.code || "",
          url: parsed.url || "",
          user: parsed.user || "",
          error: "",
        };
        if (parsed.code) {
          cx.write_to_clipboard(parsed.code);
          this.ghLogin.copiedCode = true;
        }
        if (parsed.url && /^https?:\/\//.test(parsed.url)) {
          cx.open_url(parsed.url);
        }
        cx.notify();
        if (parsed.status === "completed") {
          await this.applyGhLoginCompleted(parsed, targetProfileId, resolvedHost, cx);
          return;
        }
        if (parsed.status === "starting" || parsed.status === "waiting_for_browser") {
          await this.pollGhLogin(parsed.sessionId || "", targetProfileId, resolvedHost, cx);
        }
      } catch (e) {
        this.ghLogin = {
          ...(this.ghLogin ?? {}),
          status: "error",
          host,
          targetProfileId,
          error: String(e),
        };
        cx.notify();
      }
    });
  }

  async pollGhLogin(sessionId, targetProfileId, host, cx) {
    while (
      this.ghLogin &&
      this.ghLogin.sessionId === sessionId &&
      (this.ghLogin.status === "starting" || this.ghLogin.status === "waiting_for_browser")
    ) {
      await cx.sleep(1500);
      if (
        !this.ghLogin ||
        this.ghLogin.sessionId !== sessionId ||
        (this.ghLogin.status !== "starting" && this.ghLogin.status !== "waiting_for_browser")
      ) {
        break;
      }
      try {
        const res = await exec("python3", [this.helperPath, "gh-login-status"]);
        if (res.code !== 0 || !res.stdout.trim()) continue;
        const st = JSON.parse(res.stdout);
        if (st.sessionId && sessionId && st.sessionId !== sessionId) break;
        if (st.status === "waiting_for_browser") {
          const hadCode = Boolean(this.ghLogin.code);
          this.ghLogin.status = "waiting_for_browser";
          if (!hadCode && st.code) {
            this.ghLogin.code = st.code;
            this.ghLogin.url = st.url || "";
            cx.write_to_clipboard(st.code);
            this.ghLogin.copiedCode = true;
            if (st.url && /^https?:\/\//.test(st.url)) {
              cx.open_url(st.url);
            }
          }
          cx.notify();
        } else if (st.status === "completed") {
          await this.applyGhLoginCompleted(st, targetProfileId, host, cx);
          break;
        } else if (st.status === "error") {
          this.ghLogin = { ...this.ghLogin, status: "error", error: st.error || "GitHub login failed" };
          cx.notify();
          break;
        } else if (st.status === "cancelled" || st.status === "idle") {
          this.ghLogin = null;
          cx.notify();
          break;
        }
      } catch {}
    }
  }

  async applyGhLoginCompleted(st, targetProfileId, host, cx) {
    if (st.gh) {
      this.ghInfo = st.gh;
    } else {
      const res = await exec("python3", [this.helperPath, "gh-accounts"]).catch(() => null);
      if (res?.code === 0 && res.stdout.trim()) {
        try { this.ghInfo = JSON.parse(res.stdout); } catch {}
      }
    }
    const loggedUser = st.user || "";
    this.draftForge[targetProfileId] ??= cloneProfileForge(null);
    const gh = this.draftForge[targetProfileId].github;
    gh.enabled = true;
    gh.host = host || "github.com";
    if (loggedUser) gh.account = loggedUser;
    if (this.selectedId === targetProfileId) this.loadInputsForSelected();
    this.ghLogin = {
      ...(this.ghLogin ?? {}),
      status: "completed",
      host: host || "github.com",
      targetProfileId,
      user: loggedUser,
      error: "",
    };
    cx.notify();
  }

  cancelGhLogin(cx) {
    this.ghLogin = null;
    cx.notify();
    cx.spawn(async () => {
      await exec("python3", [this.helperPath, "gh-login-cancel"]).catch(() => null);
    });
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
        if (parsed.gh) this.ghInfo = parsed.gh;
        const sug = parsed.suggestions?.[this.selectedId];
        if (!sug) {
          this.detectBanner = "No matching local repos found for this profile.";
        } else {
          const cur = this.currentForge();
          if (sug.github?.enabled) {
            cur.github.enabled = true;
            if (sug.github.host) cur.github.host = sug.github.host;
            if (sug.github.account && !cur.github.account) cur.github.account = sug.github.account;
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
        host: cfg.host || "github.com",
        account: cfg.account ?? "",
        orgs: cfg.orgs ?? [],
        repos: cfg.repos ?? [],
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
          if (parsed.ok && parsed.identity && !this.currentForge().github.account) {
            this.currentForge().github.account = parsed.identity;
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
                  // GitHub card (100% gh CLI multi-account)
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
                          .child(div().flex_1().text_size(13).font_semibold().child("GitHub (gh CLI)"))
                          .child(
                            togglePill("gh-toggle", gh.enabled, "Enabled", "Disabled", (_e, cx) => {
                              gh.enabled = !gh.enabled;
                              cx.notify();
                            }),
                          ),
                      )
                      .when(gh.enabled, (el) => {
                        const ghAccts = this.ghInfo?.accounts ?? [];
                        const ghLoginBusy = this.ghLogin?.status === "starting" || this.ghLogin?.status === "waiting_for_browser";
                        return el
                          .when(!this.ghInfo?.installed, (e2) =>
                            e2.child(
                              div()
                                .p(8)
                                .rounded(6)
                                .bg(t.ansi1 + "1f")
                                .border_1()
                                .border_color(t.ansi1 + "55")
                                .text_size(11.5)
                                .text_color(t.ansi1)
                                .child("gh CLI not found in PATH"),
                            ),
                          )
                          .child(
                            v_flex()
                              .gap(6)
                              .child(
                                h_flex()
                                  .gap(6)
                                  .flex_wrap()
                                  .items_center()
                                  .child(div().flex_1().text_size(11.5).font_medium().text_color(t.muted).child("Authenticated gh accounts"))
                                  .child(
                                    btn(
                                      "gh-login-btn",
                                      ghLoginBusy ? "Logging in…" : ghAccts.length > 0 ? "+ Add account" : "Login with GitHub",
                                      ghAccts.length === 0,
                                      (_e, cx) => this.startGhLogin(cx),
                                      !this.ghInfo?.installed || ghLoginBusy,
                                    ),
                                  )
                                  .child(
                                    btn(
                                      "gh-refresh-accts",
                                      this.refreshingGh ? "Checking…" : "Refresh accounts",
                                      false,
                                      (_e, cx) => this.refreshGhAccounts(cx),
                                      this.refreshingGh,
                                    ),
                                  ),
                              )
                              .child(
                                h_flex()
                                  .gap(6)
                                  .flex_wrap()
                                  .child(
                                    chip("gh-acct-active", "Active (default)", !gh.account, (_e, cx) => {
                                      gh.account = "";
                                      this.loadInputsForSelected();
                                      cx.notify();
                                    }),
                                  )
                                  .children(
                                    ghAccts.map((a, idx) => {
                                      const selected = gh.account === a.user && (gh.host || "github.com") === a.host;
                                      const lbl = `${a.user}${a.active ? " ✓" : ""}${a.host !== "github.com" ? ` (${a.host})` : ""}`;
                                      return chip(`gh-acct-${idx}`, lbl, selected, (_e, cx) => {
                                        gh.account = a.user;
                                        gh.host = a.host || "github.com";
                                        this.loadInputsForSelected();
                                        cx.notify();
                                      });
                                    }),
                                  ),
                              )
                              .when(this.ghInfo?.installed && ghAccts.length === 0 && !this.ghLogin, (e2) =>
                                e2.child(
                                  div()
                                    .text_size(11)
                                    .text_color(t.dim)
                                    .child("No gh accounts logged in yet — click 'Login with GitHub' above to authenticate in your browser."),
                                ),
                              )
                              .when(Boolean(this.ghLogin), (e2) => {
                                const lg = this.ghLogin;
                                if (lg.status === "starting") {
                                  return e2.child(
                                    h_flex()
                                      .p(10)
                                      .gap(8)
                                      .items_center()
                                      .rounded(7)
                                      .bg(t.selected)
                                      .border_1()
                                      .border_color(t.border)
                                      .child(div().flex_1().text_size(11.5).text_color(t.foreground).child(`Starting GitHub login for ${lg.host}…`))
                                      .child(btn("gh-login-cancel", "Cancel", false, (_e, cx) => this.cancelGhLogin(cx))),
                                  );
                                }
                                if (lg.status === "waiting_for_browser") {
                                  return e2.child(
                                    v_flex()
                                      .p(10)
                                      .gap(8)
                                      .rounded(7)
                                      .bg(t.selected)
                                      .border_1()
                                      .border_color(t.accent)
                                      .child(
                                        h_flex()
                                          .gap(8)
                                          .items_center()
                                          .child(div().flex_1().text_size(12).font_semibold().child(`GitHub Device Login (${lg.host})`))
                                          .child(
                                            div()
                                              .px(7)
                                              .py(2)
                                              .rounded(5)
                                              .bg(t.working + "22")
                                              .text_size(10.5)
                                              .text_color(t.working)
                                              .child("Waiting for browser…"),
                                          ),
                                      )
                                      .when(Boolean(lg.code), (c2) =>
                                        c2.child(
                                          h_flex()
                                            .gap(8)
                                            .items_center()
                                            .child(div().text_size(11.5).text_color(t.muted).child("One-time code:"))
                                            .child(
                                              div()
                                                .px(10)
                                                .py(4)
                                                .rounded(6)
                                                .bg(t.background)
                                                .border_1()
                                                .border_color(t.accent)
                                                .text_size(15)
                                                .font_semibold()
                                                .text_color(t.foreground)
                                                .child(lg.code),
                                            )
                                            .when(Boolean(lg.copiedCode), (cp) =>
                                              cp.child(div().text_size(10.5).text_color(t.ansi2).child("Copied")),
                                            ),
                                        ),
                                      )
                                      .child(
                                        h_flex()
                                          .gap(6)
                                          .flex_wrap()
                                          .when(Boolean(lg.code), (b2) =>
                                            b2.child(
                                              btn("gh-login-copy-code", lg.copiedCode ? "Copied code" : "Copy code", false, (_e, cx) => {
                                                cx.write_to_clipboard(lg.code);
                                                lg.copiedCode = true;
                                                lg.copiedUrl = false;
                                                cx.notify();
                                              }),
                                            ),
                                          )
                                          .when(Boolean(lg.url && /^https?:\/\//.test(lg.url)), (b2) =>
                                            b2
                                              .child(btn("gh-login-open-url", "Open browser", true, (_e, cx) => cx.open_url(lg.url)))
                                              .child(
                                                btn("gh-login-copy-url", lg.copiedUrl ? "Copied URL" : "Copy URL", false, (_e, cx) => {
                                                  cx.write_to_clipboard(lg.url);
                                                  lg.copiedUrl = true;
                                                  cx.notify();
                                                }),
                                              ),
                                          )
                                          .child(btn("gh-login-cancel", "Cancel", false, (_e, cx) => this.cancelGhLogin(cx))),
                                      )
                                      .child(
                                        div()
                                          .text_size(10.5)
                                          .text_color(t.dim)
                                          .child(`Paste the code on ${lg.url || "github.com/login/device"}. To add a 2nd account (e.g. Work), copy the URL into a browser profile or incognito window signed into that account.`),
                                      ),
                                  );
                                }
                                if (lg.status === "completed") {
                                  return e2.child(
                                    h_flex()
                                      .p(8)
                                      .gap(8)
                                      .items_center()
                                      .rounded(6)
                                      .bg(t.ansi2 + "1f")
                                      .border_1()
                                      .border_color(t.ansi2 + "55")
                                      .child(
                                        div()
                                          .flex_1()
                                          .text_size(11.5)
                                          .text_color(t.ansi2)
                                          .child(`Logged in as ${lg.user || "GitHub account"} via gh CLI — click Save & Sync to apply.`),
                                      )
                                      .child(btn("gh-login-dismiss", "Dismiss", false, (_e, cx) => { this.ghLogin = null; cx.notify(); })),
                                  );
                                }
                                return e2.child(
                                  h_flex()
                                    .p(8)
                                    .gap(8)
                                    .items_center()
                                    .rounded(6)
                                    .bg(t.ansi1 + "1f")
                                    .border_1()
                                    .border_color(t.ansi1 + "55")
                                    .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.ansi1).child(lg.error || "GitHub login failed"))
                                    .child(btn("gh-login-retry", "Retry", false, (_e, cx) => this.startGhLogin(cx)))
                                    .child(btn("gh-login-dismiss", "Dismiss", false, (_e, cx) => { this.ghLogin = null; cx.notify(); })),
                                );
                              }),
                          )
                          .child(field("Account login (empty = active gh account)", this.ghAccountInput))
                          .child(field("GitHub host", this.ghHostInput))
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
                          .when(Boolean(this.ghTestResult), (e2) => e2.child(testBadge(this.ghTestResult)));
                      }),
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
                          .when(bb.authMode === "env", (e2) => {
                            const bbUserVal = (bb.userEnvVar ?? "").trim();
                            const isEmail = bbUserVal.includes("@");
                            const needsEmail = !isEmail && Boolean(bb.userNeedsEmailHint);
                            const badgeBg = isEmail || (!needsEmail && bb.userEnvFound) ? t.ansi2 + "22" : needsEmail ? t.blocked + "22" : t.raised;
                            const badgeCol = isEmail || (!needsEmail && bb.userEnvFound) ? t.ansi2 : needsEmail ? t.blocked : t.dim;
                            const badgeText = isEmail ? "Email" : needsEmail ? "Needs email (ATATT)" : bb.userEnvFound ? "Found" : "Not set";
                            const hintText = needsEmail ? "ATATT API tokens require your Atlassian email (e.g. you@company.com) instead of short username." : null;
                            return e2
                              .child(
                                field(
                                  "Atlassian Email or User env var",
                                  this.bbUserEnvVarInput,
                                  div()
                                    .px(7)
                                    .py(4)
                                    .rounded(5)
                                    .text_size(10.5)
                                    .bg(badgeBg)
                                    .text_color(badgeCol)
                                    .child(badgeText),
                                  hintText,
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
                              );
                          })
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
                            v_flex()
                              .gap(3)
                              .px(10)
                              .py(8)
                              .rounded(6)
                              .border_1()
                              .border_color(t.border)
                              .child(div().text_size(11.5).text_color(t.muted).child("How to create a Bitbucket token"))
                              .children(
                                [
                                  "1. id.atlassian.com → Security → Create API token with scopes.",
                                  "2. App: Bitbucket. Scopes: read:user, read:repository, read:pullrequest (+ read:pipeline for CI).",
                                  "3. Use the Atlassian account that can access the workspace; its email is the user.",
                                  "4. Put the token in ~/.env as BB_TOKEN=ATATT… (a BB_TOKEN exported in the shell wins over the file).",
                                  "5. Set 'Atlassian Email or User env var' to that email (or an env var holding it), then restart herdr.",
                                  "Tokens without scopes, or with the wrong email, return HTTP 401. Workspace/Repo Access Tokens: use Bearer.",
                                ].map((line) => div().text_size(10.5).text_color(t.dim).child(line)),
                              ),
                          )
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
