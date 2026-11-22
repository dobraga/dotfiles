// Fast file editor and git diff viewer for main tabs.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Scrollbar, v_virtual_list } from "gpui-base";
import { props, shared, setShared, spaces, panes, focused, run, exec, readTextFile, writeTextFile, watchFolder, theme, settings, home, checking } from "herdr";

const LANG = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js",
  toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html",
  mdx: "markdown", sh: "bash", zsh: "bash", fish: "bash",
};
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MAX_CHARS = 400000;
const MAX_DIFF_LINE_CHARS = 1200;
const MAX_DIFF_WIDTH = 4000;
const countLines = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

function joinPath(root, rel) {
  if (!root) return rel;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${rel}`;
}

function shortRoot(root) {
  if (!root) return "";
  const h = home();
  return root === h ? "~" : root.startsWith(h + "/") ? "~" + root.slice(h.length) : root;
}

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

export default class FileView extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.slotId = p.slotId ?? null;
    this.beforeTabs = Array.isArray(p.beforeTabs) ? new Set(p.beforeTabs) : null;
    this.initialSlot =
      p.path && p.root
        ? {
            spaceId: p.spaceId ?? null,
            tabId: null,
            kind: p.kind ?? "file",
            path: p.path,
            root: p.root,
            on: p.on ?? null,
            name: p.name ?? p.path.split(/[\\/]/).pop(),
            preview: p.preview ?? true,
            updatedAt: p.updatedAt ?? 0,
          }
        : null;
    this.tabId = null;
    this.paneId = null;
    this.mode = null; // "file" | "diff"
    this.mdPreview = null;
    this.code = null;
    this.markdownText = null;
    this.diskText = null;
    this.loadedFilePath = null;
    this.dirty = false;
    this.editable = false;
    this.saving = false;
    this.saveError = null;
    this.rows = [];
    this.diffVersion = 0;
    this.diffWidth = 300;
    this.error = null;
    this.loading = false;
    this.watched = null;
    this.targetKey = null;
    this.loadSeq = 0;

    if (checking()) return;
    this.claimTab();
    if (!this.tabId) {
      cx.spawn(async (cx) => {
        this.claimTab();
        if (!this.tabId) {
          cx.timer.after(80, (cx) => {
            this.claimTab();
            cx.notify();
          });
        }
        cx.notify();
      });
    }
    const slot = this.slot();
    if (slot) {
      this.targetKey = this.slotKey(slot);
      this.load(slot, cx);
    }
  }

  slotKey(slot) {
    return `${slot.kind}:${slot.root}:${slot.path}:${slot.on ?? ""}`;
  }

  slot() {
    if (!this.slotId) return this.initialSlot;
    const live = shared("file-view.slots")?.[this.slotId];
    if (live) {
      this.initialSlot = live;
      return live;
    }
    return this.initialSlot;
  }

  claimTab() {
    if (!this.slotId) return;
    const slots = shared("file-view.slots") ?? {};
    const slot = slots[this.slotId] ?? this.initialSlot;
    if (!slot) return;
    const allPanes = panes();
    if (slot.tabId && allPanes.some((p) => p.tab === slot.tabId && p.mod === "file-view")) {
      this.tabId = slot.tabId;
      this.paneId = allPanes.find((p) => p.tab === slot.tabId && p.mod === "file-view")?.pane ?? null;
      return;
    }
    const claimed = new Set(Object.entries(slots).filter(([id, s]) => id !== this.slotId && s?.tabId).map(([, s]) => s.tabId));
    const spaceTabs = spaces().find((s) => s.id === slot.spaceId)?.tabs ?? [];
    const candidates = allPanes.filter(
      (p) => p.mod === "file-view" && !claimed.has(p.tab) && (!this.beforeTabs || !this.beforeTabs.has(p.tab)),
    );
    const activeTabId = spaceTabs.find((t) => t.active)?.id ?? focused()?.tab;
    const match =
      candidates.find((p) => p.tab === activeTabId) ??
      candidates.find((p) => spaceTabs.some((t) => t.id === p.tab)) ??
      candidates[0];
    if (!match) return;
    this.tabId = match.tab;
    this.paneId = match.pane;
    setShared("file-view.slots", {
      ...slots,
      [this.slotId]: { ...slot, tabId: match.tab },
    });
    if (slot.name) run("tab.rename", { id: match.tab, name: slot.name });
  }

  watch(root, on, cx) {
    if (on || !root || this.watched === root) return;
    this.watched = root;
    const watchedRoot = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === watchedRoot) {
          await watchFolder(watchedRoot);
          if (this.watched !== watchedRoot) break;
          const slot = this.slot();
          if (slot && slot.root === watchedRoot && !this.dirty && !this.saving) this.load(slot, cx);
        }
      } catch {
        if (this.watched === watchedRoot) this.watched = null;
      }
    });
  }

  effectiveMode(slot) {
    return this.mode ?? slot?.kind ?? "file";
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffVersion = (this.diffVersion ?? 0) + 1;
    const rawWidth = Math.max(300, ...this.rows.map((row) => (row.text.length + 1) * 7.5 + 60));
    this.diffWidth = Math.min(MAX_DIFF_WIDTH, rawWidth);
  }

  load(slot, cx, { force = false } = {}) {
    if (!slot?.path || !slot?.root) return;
    const mode = this.effectiveMode(slot);
    const seq = ++this.loadSeq;
    const fullPath = joinPath(slot.root, slot.path);
    const on = slot.on ?? null;
    this.loading = true;
    this.error = null;
    if (force) this.saveError = null;
    this.watch(slot.root, on, cx);

    cx.spawn(async (cx) => {
      try {
        if (mode === "diff") {
          this.code?.release();
          this.code = null;
          this.markdownText = null;
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: slot.root, on }).catch(() => null);
          if (seq !== this.loadSeq) return;
          if (!top || top.code !== 0) {
            this.setLines([]);
            this.error = "Not a git repository";
            return;
          }
          const gitRoot = top.stdout.trim();
          const git = (args) => exec("git", [...READ, ...args], { cwd: gitRoot, on });
          const relFromGit = fullPath.startsWith(gitRoot + "/") ? fullPath.slice(gitRoot.length + 1) : slot.path;
          const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", relFromGit]);
          const head = await git(["rev-parse", "--verify", "HEAD"]);
          if (seq !== this.loadSeq) return;
          const entry = status.stdout.split("\0").filter(Boolean)[0] ?? "";
          const xy = entry.slice(0, 2);
          const fresh = xy === "??" || (head.code !== 0 && xy.includes("A"));

          let lines;
          if (fresh) {
            const text = await readTextFile(fullPath, { on }).catch(() => null);
            if (seq !== this.loadSeq) return;
            if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
            else if (text.includes("\0")) lines = ["Binary file · no text diff"];
            else {
              const total = countLines(text);
              lines = [`@@ -0,0 +1,${total} @@`, ...text.slice(0, MAX_CHARS).replace(/\n$/, "").split("\n").slice(0, 3000).map((l) => `+${l}`)];
            }
          } else {
            const r = await git(["diff", ...(head.code === 0 ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", relFromGit]);
            if (seq !== this.loadSeq) return;
            if (r.code !== 0) throw new Error(r.stderr || "git diff failed");
            const all = r.stdout.replace(/\n$/, "").split("\n");
            const first = all.findIndex((l) => l.startsWith("@@"));
            if (first < 0) {
              if (!entry) lines = [];
              else lines = ["Binary file changed or no text diff available"];
            } else {
              lines = all.slice(first);
            }
          }
          this.setLines(
            lines
              .slice(0, 3000)
              .map((line) => (line.length > MAX_DIFF_LINE_CHARS ? line.slice(0, MAX_DIFF_LINE_CHARS) + "… (line truncated)" : line)),
          );
          if (this.rows.length === 0) this.error = "No uncommitted changes for this file";
        } else {
          this.setLines([]);
          const text = await readTextFile(fullPath, { on });
          if (seq !== this.loadSeq) return;
          if (!force && this.code && !this.dirty && this.loadedFilePath === fullPath && text === this.diskText) {
            return;
          }
          this.code?.release();
          this.code = null;
          this.markdownText = null;
          this.diskText = null;
          this.loadedFilePath = null;
          this.dirty = false;
          this.editable = false;
          this.saveError = null;
          if (text === null) {
            this.error = "This file is no longer available (or exceeds 1 MiB)";
            return;
          }
          if (text.includes("\0")) {
            this.error = "Binary file · no text preview";
            return;
          }
          const t = theme();
          const ext = slot.path.includes(".") ? slot.path.split(".").pop().toLowerCase() : "txt";
          const isTruncated = text.length > MAX_CHARS;
          const canEdit = !on && !isTruncated;
          const value = isTruncated ? text.slice(0, MAX_CHARS) + "\n… (file truncated)" : text;
          const isMdFile = ext === "md" || ext === "markdown";
          this.diskText = text;
          this.loadedFilePath = fullPath;
          this.editable = canEdit;
          this.markdownText = isMdFile ? value : null;
          if (this.mdPreview === null) this.mdPreview = isMdFile;
          this.code = EditorState.new({
            language: LANG[ext] ?? ext,
            readonly: !canEdit,
            value,
            font_family: settings().font_family,
            font_size: 13,
            syntax: {
              keyword: t.ansi5,
              string: t.ansi2,
              comment: t.dim,
              function: t.ansi4,
              type: t.ansi3,
              number: t.ansi1,
              constant: t.ansi6,
            },
          });
          if (canEdit) {
            this.code.on("change", (_e, cx) => {
              const current = this.code?.value() ?? "";
              const wasDirty = this.dirty;
              this.dirty = current !== this.diskText;
              if (this.markdownText !== null) this.markdownText = current;
              if (this.saveError) this.saveError = null;
              if (this.dirty && this.slot()?.preview) this.pin();
              if (wasDirty !== this.dirty || this.markdownText !== null) cx.notify();
            });
          }
        }
      } catch (e) {
        if (seq === this.loadSeq) this.error = String(e || "Cannot load file");
      } finally {
        if (seq === this.loadSeq) {
          this.loading = false;
          cx.notify();
        }
      }
    });
  }

  pin() {
    const slots = shared("file-view.slots") ?? {};
    const slot = slots[this.slotId] ?? this.initialSlot;
    if (!slot || !slot.preview) return;
    if (this.initialSlot) this.initialSlot = { ...this.initialSlot, preview: false };
    setShared("file-view.slots", {
      ...slots,
      [this.slotId]: { ...slot, tabId: slot.tabId ?? this.tabId, preview: false },
    });
  }

  save(cx, { force = false } = {}) {
    const slot = this.slot();
    if (!slot || !this.code || !this.editable || this.saving) return;
    if (!this.dirty && !force) return;
    const fullPath = joinPath(slot.root, slot.path);
    const nextText = this.code.value();
    const expected = this.diskText;
    this.saving = true;
    this.saveError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (force) {
          const latest = await readTextFile(fullPath, { on: slot.on ?? null });
          await writeTextFile(fullPath, nextText, latest);
        } else {
          await writeTextFile(fullPath, nextText, expected);
        }
        this.diskText = nextText;
        this.dirty = (this.code?.value() ?? "") !== this.diskText;
        this.saveError = null;
      } catch (e) {
        const msg = String(e || "Save failed");
        this.saveError =
          msg.toLowerCase().includes("stale") || msg.toLowerCase().includes("match")
            ? "File changed on disk"
            : msg;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  switchMode(nextMode, cx) {
    const slot = this.slot();
    if (!slot || this.effectiveMode(slot) === nextMode) return;
    this.mode = nextMode;
    this.mdPreview = null;
    this.dirty = false;
    this.saveError = null;
    this.load(slot, cx, { force: true });
    cx.notify();
  }

  async close() {
    this.watched = null;
    this.code?.release();
    this.code = null;
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") {
      return div().w_full().px(14).h(22).flex_none().flex().items_center().truncate().bg(t.raised).text_color(t.dim).child(text);
    }
    return h_flex()
      .w_full()
      .h(22)
      .flex_none()
      .gap(12)
      .px(8)
      .items_center()
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18"))
      .when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(12).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind || " "))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    const t = theme();
    const slot = this.slot();
    if (!slot) {
      return v_flex()
        .id("file-view-empty")
        .size_full()
        .items_center()
        .justify_center()
        .bg(t.background)
        .text_color(t.dim)
        .text_size(13)
        .child("File no longer open");
    }

    const nextKey = this.slotKey(slot);
    if (this.targetKey !== nextKey) {
      this.targetKey = nextKey;
      this.mode = null;
      this.mdPreview = null;
      this.setLines([]);
      this.code?.release();
      this.code = null;
      this.markdownText = null;
      this.diskText = null;
      this.loadedFilePath = null;
      this.dirty = false;
      this.editable = false;
      this.saveError = null;
      if (!checking()) this.load(slot, cx, { force: true });
    }

    const mode = this.effectiveMode(slot);
    const isMd = Boolean(this.markdownText) && mode === "file";
    const chip = (id, label, active, onClick) =>
      div()
        .id(id)
        .h(22)
        .px(8)
        .flex()
        .items_center()
        .rounded(5)
        .cursor_pointer()
        .text_size(11.5)
        .bg(active ? t.selected : t.chrome)
        .text_color(active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(onClick)
        .child(label);

    return v_flex()
      .id(`file-view-${this.slotId}`)
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .on_key_down((e, cx) => {
        if (
          e.key?.toLowerCase() === "s" &&
          (e.modifiers?.control || e.modifiers?.platform) &&
          !e.modifiers?.alt &&
          !e.modifiers?.shift &&
          mode === "file" &&
          this.editable
        ) {
          this.save(cx);
          cx.stop_propagation();
        }
      })
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .bg(t.chrome)
          .border_b(1)
          .border_color(t.border)
          .child(svg(mode === "diff" ? "mods/changes/changes.svg" : "mods/files/file.svg").size(14).flex_none().text_color(t.muted))
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(6)
              .items_center()
              .child(div().truncate().text_size(12.5).font_medium().child(slot.path))
              .when(mode === "file" && this.dirty, (el) =>
                el.child(div().w(7).h(7).flex_none().rounded(99).bg(t.accent)),
              )
              .when(Boolean(slot.root), (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(shortRoot(slot.root))))
              .when(slot.preview, (el) =>
                el.child(div().px(6).py(1).rounded(4).border(1).border_color(t.border).text_size(10).text_color(t.dim).child("preview")),
              ),
          )
          .when(mode === "file" && this.editable && (this.dirty || this.saving), (el) =>
            el.child(
              div()
                .id("fv-save")
                .h(24)
                .px(10)
                .flex()
                .items_center()
                .rounded(6)
                .bg(this.saving ? t.raised : t.solid)
                .text_color(this.saving ? t.dim : t.solid_foreground)
                .text_size(11.5)
                .font_medium()
                .when(!this.saving, (b) => b.cursor_pointer())
                .on_click((_e, cx) => this.save(cx))
                .child(this.saving ? "Saving…" : "Save"),
            ),
          )
          .when(slot.kind === "diff" || mode === "diff", (el) =>
            el.child(
              h_flex()
                .gap(2)
                .p(2)
                .rounded(6)
                .bg(t.background)
                .border(1)
                .border_color(t.border)
                .child(chip("fv-mode-diff", "Diff", mode === "diff", (_e, cx) => this.switchMode("diff", cx)))
                .child(chip("fv-mode-file", "File", mode === "file", (_e, cx) => this.switchMode("file", cx))),
            ),
          )
          .when(isMd, (el) =>
            el.child(
              h_flex()
                .gap(2)
                .p(2)
                .rounded(6)
                .bg(t.background)
                .border(1)
                .border_color(t.border)
                .child(chip("fv-md-code", "Code", !this.mdPreview, (_e, cx) => { this.mdPreview = false; cx.notify(); }))
                .child(chip("fv-md-prev", "Preview", this.mdPreview, (_e, cx) => { this.mdPreview = true; cx.notify(); })),
            ),
          )
          .when(slot.preview, (el) =>
            el.child(
              h_flex()
                .id("fv-pin")
                .h(24)
                .px(8)
                .gap(5)
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .text_size(11.5)
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click(() => this.pin())
                .child(svg("mods/workspace-chrome/pin.svg").size(12))
                .child("Pin"),
            ),
          )
          .child(
            h_flex()
              .id("fv-split-term")
              .h(24)
              .px(8)
              .gap(5)
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .text_size(11.5)
              .text_color(t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => run("terminal.open", { place: "right", folder: slot.root }))
              .child(svg("mods/workspace-chrome/terminal.svg").size(12))
              .child("Terminal"),
          )
          .child(
            div()
              .id("fv-reload")
              .h(24)
              .px(8)
              .flex()
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .text_size(11.5)
              .text_color(t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.load(slot, cx, { force: true }))
              .child("Reload"),
          ),
      )
      .when(Boolean(this.saveError), (el) =>
        el.child(
          h_flex()
            .h(32)
            .flex_none()
            .px(12)
            .gap(8)
            .items_center()
            .bg(t.ansi1 + "18")
            .border_b(1)
            .border_color(t.border)
            .text_size(11.5)
            .child(div().flex_1().truncate().text_color(t.ansi1).child(this.saveError))
            .when(this.saveError === "File changed on disk", (b) =>
              b.child(
                div()
                  .id("fv-overwrite")
                  .h(22)
                  .px(8)
                  .flex()
                  .items_center()
                  .rounded(5)
                  .cursor_pointer()
                  .bg(t.solid)
                  .text_color(t.solid_foreground)
                  .on_click((_e, cx) => this.save(cx, { force: true }))
                  .child("Overwrite"),
              ),
            )
            .child(
              div()
                .id("fv-reload-conflict")
                .h(22)
                .px(8)
                .flex()
                .items_center()
                .rounded(5)
                .cursor_pointer()
                .bg(t.chrome)
                .text_color(t.foreground)
                .on_click((_e, cx) => this.load(slot, cx, { force: true }))
                .child("Reload"),
            ),
        ),
      )
      .when(mode === "file", (el) =>
        el.child(
          this.error
            ? div().p(16).text_color(t.dim).child(this.error)
            : this.mdPreview && this.markdownText
              ? v_flex()
                  .id("fv-markdown-scroll")
                  .flex_1()
                  .min_h(0)
                  .overflow_y_scrollbar()
                  .p(20)
                  .child(TextView.markdown(`fv-md-${this.slotId}`, this.markdownText))
              : this.code
                ? Editor.new(this.code).flex_1().min_h(0)
                : div().p(16).text_color(t.dim).child(this.loading ? "Loading file…" : ""),
        ),
      )
      .when(mode === "diff", (el) =>
        el.child(
          this.error && this.rows.length === 0
            ? div().p(16).text_color(t.dim).child(this.error)
            : div()
                .flex_1()
                .min_h(0)
                .relative()
                .font_family(settings().font_family ?? "JetBrains Mono")
                .text_size(12.5)
                .child(
                  div()
                    .id(`fv-diff-x-${this.slotId}-${this.diffVersion}`)
                    .absolute()
                    .inset_0()
                    .overflow_x_scrollbar()
                    .child(
                      div()
                        .w_full()
                        .min_w(this.diffWidth)
                        .h_full()
                        .child(
                          v_virtual_list(
                            `fv-diff-${this.slotId}-${this.diffVersion}`,
                            this.rows.length,
                            22,
                            (i) => `${this.diffVersion}-${i}`,
                            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t)),
                          ).size_full(),
                        ),
                    ),
                )
                .child(Scrollbar.vertical(`fv-diff-${this.slotId}-${this.diffVersion}`).viewport_from_layout().absolute().inset_0())
                .when(this.loading && this.rows.length === 0, (e) => e.child(div().p(16).text_color(t.dim).child("Loading diff…"))),
        ),
      );
  }
}
