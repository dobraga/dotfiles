// Fast file editor, media previewer (image/SVG/audio/video), git diff viewer, and inline Open With screen.
import { View, div, svg, list } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Scrollbar, v_virtual_list, Input, InputState, SliderState, ScrollHandle, VirtualListScrollHandle } from "gpui-base";
import { props, shared, setShared, spaces, panes, focused, run, exec, readTextFile, writeTextFile, watchFolder, theme, settings, home, checking, notify } from "herdr";
import { colorRows } from "./syntax.js";
import { inspectFile, launchApp, setDefaultApp, revealInFolder, visibleApps, renderOpenWithScreen } from "./open-with-ui.js";
import {
  AUDIO_RATES,
  loadImagePreview,
  loadAudioPreview,
  loadVideoPreview,
  extractVideoFrame,
  startAudioDaemon,
  audioRequest,
  loadPdfPreview,
  loadPdfPage,
  loadPdfText,
  renderImageView,
  renderAudioView,
  renderVideoView,
  renderPdfView,
} from "./media-ui.js";

const LANG = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js",
  toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html",
  mdx: "markdown", sh: "bash", zsh: "bash", fish: "bash",
};
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "tiff", "tif", "avif", "heic", "heif"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "wma", "aiff", "aif"]);
const VIDEO_EXTS = new Set(["mp4", "mkv", "webm", "mov", "avi", "m4v", "wmv", "flv", "mpeg", "mpg", "ogv"]);
const PDF_EXTS = new Set(["pdf"]);
const UNSUPPORTED_ERR_RE = /utf-?8|invalid data|binary|too large|exceeds/i;
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

// Splits markdown into blank-line separated blocks, keeping fenced code intact.
function splitMdBlocks(text) {
  const blocks = [];
  let cur = [];
  let fence = null;
  const flush = () => {
    if (cur.length) blocks.push(cur.join("\n"));
    cur = [];
  };
  for (const line of text.split("\n")) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence ? (fence === f[1] ? null : fence) : f[1];
    if (!fence && !f && line.trim() === "") flush();
    else cur.push(line);
  }
  flush();
  return blocks;
}

const isFencedBlock = (b) => /^\s*(```|~~~)/.test(b);

function countOccurrences(text, q) {
  let n = 0;
  let pos = 0;
  while ((pos = text.indexOf(q, pos)) !== -1) {
    n++;
    pos += q.length;
  }
  return n;
}

const HIT_BG = "#fde047";
const HIT_CUR_BG = "#fb923c";
const HIT_FG = "#1c1917";

// --- Lightweight markdown model used to draw blocks that contain matches ---------------------
// TextView cannot colour text, so blocks with hits are drawn by hand. Only the common syntax is
// handled (headings, lists, quotes, tables, **bold**, `code`); anything else shows as plain text.
function parseInline(text) {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .filter(Boolean)
    .map((tok) =>
      tok.startsWith("**") && tok.endsWith("**") && tok.length > 4
        ? { text: tok.slice(2, -2), bold: true }
        : tok.startsWith("`") && tok.endsWith("`") && tok.length > 2
          ? { text: tok.slice(1, -1), code: true }
          : { text: tok },
    );
}

function parseMdBlockLines(block) {
  const out = [];
  for (const line of block.split("\n")) {
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) out.push({ kind: "h", level: m[1].length, segs: parseInline(m[2]) });
    else if (/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("|")) out.push({ kind: "sep" });
    else if (/^\s*\|/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|");
      out.push({ kind: "row", cells: cells.map((c) => parseInline(c.trim())) });
    } else if ((m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line)))
      out.push({ kind: "li", indent: m[1].length, marker: /\d/.test(m[2]) ? m[2] : "•", segs: parseInline(m[3]) });
    else if ((m = /^\s*>\s?(.*)$/.exec(line))) out.push({ kind: "quote", segs: parseInline(m[1]) });
    else out.push({ kind: "p", segs: parseInline(line.trim()) });
  }
  return out;
}

function mdLineSegs(l) {
  return l.kind === "row" ? l.cells.flat() : (l.segs ?? []);
}

function countBlockHits(block, q) {
  if (isFencedBlock(block)) return 0;
  // Cheap prefilter: a segment can only match if the raw block text does, so skip the parse otherwise.
  if (!block.toLowerCase().includes(q)) return 0;
  let n = 0;
  for (const l of parseMdBlockLines(block)) for (const sg of mdLineSegs(l)) n += countOccurrences(sg.text.toLowerCase(), q);
  return n;
}

function renderMdMatchBlock(block, q, currentLocal, t) {
  let i = 0;
  const inline = (segs) => {
    const row = h_flex().flex_wrap().min_w(0);
    for (const sg of segs) {
      const style = (e) =>
        e
          .when(sg.bold, (x) => x.font_bold())
          .when(sg.code, (x) => x.bg(t.raised).rounded(3).px(3).font_family(settings().font_family ?? "JetBrains Mono"));
      const lower = sg.text.toLowerCase();
      const pieces = [];
      let pos = 0;
      let at;
      while (q && (at = lower.indexOf(q, pos)) !== -1) {
        if (at > pos) pieces.push({ text: sg.text.slice(pos, at) });
        pieces.push({ text: sg.text.slice(at, at + q.length), hit: true });
        pos = at + q.length;
      }
      if (pos < sg.text.length) pieces.push({ text: sg.text.slice(pos) });
      for (const pc of pieces) {
        if (pc.hit) {
          const cur = i++ === currentLocal;
          row.child(style(div()).rounded(3).bg(cur ? HIT_CUR_BG : HIT_BG).text_color(HIT_FG).child(pc.text));
        } else {
          for (const w of pc.text.match(/\S+\s*|\s+/g) ?? []) row.child(style(div()).child(w));
        }
      }
    }
    return row;
  };
  const col = v_flex().gap(4);
  const lines = parseMdBlockLines(block);
  lines.forEach((l) => {
    if (l.kind === "sep") return;
    if (l.kind === "h")
      col.child(inline(l.segs).text_size([0, 22, 18, 15, 14, 13, 13][l.level]).font_bold().mt(l.level < 3 ? 4 : 0));
    else if (l.kind === "li")
      col.child(
        h_flex()
          .gap(6)
          .pl(l.indent * 6 + 4)
          .items_start()
          .child(div().flex_none().text_color(t.dim).child(l.marker))
          .child(inline(l.segs).flex_1()),
      );
    else if (l.kind === "quote")
      col.child(div().pl(10).border_l(3).border_color(t.border).text_color(t.muted).child(inline(l.segs)));
    else if (l.kind === "row")
      col.child(
        h_flex()
          .border_b(1)
          .border_color(t.border)
          .children(l.cells.map((c) => div().flex_1().min_w(0).px(6).py(3).child(inline(c)))),
      );
    else col.child(inline(l.segs));
  });
  return col;
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
    this.mode = null; // "file" | "diff" | "open-with"
    this.mdPreview = null;
    this.svgPreview = null;
    this.isSvgFile = false;
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
    this.copySeq = 0;
    this.updatingSliders = false;

    // Open With state
    this.unsupported = null;
    this.openWithManual = false;
    this.openWithData = null;
    this.openWithLoading = false;
    this.openWithError = null;
    this.openWithQuery = "";
    this.openWithShowAll = false;
    this.openWithAt = 0;
    this.openWithCopied = false;
    this.openWithLaunching = false;
    this.openWithNotice = null;
    this.openWithSeq = 0;

    // Media preview state
    this.mediaMode = null; // "image" | "audio" | "video" | "pdf"
    this.mediaData = null;
    this.mediaLoading = false;
    this.mediaError = null;
    this.imgFit = true;
    this.imgZoom = 1;
    this.viewportSize = null;
    this.audioDaemon = null;
    this.audioStatus = null;
    this.audioStarting = false;
    this.audioError = null;
    this.audioScrubPos = null;
    this.audioVolume = 1;
    this.audioMuted = false;
    this.audioRate = 1;
    this.audioPolling = false;
    this.videoFrame = null;
    this.videoSeeking = false;
    this.videoScrubPos = null;
    this.videoSeekSeq = 0;

    // PDF viewer state
    this.pdfPage = 1;
    this.pdfDpi = 150;
    this.pdfFitMode = "width"; // "width" | "page" | "manual"
    this.pdfZoom = 1;
    this.pdfPageData = null;
    this.pdfPageCache = new Map();
    this.pdfPageLoading = false;
    this.pdfPageSeq = 0;
    this.pdfScrubPage = null;
    this.pdfTextMode = false;
    this.pdfPagesText = null;
    this.pdfTextLoading = false;
    this.pdfTextCode = null;
    this.pdfTextCopied = false;
    this.pdfCopySeq = 0;
    this.pdfSearchOpen = false;
    this.pdfSearchQuery = "";
    this.pdfMatches = [];
    this.pdfMatchIdx = 0;

    // Retained UI states
    this.focusHandle = cx.focus_handle();
    this.openWithInput = InputState.new({ placeholder: "Filter or search all installed apps…" });
    this.audioSeekSlider = SliderState.new({ min: 0, max: 1000, step: 1, value: 0 });
    this.audioVolSlider = SliderState.new({ min: 0, max: 100, step: 1, value: 100 });
    this.videoSeekSlider = SliderState.new({ min: 0, max: 1000, step: 1, value: 0 });
    this.pdfSearchInput = InputState.new({ placeholder: "Search text in PDF…" });
    this.fileSearchOpen = false;
    this.fileSearchQuery = "";
    this.fileMatches = [];
    this.fileMatchIdx = 0;
    this.mdScroll = VirtualListScrollHandle.new();
    this.codeScroll = VirtualListScrollHandle.new();
    this.searchLines = [];
    this.mdBlocks = [];
    this.fileSearchInput = InputState.new({ placeholder: "Find in file…" });
    this.pdfPageSlider = SliderState.new({ min: 1, max: 1000, step: 1, value: 1 });

    this.openWithInput.on("change", (_e, cx) => {
      this.openWithQuery = this.openWithInput.value();
      this.openWithAt = 0;
      cx.notify();
    });
    this.openWithInput.on("submit", (_e, cx) => {
      if (this.isShowingOpenWith()) this.launchHighlightedApp(cx);
    });

    this.pdfSearchInput.on("change", (_e, cx) => {
      this.pdfSearchQuery = this.pdfSearchInput.value();
      this.recomputePdfMatches(cx, { jump: true });
      cx.notify();
    });
    this.pdfSearchInput.on("submit", (e, cx) => {
      if (this.mediaMode === "pdf" && this.pdfSearchOpen) {
        this.stepPdfMatch(e?.shift || e?.modifiers?.shift ? -1 : 1, cx);
      }
    });

    this.fileSearchInput.on("change", (_e, cx) => {
      this.fileSearchQuery = this.fileSearchInput.value();
      this.recomputeFileMatches(cx, { jump: true });
      cx.notify();
    });
    this.fileSearchInput.on("submit", (e, cx) => {
      if (this.fileSearchOpen) this.stepFileMatch(e?.shift || e?.modifiers?.shift ? -1 : 1, cx);
    });

    this.pdfPageSlider.on("change", (val, cx) => {
      if (this.updatingSliders || this.mediaMode !== "pdf") return;
      const pages = this.mediaData?.pages || 1;
      if (pages > 1) {
        this.pdfScrubPage = Math.max(1, Math.min(pages, Math.round(((Number(val) - 1) / 999) * (pages - 1)) + 1));
        cx.notify();
      }
    });
    this.pdfPageSlider.on("release", (val, cx) => {
      if (this.updatingSliders || this.mediaMode !== "pdf") return;
      const pages = this.mediaData?.pages || 1;
      const target =
        pages > 1 ? Math.max(1, Math.min(pages, Math.round(((Number(val) - 1) / 999) * (pages - 1)) + 1)) : 1;
      this.pdfScrubPage = null;
      this.goToPdfPage(target, cx);
    });

    this.audioSeekSlider.on("change", (val, cx) => {
      if (this.updatingSliders || this.mediaMode !== "audio") return;
      const dur = this.audioDuration();
      if (dur > 0) {
        this.audioScrubPos = (Number(val) / 1000) * dur;
        cx.notify();
      }
    });
    this.audioSeekSlider.on("release", (val, cx) => {
      if (this.updatingSliders || this.mediaMode !== "audio") return;
      const dur = this.audioDuration();
      this.audioScrubPos = null;
      if (dur > 0) this.seekAudio((Number(val) / 1000) * dur, cx);
      else cx.notify();
    });

    this.audioVolSlider.on("change", (val, cx) => {
      if (this.updatingSliders || this.mediaMode !== "audio") return;
      this.audioVolume = Math.max(0, Math.min(1, Number(val) / 100));
      cx.notify();
    });
    this.audioVolSlider.on("release", (val, cx) => {
      if (this.updatingSliders || this.mediaMode !== "audio") return;
      this.setAudioVolume(Number(val) / 100, false, cx);
    });

    this.videoSeekSlider.on("change", (val, cx) => {
      if (this.updatingSliders || this.mediaMode !== "video") return;
      const dur = this.mediaData?.duration || 0;
      if (dur > 0) {
        this.videoScrubPos = (Number(val) / 1000) * dur;
        cx.notify();
      }
    });
    this.videoSeekSlider.on("release", (val, cx) => {
      if (this.updatingSliders || this.mediaMode !== "video") return;
      const dur = this.mediaData?.duration || 0;
      this.videoScrubPos = null;
      if (dur > 0) this.seekVideoFrame((Number(val) / 1000) * dur, cx);
      else cx.notify();
    });

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

  setSliderValue(slider, val) {
    if (!slider) return;
    this.updatingSliders = true;
    try {
      slider.set_value(val);
    } finally {
      this.updatingSliders = false;
    }
  }

  resetTransientStates() {
    this.unsupported = null;
    this.openWithManual = false;
    this.openWithData = null;
    this.openWithLoading = false;
    this.openWithError = null;
    this.openWithQuery = "";
    this.openWithShowAll = false;
    this.openWithAt = 0;
    this.openWithCopied = false;
    this.openWithLaunching = false;
    this.openWithNotice = null;
    this.mediaMode = null;
    this.mediaData = null;
    this.mediaLoading = false;
    this.mediaError = null;
    this.isSvgFile = false;
    this.svgPreview = null;
    this.imgFit = true;
    this.imgZoom = 1;
    this.audioStatus = null;
    this.audioStarting = false;
    this.audioError = null;
    this.audioScrubPos = null;
    this.audioPolling = false;
    this.videoFrame = null;
    this.videoSeeking = false;
    this.videoScrubPos = null;
    this.pdfPage = 1;
    this.pdfDpi = 150;
    this.pdfFitMode = "width";
    this.pdfZoom = 1;
    this.pdfPageData = null;
    this.pdfPageCache = new Map();
    this.pdfPageLoading = false;
    this.pdfScrubPage = null;
    this.pdfTextMode = false;
    this.pdfPagesText = null;
    this.pdfTextLoading = false;
    this.pdfTextCode?.release();
    this.pdfTextCode = null;
    this.pdfTextCopied = false;
    this.pdfSearchOpen = false;
    this.pdfSearchQuery = "";
    this.pdfMatches = [];
    this.pdfMatchIdx = 0;
  }

  hasNativeView() {
    const slot = this.slot();
    const mode = this.effectiveMode(slot);
    if (mode === "diff") return this.rows.length > 0;
    if (mode === "open-with") return false;
    return Boolean(this.code || this.markdownText || (this.mediaMode && !this.unsupported));
  }

  isShowingOpenWith() {
    const slot = this.slot();
    const mode = this.effectiveMode(slot);
    return mode === "open-with" || Boolean(this.unsupported) || this.openWithManual;
  }

  audioDuration() {
    return this.audioStatus?.duration > 0 ? this.audioStatus.duration : this.mediaData?.duration || 0;
  }

  async stopAudio({ wait = false } = {}) {
    const daemon = this.audioDaemon;
    this.audioDaemon = null;
    this.audioPolling = false;
    this.audioStarting = false;
    if (!daemon) return;
    const req = audioRequest(daemon, "POST", "/quit").catch(() => null);
    if (wait) await req;
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
          if (
            slot &&
            slot.root === watchedRoot &&
            !this.dirty &&
            !this.saving &&
            !this.openWithManual &&
            slot.kind !== "open-with" &&
            !this.unsupported &&
            !this.mediaMode
          ) {
            this.load(slot, cx);
          }
        }
      } catch {
        if (this.watched === watchedRoot) this.watched = null;
      }
    });
  }

  effectiveMode(slot) {
    return this.mode ?? slot?.kind ?? "file";
  }

  setLines(lines, path) {
    this.rows = colorRows(diffRows(lines), path);
    this.diffVersion = (this.diffVersion ?? 0) + 1;
    const rawWidth = Math.max(300, ...this.rows.map((row) => (row.text.length + 1) * 7.5 + 60));
    this.diffWidth = Math.min(MAX_DIFF_WIDTH, rawWidth);
  }

  fetchOpenWithData(fullPath, seq, cx, { focusInput = false } = {}) {
    const owSeq = ++this.openWithSeq;
    this.openWithLoading = true;
    this.openWithError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const info = await inspectFile(fullPath);
        if (seq !== this.loadSeq || owSeq !== this.openWithSeq) return;
        this.openWithData = info;
        if (focusInput && this.isShowingOpenWith()) this.openWithInput.focus();
      } catch (e) {
        if (seq === this.loadSeq && owSeq === this.openWithSeq) {
          this.openWithError = String(e?.message || e || "Failed to inspect file");
        }
      } finally {
        if (seq === this.loadSeq && owSeq === this.openWithSeq) {
          this.openWithLoading = false;
          cx.notify();
        }
      }
    });
  }

  enterUnsupported(reason, detail, fullPath, seq, cx, preloadedInfo = null) {
    this.code?.release();
    this.code = null;
    this.markdownText = null;
    this.diskText = null;
    this.loadedFilePath = null;
    this.dirty = false;
    this.editable = false;
    this.isSvgFile = false;
    this.mediaMode = null;
    this.mediaData = null;
    this.mediaLoading = false;
    this.mediaError = null;
    this.error = null;
    this.unsupported = { reason, detail };
    if (preloadedInfo) {
      this.openWithData = preloadedInfo;
      this.openWithLoading = false;
      if (!this.slot()?.on) this.openWithInput.focus();
    } else if (!this.slot()?.on) {
      this.fetchOpenWithData(fullPath, seq, cx, { focusInput: true });
    }
  }

  async loadMediaKind(kind, fullPath, seq, cx) {
    this.code?.release();
    this.code = null;
    this.markdownText = null;
    this.diskText = null;
    this.loadedFilePath = fullPath;
    this.dirty = false;
    this.editable = false;
    this.isSvgFile = false;
    this.unsupported = null;
    this.error = null;
    this.mediaMode = kind;
    this.mediaData = null;
    this.mediaLoading = true;
    this.mediaError = null;
    this.videoFrame = null;
    this.videoSeeking = false;
    this.videoScrubPos = null;
    this.pdfPage = 1;
    this.pdfDpi = 150;
    this.pdfFitMode = "width";
    this.pdfZoom = 1;
    this.pdfPageData = null;
    this.pdfPageCache = new Map();
    this.pdfPageLoading = false;
    this.pdfScrubPage = null;
    this.pdfTextMode = false;
    this.pdfPagesText = null;
    this.pdfTextLoading = false;
    this.pdfTextCode?.release();
    this.pdfTextCode = null;
    this.pdfTextCopied = false;
    this.pdfSearchOpen = false;
    this.pdfSearchQuery = "";
    this.pdfMatches = [];
    this.pdfMatchIdx = 0;
    this.fileSearchOpen = false;
    this.fileSearchQuery = "";
    this.fileMatches = [];
    this.fileMatchIdx = 0;
    this.fileSearchInput?.set_value("");
    this.audioStatus = null;
    this.audioError = null;
    this.audioScrubPos = null;
    this.setSliderValue(this.audioSeekSlider, 0);
    this.setSliderValue(this.videoSeekSlider, 0);
    this.setSliderValue(this.pdfPageSlider, 1);
    cx.notify();

    try {
      const data =
        kind === "image"
          ? await loadImagePreview(fullPath)
          : kind === "audio"
            ? await loadAudioPreview(fullPath)
            : kind === "pdf"
              ? await loadPdfPreview(fullPath)
              : await loadVideoPreview(fullPath);
      if (seq !== this.loadSeq) return;
      this.mediaData = data;
      if (kind === "video" && data?.duration > 0 && data?.posterTime != null) {
        this.setSliderValue(this.videoSeekSlider, Math.round((data.posterTime / data.duration) * 1000));
      }
      if (kind === "pdf") {
        this.pdfPage = 1;
        this.pdfDpi = data.dpi || 150;
        this.pdfPageData = data;
        this.cachePdfPage(1, this.pdfDpi, data);
        this.setSliderValue(this.pdfPageSlider, 1);
        this.focusHandle.focus();
        this.prefetchPdfNeighbors(fullPath, 1, this.pdfDpi, seq, cx);
      }
      if (kind === "audio") {
        this.focusHandle.focus();
      }
    } catch (e) {
      if (seq !== this.loadSeq) return;
      const info = await inspectFile(fullPath).catch(() => null);
      if (seq !== this.loadSeq) return;
      if (info && !info.exists) {
        this.mediaMode = null;
        this.error = info.brokenSymlink ? "Broken symlink · target does not exist" : "This file is no longer available";
        return;
      }
      if (info?.isDir) {
        this.mediaMode = null;
        this.error = "Path is a directory";
        return;
      }
      // Fallback gracefully to Open With if ffmpeg/PIL/Poppler cannot decode this media file.
      const errMsg = String(e?.message || e || "Media preview failed");
      const isEncryptedPdf = kind === "pdf" && /password|encrypt/i.test(errMsg);
      this.enterUnsupported(
        isEncryptedPdf ? "encrypted-pdf" : "binary",
        isEncryptedPdf ? "Password-protected PDF" : kind === "pdf" ? "Cannot preview PDF" : "Cannot decode media preview",
        fullPath,
        seq,
        cx,
        info,
      );
      if (!isEncryptedPdf) this.openWithError = errMsg;
    } finally {
      if (seq === this.loadSeq) {
        this.mediaLoading = false;
        cx.notify();
      }
    }
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
        if (force || this.loadedFilePath !== fullPath || mode !== "file") {
          this.stopAudio();
        }
        if (mode === "open-with") {
          this.code?.release();
          this.code = null;
          this.markdownText = null;
          this.setLines([]);
          this.mediaMode = null;
          this.mediaData = null;
          this.unsupported = null;
          this.openWithManual = true;
          this.openWithQuery = "";
          this.openWithAt = 0;
          this.openWithNotice = null;
          this.openWithInput.set_value("");
          if (!on) {
            this.fetchOpenWithData(fullPath, seq, cx, { focusInput: true });
          }
          return;
        }

        if (mode === "diff") {
          this.code?.release();
          this.code = null;
          this.markdownText = null;
          this.mediaMode = null;
          this.mediaData = null;
          this.unsupported = null;
          this.openWithManual = false;
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
            relFromGit,
          );
          if (this.rows.length === 0) this.error = "No uncommitted changes for this file";
          return;
        }

        // mode === "file"
        this.setLines([]);
        this.openWithQuery = "";
        this.openWithAt = 0;
        this.openWithNotice = null;
        this.openWithError = null;
        this.openWithInput.set_value("");
        this.pdfSearchInput.set_value("");
        this.setSliderValue(this.pdfPageSlider, 1);

        const ext = slot.path.includes(".") ? slot.path.split(".").pop().toLowerCase() : "txt";
        if (!on) {
          if (IMAGE_EXTS.has(ext)) {
            await this.loadMediaKind("image", fullPath, seq, cx);
            return;
          }
          if (AUDIO_EXTS.has(ext)) {
            await this.loadMediaKind("audio", fullPath, seq, cx);
            return;
          }
          if (VIDEO_EXTS.has(ext)) {
            await this.loadMediaKind("video", fullPath, seq, cx);
            return;
          }
          if (PDF_EXTS.has(ext)) {
            await this.loadMediaKind("pdf", fullPath, seq, cx);
            return;
          }
        }

        let text;
        try {
          text = await readTextFile(fullPath, { on });
        } catch (readErr) {
          if (seq !== this.loadSeq) return;
          const msg = String(readErr || "");
          if (UNSUPPORTED_ERR_RE.test(msg)) {
            if (!on) {
              const info = await inspectFile(fullPath).catch(() => null);
              if (seq !== this.loadSeq) return;
              if (info && !info.exists) {
                this.error = info.brokenSymlink ? "Broken symlink · target does not exist" : "This file is no longer available";
                return;
              }
              if (info?.isDir) {
                this.error = "Path is a directory";
                return;
              }
              if (info?.mediaKind && (info.mediaKind !== "image" || ext !== "svg")) {
                await this.loadMediaKind(info.mediaKind, fullPath, seq, cx);
                return;
              }
              this.enterUnsupported("non-utf8", "Not UTF-8 text", fullPath, seq, cx, info);
              return;
            }
            this.enterUnsupported("non-utf8", "Remote non-UTF-8 file", fullPath, seq, cx);
            return;
          }
          throw readErr;
        }

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
        this.unsupported = null;
        this.mediaMode = null;
        this.mediaData = null;
        this.mediaError = null;
        this.isSvgFile = false;

        if (text === null) {
          if (!on) {
            const info = await inspectFile(fullPath).catch(() => null);
            if (seq !== this.loadSeq) return;
            if (!info || !info.exists) {
              this.error = info?.brokenSymlink ? "Broken symlink · target does not exist" : "This file is no longer available";
              return;
            }
            if (info.isDir) {
              this.error = "Path is a directory";
              return;
            }
            if (info.mediaKind) {
              await this.loadMediaKind(info.mediaKind, fullPath, seq, cx);
              return;
            }
            this.enterUnsupported("too-large", "Exceeds 1 MiB preview limit", fullPath, seq, cx, info);
            return;
          }
          this.error = "This file is no longer available (or exceeds 1 MiB)";
          return;
        }

        if (text.includes("\0")) {
          if (!on) {
            const info = await inspectFile(fullPath).catch(() => null);
            if (seq !== this.loadSeq) return;
            if (info?.mediaKind) {
              await this.loadMediaKind(info.mediaKind, fullPath, seq, cx);
              return;
            }
            this.enterUnsupported("binary", "Binary file", fullPath, seq, cx, info);
            return;
          }
          this.enterUnsupported("binary", "Remote binary file", fullPath, seq, cx);
          return;
        }

        const t = theme();
        const isTruncated = text.length > MAX_CHARS;
        const canEdit = !on && !isTruncated;
        const value = isTruncated ? text.slice(0, MAX_CHARS) + "\n… (file truncated)" : text;
        const isMdFile = ext === "md" || ext === "markdown";
        const isSvgFile = ext === "svg" && !on;
        this.diskText = text;
        this.loadedFilePath = fullPath;
        this.editable = canEdit;
        this.markdownText = isMdFile ? value : null;
        this.isSvgFile = isSvgFile;
        if (this.mdPreview === null) this.mdPreview = isMdFile;
        if (this.svgPreview === null) this.svgPreview = isSvgFile;

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

        if (isSvgFile) {
          this.mediaLoading = true;
          cx.spawn(async (cx) => {
            try {
              const svgInfo = await loadImagePreview(fullPath);
              if (seq !== this.loadSeq) return;
              this.mediaData = svgInfo;
            } catch (svgErr) {
              if (seq !== this.loadSeq) return;
              this.mediaError = String(svgErr?.message || svgErr || "SVG preview failed");
            } finally {
              if (seq === this.loadSeq) {
                this.mediaLoading = false;
                cx.notify();
              }
            }
          });
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
    this.svgPreview = null;
    this.openWithManual = false;
    this.dirty = false;
    this.saveError = null;
    this.load(slot, cx, { force: true });
    cx.notify();
  }

  openExternalPicker(cx) {
    const slot = this.slot();
    if (!slot || slot.on) return;
    if (this.audioStatus?.state === "playing" && this.audioDaemon) {
      audioRequest(this.audioDaemon, "POST", "/pause")
        .then((st) => {
          this.audioStatus = st;
        })
        .catch(() => null);
    }
    this.openWithManual = true;
    this.openWithError = null;
    this.openWithNotice = null;
    if (!this.openWithData && !this.openWithLoading) {
      this.fetchOpenWithData(joinPath(slot.root, slot.path), this.loadSeq, cx, { focusInput: true });
    } else {
      this.openWithInput.focus();
    }
    cx.notify();
  }

  copyFilePath(fullPath, cx) {
    cx.write_to_clipboard(fullPath);
    this.openWithCopied = true;
    const seq = ++this.copySeq;
    cx.notify();
    cx.timer.after(1500, (cx) => {
      if (this.copySeq === seq) {
        this.openWithCopied = false;
        cx.notify();
      }
    });
  }

  revealCurrentFile(fullPath, cx) {
    cx.spawn(async (cx) => {
      try {
        await revealInFolder(fullPath);
      } catch (e) {
        this.openWithError = String(e?.message || e || "Failed to reveal file");
        cx.notify();
      }
    });
  }

  setAppDefault(app, cx) {
    const slot = this.slot();
    const mime = this.openWithData?.mime;
    if (!slot || !app?.id || !mime) return;
    const fullPath = joinPath(slot.root, slot.path);
    const seq = this.loadSeq;
    cx.spawn(async (cx) => {
      try {
        await setDefaultApp(mime, app.id);
        if (seq !== this.loadSeq) return;
        this.openWithNotice = `Default for ${this.openWithData?.mimeDescription || mime} set to ${app.name}`;
        this.openWithError = null;
        notify({ title: "Default application updated", body: `${app.name} (${mime})`, level: "success", timeout: 2500 });
        this.fetchOpenWithData(fullPath, seq, cx);
      } catch (e) {
        if (seq === this.loadSeq) {
          this.openWithError = String(e?.message || e || "Failed to update default application");
          cx.notify();
        }
      }
    });
  }

  launchHighlightedApp(cx) {
    const { flat } = visibleApps(this.openWithData, this.openWithQuery, this.openWithShowAll);
    const target = flat[this.openWithAt] ?? flat[0] ?? null;
    if (!target && (this.openWithQuery ?? "").trim()) return;
    this.launchExternal(target, cx);
  }

  launchExternal(app, cx) {
    const slot = this.slot();
    if (!slot || slot.on || this.openWithLaunching) return;
    const fullPath = joinPath(slot.root, slot.path);
    const seq = this.loadSeq;
    this.openWithLaunching = true;
    this.openWithError = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await launchApp(app?.id || "--default", fullPath);
        if (seq !== this.loadSeq) return;
        const appLabel = res.app || app?.name || "System Default";
        notify({ title: `Opened ${slot.name || slot.path}`, body: appLabel, level: "info", timeout: 2500 });

        const shouldClose = (Boolean(this.unsupported) || slot.kind === "open-with") && !this.dirty;
        if (shouldClose) {
          if (!this.tabId) this.claimTab();
          const space = spaces().find(
            (s) => s.id === slot.spaceId || (s.tabs ?? []).some((t) => t.id === this.tabId),
          );
          if (this.tabId && (space?.tabs?.length ?? 0) > 1) {
            const slots = { ...(shared("file-view.slots") ?? {}) };
            if (this.slotId && slots[this.slotId]) {
              delete slots[this.slotId];
              setShared("file-view.slots", slots);
            }
            run("tab.close", { id: this.tabId, confirmed: true });
            return;
          }
          this.openWithNotice = `Opened with ${appLabel}`;
        } else if (this.openWithManual && this.hasNativeView()) {
          this.openWithManual = false;
        }
      } catch (e) {
        if (seq === this.loadSeq) {
          this.openWithError = String(e?.message || e || "Failed to launch application");
        }
      } finally {
        if (seq === this.loadSeq) {
          this.openWithLaunching = false;
          cx.notify();
        }
      }
    });
  }

  startAudioPolling(seq, cx) {
    if (this.audioPolling) return;
    this.audioPolling = true;
    cx.spawn(async (cx) => {
      try {
        while (this.audioDaemon && seq === this.loadSeq && this.audioStatus?.state === "playing") {
          await cx.sleep(250);
          if (!this.audioDaemon || seq !== this.loadSeq) break;
          const st = await audioRequest(this.audioDaemon, "GET", "/status");
          if (!this.audioDaemon || seq !== this.loadSeq) break;
          this.audioStatus = st;
          if (this.audioScrubPos === null && st.duration > 0) {
            this.setSliderValue(this.audioSeekSlider, Math.round((st.position / st.duration) * 1000));
          }
          cx.notify();
          if (st.state !== "playing") break;
        }
      } catch {
        // Daemon exited or unreachable.
      } finally {
        this.audioPolling = false;
        cx.notify();
      }
    });
  }

  async ensureAudioDaemon(fullPath, seq) {
    if (this.audioDaemon) return this.audioDaemon;
    this.audioStarting = true;
    this.audioError = null;
    try {
      const daemon = await startAudioDaemon(fullPath);
      if (seq !== this.loadSeq) {
        audioRequest(daemon, "POST", "/quit").catch(() => null);
        return null;
      }
      this.audioDaemon = daemon;
      if (this.audioVolume !== 1 || this.audioMuted) {
        await audioRequest(daemon, "POST", "/volume", {
          volume: this.audioVolume,
          muted: this.audioMuted,
        }).catch(() => null);
      }
      if (this.audioRate !== 1) {
        await audioRequest(daemon, "POST", "/rate", { rate: this.audioRate }).catch(() => null);
      }
      return daemon;
    } finally {
      this.audioStarting = false;
    }
  }

  toggleAudioPlay(cx) {
    const slot = this.slot();
    if (!slot || slot.on || this.mediaMode !== "audio" || this.audioStarting) return;
    const fullPath = joinPath(slot.root, slot.path);
    const seq = this.loadSeq;
    const wasPlaying = this.audioStatus?.state === "playing";
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const daemon = await this.ensureAudioDaemon(fullPath, seq);
        if (!daemon || seq !== this.loadSeq) return;
        const st = await audioRequest(daemon, "POST", wasPlaying ? "/pause" : "/play");
        if (seq !== this.loadSeq) return;
        this.audioStatus = st;
        if (st.duration > 0) {
          this.setSliderValue(this.audioSeekSlider, Math.round((st.position / st.duration) * 1000));
        }
        if (st.state === "playing") this.startAudioPolling(seq, cx);
      } catch (e) {
        if (seq === this.loadSeq) {
          this.audioError = String(e?.message || e || "Audio playback failed");
        }
      } finally {
        if (seq === this.loadSeq) cx.notify();
      }
    });
  }

  seekAudio(targetSec, cx) {
    const slot = this.slot();
    if (!slot || slot.on || this.mediaMode !== "audio") return;
    const fullPath = joinPath(slot.root, slot.path);
    const seq = this.loadSeq;
    const clamped = Math.max(0, Number(targetSec) || 0);
    const dur = this.audioDuration();
    if (dur > 0) {
      this.setSliderValue(this.audioSeekSlider, Math.round((Math.min(dur, clamped) / dur) * 1000));
    }
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const daemon = await this.ensureAudioDaemon(fullPath, seq);
        if (!daemon || seq !== this.loadSeq) return;
        const st = await audioRequest(daemon, "POST", "/seek", { position: clamped });
        if (seq !== this.loadSeq) return;
        this.audioStatus = st;
        if (st.duration > 0) {
          this.setSliderValue(this.audioSeekSlider, Math.round((st.position / st.duration) * 1000));
        }
      } catch (e) {
        if (seq === this.loadSeq) this.audioError = String(e?.message || e || "Seek failed");
      } finally {
        if (seq === this.loadSeq) cx.notify();
      }
    });
  }

  setAudioVolume(volume, muted, cx) {
    this.audioVolume = Math.max(0, Math.min(1, Number(volume)));
    this.audioMuted = Boolean(muted);
    this.setSliderValue(this.audioVolSlider, Math.round(this.audioVolume * 100));
    cx.notify();
    if (!this.audioDaemon) return;
    const seq = this.loadSeq;
    cx.spawn(async (cx) => {
      try {
        const st = await audioRequest(this.audioDaemon, "POST", "/volume", {
          volume: this.audioVolume,
          muted: this.audioMuted,
        });
        if (seq === this.loadSeq) {
          this.audioStatus = st;
          cx.notify();
        }
      } catch {}
    });
  }

  toggleAudioMute(cx) {
    this.setAudioVolume(this.audioVolume, !this.audioMuted, cx);
  }

  cycleAudioRate(cx) {
    const idx = AUDIO_RATES.indexOf(this.audioRate);
    this.audioRate = AUDIO_RATES[(idx + 1) % AUDIO_RATES.length];
    cx.notify();
    if (!this.audioDaemon) return;
    const seq = this.loadSeq;
    cx.spawn(async (cx) => {
      try {
        const st = await audioRequest(this.audioDaemon, "POST", "/rate", { rate: this.audioRate });
        if (seq === this.loadSeq) {
          this.audioStatus = st;
          cx.notify();
        }
      } catch {}
    });
  }

  seekVideoFrame(targetSec, cx) {
    const slot = this.slot();
    if (!slot || slot.on || this.mediaMode !== "video") return;
    const fullPath = joinPath(slot.root, slot.path);
    const dur = this.mediaData?.duration || 0;
    const tSec = dur > 0 ? Math.max(0, Math.min(dur, Number(targetSec) || 0)) : Math.max(0, Number(targetSec) || 0);
    const loadSeq = this.loadSeq;
    const seekSeq = ++this.videoSeekSeq;
    this.videoSeeking = true;
    this.videoScrubPos = tSec;
    if (dur > 0) {
      this.setSliderValue(this.videoSeekSlider, Math.round((tSec / dur) * 1000));
    }
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const frame = await extractVideoFrame(fullPath, tSec);
        if (loadSeq !== this.loadSeq || seekSeq !== this.videoSeekSeq) return;
        this.videoFrame = frame;
        this.videoScrubPos = null;
      } catch (e) {
        if (loadSeq === this.loadSeq && seekSeq === this.videoSeekSeq) {
          this.mediaError = String(e?.message || e || "Failed to extract video frame");
        }
      } finally {
        if (loadSeq === this.loadSeq && seekSeq === this.videoSeekSeq) {
          this.videoSeeking = false;
          this.videoScrubPos = null;
          cx.notify();
        }
      }
    });
  }

  desiredPdfDpi() {
    if (this.pdfFitMode === "manual" && this.pdfZoom > 1.3) return 220;
    return 150;
  }

  cachePdfPage(page, dpi, pageData) {
    if (!this.pdfPageCache) this.pdfPageCache = new Map();
    const key = `${page}:${dpi}`;
    if (this.pdfPageCache.has(key)) this.pdfPageCache.delete(key);
    this.pdfPageCache.set(key, pageData);
    while (this.pdfPageCache.size > 24) {
      const oldest = this.pdfPageCache.keys().next().value;
      this.pdfPageCache.delete(oldest);
    }
  }

  syncPdfSlider(page) {
    const pages = this.mediaData?.pages || 1;
    const sliderVal = pages > 1 ? Math.round(((page - 1) / (pages - 1)) * 999) + 1 : 1;
    this.setSliderValue(this.pdfPageSlider, sliderVal);
  }

  prefetchPdfNeighbors(fullPath, page, dpi, loadSeq, cx) {
    const pages = this.mediaData?.pages || 1;
    const targets = [page + 1, page - 1].filter((p) => p >= 1 && p <= pages && !this.pdfPageCache?.has(`${p}:${dpi}`));
    if (!targets.length) return;
    cx.spawn(async () => {
      for (const p of targets) {
        if (loadSeq !== this.loadSeq || this.mediaMode !== "pdf") return;
        if (this.pdfPageCache?.has(`${p}:${dpi}`)) continue;
        try {
          const data = await loadPdfPage(fullPath, p, dpi);
          if (loadSeq !== this.loadSeq || this.mediaMode !== "pdf") return;
          this.cachePdfPage(p, dpi, data);
        } catch {
          // Ignore prefetch failure.
        }
      }
    });
  }

  goToPdfPage(targetPage, cx, { forceDpi } = {}) {
    const slot = this.slot();
    if (!slot || slot.on || this.mediaMode !== "pdf" || !this.mediaData) return;
    const pages = this.mediaData.pages || 1;
    const page = Math.max(1, Math.min(pages, Math.round(Number(targetPage) || 1)));
    const dpi = forceDpi ?? this.desiredPdfDpi();
    if (page === this.pdfPage && dpi === this.pdfDpi && this.pdfPageData) return;

    this.pdfPage = page;
    this.pdfDpi = dpi;
    this.pdfScrubPage = null;
    this.syncPdfSlider(page);

    const cached = this.pdfPageCache?.get(`${page}:${dpi}`);
    const fullPath = joinPath(slot.root, slot.path);
    if (cached) {
      this.pdfPageData = cached;
      this.pdfPageLoading = false;
      cx.notify();
      this.prefetchPdfNeighbors(fullPath, page, dpi, this.loadSeq, cx);
      return;
    }

    const loadSeq = this.loadSeq;
    const pageSeq = ++this.pdfPageSeq;
    this.pdfPageLoading = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const data = await loadPdfPage(fullPath, page, dpi);
        if (loadSeq !== this.loadSeq || pageSeq !== this.pdfPageSeq) return;
        this.cachePdfPage(page, dpi, data);
        this.pdfPageData = data;
        this.prefetchPdfNeighbors(fullPath, page, dpi, loadSeq, cx);
      } catch (e) {
        if (loadSeq === this.loadSeq && pageSeq === this.pdfPageSeq) {
          this.mediaError = String(e?.message || e || `Failed to render page ${page}`);
        }
      } finally {
        if (loadSeq === this.loadSeq && pageSeq === this.pdfPageSeq) {
          this.pdfPageLoading = false;
          cx.notify();
        }
      }
    });
  }

  setPdfFitMode(mode, cx) {
    if (this.mediaMode !== "pdf") return;
    this.pdfFitMode = mode;
    if (mode !== "manual") this.pdfZoom = 1;
    const nextDpi = this.desiredPdfDpi();
    if (nextDpi !== this.pdfDpi) {
      this.goToPdfPage(this.pdfPage, cx, { forceDpi: nextDpi });
    } else {
      cx.notify();
    }
  }

  stepPdfZoom(delta, visualZoom, cx) {
    if (this.mediaMode !== "pdf") return;
    const base = this.pdfFitMode === "manual" ? this.pdfZoom : visualZoom || 1;
    const next = Math.max(0.5, Math.min(2.5, Math.round((base + delta) * 100) / 100));
    this.pdfFitMode = "manual";
    this.pdfZoom = next;
    const nextDpi = this.desiredPdfDpi();
    if (nextDpi !== this.pdfDpi) {
      this.goToPdfPage(this.pdfPage, cx, { forceDpi: nextDpi });
    } else {
      cx.notify();
    }
  }

  buildPdfTextEditor() {
    if (!this.pdfPagesText || this.pdfTextCode) return;
    const pages = this.pdfPagesText;
    const joined =
      pages.length <= 1
        ? pages[0] ?? ""
        : pages.map((pg, idx) => `--- Page ${idx + 1} ---\n${pg}`).join("\n\n");
    const value = joined.length > MAX_CHARS ? joined.slice(0, MAX_CHARS) + "\n… (PDF text truncated)" : joined;
    this.pdfTextCode = EditorState.new({
      language: "txt",
      readonly: true,
      value: value || "(No selectable text found in PDF)",
      font_family: settings().font_family,
      font_size: 13,
    });
  }

  ensurePdfText(fullPath, loadSeq, cx, { buildEditor = false } = {}) {
    if (this.pdfPagesText) {
      if (buildEditor) this.buildPdfTextEditor();
      if (this.pdfSearchQuery.trim()) this.recomputePdfMatches(cx, { jump: false });
      return;
    }
    if (this.pdfTextLoading) return;
    this.pdfTextLoading = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await loadPdfText(fullPath);
        if (loadSeq !== this.loadSeq || this.mediaMode !== "pdf") return;
        this.pdfPagesText = res.pages ?? [];
        if (buildEditor || this.pdfTextMode) this.buildPdfTextEditor();
        if (this.pdfSearchQuery.trim()) this.recomputePdfMatches(cx, { jump: true });
      } catch (e) {
        if (loadSeq === this.loadSeq) {
          this.mediaError = String(e?.message || e || "Failed to extract PDF text");
        }
      } finally {
        if (loadSeq === this.loadSeq) {
          this.pdfTextLoading = false;
          cx.notify();
        }
      }
    });
  }

  recomputePdfMatches(cx, { jump = false } = {}) {
    const q = (this.pdfSearchQuery || "").trim().toLowerCase();
    if (!q || !this.pdfPagesText) {
      this.pdfMatches = [];
      this.pdfMatchIdx = 0;
      return;
    }
    const matches = [];
    for (let i = 0; i < this.pdfPagesText.length; i++) {
      const text = (this.pdfPagesText[i] || "").toLowerCase();
      if (!text.includes(q)) continue;
      let count = 0;
      let pos = 0;
      while ((pos = text.indexOf(q, pos)) !== -1) {
        count++;
        pos += q.length;
      }
      matches.push({ page: i + 1, count });
    }
    this.pdfMatches = matches;
    this.pdfMatchIdx = 0;
    if (jump && matches.length > 0) {
      this.goToPdfPage(matches[0].page, cx);
    }
  }

  stepPdfMatch(delta, cx) {
    if (!this.pdfMatches.length) return;
    const n = this.pdfMatches.length;
    this.pdfMatchIdx = (this.pdfMatchIdx + delta + n) % n;
    this.goToPdfPage(this.pdfMatches[this.pdfMatchIdx].page, cx);
  }

  togglePdfSearch(cx) {
    const slot = this.slot();
    if (!slot || slot.on || this.mediaMode !== "pdf") return;
    this.pdfSearchOpen = !this.pdfSearchOpen;
    if (this.pdfSearchOpen) {
      this.ensurePdfText(joinPath(slot.root, slot.path), this.loadSeq, cx);
      this.pdfSearchInput.focus();
    } else {
      this.focusHandle.focus();
    }
    cx.notify();
  }

  inMdPreview() {
    return Boolean(this.mdPreview && this.markdownText);
  }

  recomputeFileMatches(cx, { jump = false } = {}) {
    const q = (this.fileSearchQuery || "").toLowerCase();
    if (this.inMdPreview()) {
      this.mdBlocks = splitMdBlocks(this.markdownText);
      this.fileMatches = [];
      this.fileMatchIdx = 0;
      const hits = this.mdBlocks.map(() => false);
      if (q) {
        this.mdBlocks.forEach((b, block) => {
          const n = countBlockHits(b, q);
          hits[block] = n > 0;
          for (let local = 0; local < n; local++) this.fileMatches.push({ block, local });
        });
      }
      this.mdHitCache = { q, blocks: this.mdBlocks, hits };
      if (jump) this.showFileMatch(cx);
      return;
    }
    const lines = (this.code?.value() ?? "").split("\n");
    this.searchLines = lines;
    this.fileMatches = [];
    this.fileMatchIdx = 0;
    if (q) {
      lines.forEach((l, line) => {
        const lower = l.toLowerCase();
        let col = 0;
        while ((col = lower.indexOf(q, col)) !== -1) {
          this.fileMatches.push({ line, col });
          col += q.length;
        }
      });
    }
    if (jump) this.showFileMatch(cx);
  }

  showFileMatch(cx) {
    if (this.inMdPreview()) {
      const m = this.fileMatches[this.fileMatchIdx];
      if (m) this.mdScroll?.scroll_to_item(m.block);
      cx.notify();
      return;
    }
    const m = this.fileMatches[this.fileMatchIdx];
    if (m) this.codeScroll?.scroll_to_item(m.line, "center");
    cx.notify();
  }

  stepFileMatch(delta, cx) {
    const n = this.fileMatches.length;
    if (!n) return;
    this.fileMatchIdx = (this.fileMatchIdx + delta + n) % n;
    this.showFileMatch(cx);
  }

  openFileSearch(cx) {
    this.fileSearchOpen = true;
    this.fileSearchInput.focus();
    if (this.fileSearchQuery) this.recomputeFileMatches(cx);
    cx.notify();
  }

  closeFileSearch(cx) {
    this.fileSearchOpen = false;
    this.focusHandle.focus();
    cx.notify();
  }

  // While searching code, draw lines ourselves (the Editor cannot show or scroll to a match).
  renderCodeSearchView(t) {
    const q = this.fileSearchQuery.toLowerCase();
    if (!this.searchLines.length) this.recomputeFileMatches({ notify() {} });
    const lines = this.searchLines;
    const cur = this.fileMatches[this.fileMatchIdx];
    const byLine = new Map();
    this.fileMatches.forEach((m, idx) => {
      if (!byLine.has(m.line)) byLine.set(m.line, []);
      byLine.get(m.line).push({ col: m.col, cur: idx === this.fileMatchIdx });
    });
    const row = (i) => {
      const text = lines[i] ?? "";
      const body = h_flex().flex_1().min_w(0).whitespace_nowrap();
      let pos = 0;
      for (const h of byLine.get(i) ?? []) {
        if (h.col > pos) body.child(div().child(text.slice(pos, h.col)));
        body.child(
          div().bg(h.cur ? HIT_CUR_BG : HIT_BG).text_color(HIT_FG).child(text.slice(h.col, h.col + q.length)),
        );
        pos = h.col + q.length;
      }
      if (pos < text.length || pos === 0) body.child(div().child(text.slice(pos) || " "));
      return h_flex()
        .w_full()
        .h(20)
        .flex_none()
        .gap(12)
        .px(8)
        .items_center()
        .child(div().w(40).flex_none().text_right().text_color(t.dim).child(String(i + 1)))
        .child(body);
    };
    return div()
      .flex_1()
      .min_h(0)
      .relative()
      .font_family(settings().font_family ?? "JetBrains Mono")
      .text_size(12.5)
      .child(
        v_virtual_list(
          `fv-code-search-${this.slotId}`,
          lines.length,
          20,
          (i) => `${i}-${cur && cur.line === i ? cur.col : ""}-${this.fileSearchQuery}`,
          (range) => {
            const out = [];
            for (let i = range.start; i < range.end; i++) out.push(row(i));
            return out;
          },
        )
          .track_scroll(this.codeScroll)
          .size_full(),
      )
      .child(Scrollbar.vertical(`fv-code-search-${this.slotId}`).viewport_from_layout().absolute().inset_0());
  }

  // Blocks are rendered lazily (only the visible ones) so a huge markdown file doesn't lay out whole.
  renderMdPreview() {
    if (this.mdBlocksSrc !== this.markdownText) {
      this.mdBlocks = splitMdBlocks(this.markdownText);
      this.mdBlocksSrc = this.markdownText;
    }
    const blocks = this.mdBlocks;
    const id = `fv-md-list-${this.slotId}`;
    return v_flex()
      .relative()
      .flex_1()
      .min_h(0)
      .child(
        list(
          id,
          blocks.length,
          (i) => `${i}`,
          (i) => div().px(20).py(6).child(TextView.markdown(`fv-md-${this.slotId}-p${i}`, blocks[i])),
        ).size_full(),
      )
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  renderMdSearchView(t) {
    const q = this.fileSearchQuery.toLowerCase();
    if (!this.mdBlocks.length) this.mdBlocks = splitMdBlocks(this.markdownText);
    const cur = this.fileMatches[this.fileMatchIdx];
    if (this.mdHitCache?.q !== q || this.mdHitCache.blocks !== this.mdBlocks)
      this.mdHitCache = { q, blocks: this.mdBlocks, hits: this.mdBlocks.map((b) => countBlockHits(b, q) > 0) };
    const blocks = this.mdBlocks;
    const hits = this.mdHitCache.hits;
    // Fixed per-block heights (a virtual list needs them, and scroll_to_item works with it): estimate
    // from line count and wrapped length, generously so wrapped text doesn't overlap the next block.
    if (this.mdHeights?.blocks !== blocks)
      this.mdHeights = {
        blocks,
        sizes: blocks.map((b) => {
          let lines = 0;
          for (const l of b.split("\n")) lines += Math.max(1, Math.ceil(l.length / 80));
          return lines * 24 + 24;
        }),
      };
    const id = `fv-md-search-${this.slotId}`;
    return v_flex()
      .relative()
      .flex_1()
      .min_h(0)
      .child(
        v_virtual_list(
          id,
          blocks.length,
          this.mdHeights.sizes,
          (i) => `${i}-${hits[i] ? q : ""}-${cur && cur.block === i ? cur.local : ""}`,
          (range) => {
            const out = [];
            for (let i = range.start; i < range.end; i++) {
              const local = cur && cur.block === i ? cur.local : -1;
              out.push(
                div()
                  .px(20)
                  .py(6)
                  .overflow_hidden()
                  .child(
                    hits[i]
                      ? renderMdMatchBlock(blocks[i], q, local, t)
                      : TextView.markdown(`fv-md-${this.slotId}-s${i}`, blocks[i]),
                  ),
              );
            }
            return out;
          },
        )
          .track_scroll(this.mdScroll)
          .size_full(),
      )
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
  }

  copyPdfPageText(fullPath, cx) {
    const seq = this.loadSeq;
    const page = this.pdfPage;
    const markCopied = () => {
      this.pdfTextCopied = true;
      const cseq = ++this.pdfCopySeq;
      cx.notify();
      cx.timer.after(1500, (cx) => {
        if (this.pdfCopySeq === cseq) {
          this.pdfTextCopied = false;
          cx.notify();
        }
      });
    };

    if (this.pdfPagesText && this.pdfPagesText[page - 1] !== undefined) {
      cx.write_to_clipboard(this.pdfPagesText[page - 1]);
      markCopied();
      return;
    }

    cx.spawn(async (cx) => {
      try {
        const res = await loadPdfText(fullPath, page);
        if (seq !== this.loadSeq) return;
        cx.write_to_clipboard(res.text || "");
        this.pdfTextCopied = true;
        const cseq = ++this.pdfCopySeq;
        cx.notify();
        cx.timer.after(1500, (cx) => {
          if (this.pdfCopySeq === cseq) {
            this.pdfTextCopied = false;
            cx.notify();
          }
        });
      } catch (e) {
        if (seq === this.loadSeq) {
          this.mediaError = String(e?.message || e || "Failed to copy page text");
          cx.notify();
        }
      }
    });
  }

  async close() {
    this.watched = null;
    await this.stopAudio({ wait: true });
    this.code?.release();
    this.code = null;
    this.pdfTextCode?.release();
    this.pdfTextCode = null;
    this.openWithInput?.release();
    this.openWithInput = null;
    this.pdfSearchInput?.release();
    this.pdfSearchInput = null;
    this.fileSearchInput?.release();
    this.fileSearchInput = null;
    this.mdScroll?.release();
    this.mdScroll = null;
    this.codeScroll?.release();
    this.codeScroll = null;
    this.audioSeekSlider?.release();
    this.audioSeekSlider = null;
    this.audioVolSlider?.release();
    this.audioVolSlider = null;
    this.videoSeekSlider?.release();
    this.videoSeekSlider = null;
    this.pdfPageSlider?.release();
    this.pdfPageSlider = null;
  }

  diffRow({ kind, number, text, tokens }, t) {
    const pct = Number(shared("files-tabs.settings")?.diffTint);
    const alpha = Math.round(((Number.isFinite(pct) ? Math.min(30, Math.max(0, pct)) : 10) / 100) * 255).toString(16).padStart(2, "0");
    const tone = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi6, constant: t.ansi6 };
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
      .when(kind === "+", (e) => e.bg(t.ansi2 + alpha))
      .when(kind === "-", (e) => e.bg(t.ansi1 + alpha))
      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(12).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind || " "))
      .child(
        tokens
          ? h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().children(tokens.map((k) => div().flex_none().text_color(tone[k.kind] ?? t.foreground).child(k.text)))
          : div().flex_1().min_w(0).truncate().child(text),
      );
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
      this.resetTransientStates();
      if (!checking()) this.load(slot, cx, { force: true });
    }

    const mode = this.effectiveMode(slot);
    const fullPath = joinPath(slot.root, slot.path);
    const showingOpenWith = this.isShowingOpenWith();
    const isMd = Boolean(this.markdownText) && mode === "file" && !showingOpenWith;
    const isSvg = this.isSvgFile && mode === "file" && !showingOpenWith;
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
      .track_focus(this.focusHandle)
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key?.toLowerCase();
        if (
          k === "s" &&
          (e.modifiers?.control || e.modifiers?.platform) &&
          !e.modifiers?.alt &&
          !e.modifiers?.shift &&
          mode === "file" &&
          this.editable &&
          !showingOpenWith
        ) {
          this.save(cx);
          cx.stop_propagation();
          return;
        }
        if (mode === "file" && !showingOpenWith && !this.mediaMode && this.code) {
          if (k === "f" && (e.modifiers?.control || e.modifiers?.platform) && !e.modifiers?.alt) {
            this.openFileSearch(cx);
            cx.stop_propagation();
            return;
          }
          if (k === "f3" && this.fileSearchOpen) {
            this.stepFileMatch(e.modifiers?.shift ? -1 : 1, cx);
            cx.stop_propagation();
            return;
          }
          if (k === "escape" && this.fileSearchOpen) {
            this.closeFileSearch(cx);
            cx.stop_propagation();
            return;
          }
        }
        if (showingOpenWith) {
          const { flat } = visibleApps(this.openWithData, this.openWithQuery, this.openWithShowAll);
          if (k === "down" || (k === "n" && e.modifiers?.control)) {
            if (flat.length) this.openWithAt = (this.openWithAt + 1) % flat.length;
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if (k === "up" || (k === "p" && e.modifiers?.control)) {
            if (flat.length) this.openWithAt = (this.openWithAt + flat.length - 1) % flat.length;
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if (k === "enter") {
            this.launchHighlightedApp(cx);
            cx.stop_propagation();
            return;
          }
          if (k === "escape") {
            if (this.openWithQuery) {
              this.openWithQuery = "";
              this.openWithAt = 0;
              this.openWithInput.set_value("");
              cx.stop_propagation();
              cx.notify();
            } else if (this.openWithManual && this.hasNativeView()) {
              this.openWithManual = false;
              cx.stop_propagation();
              cx.notify();
            }
            return;
          }
        }
        if (this.mediaMode === "audio" && !showingOpenWith) {
          if (k === "space") {
            this.toggleAudioPlay(cx);
            cx.stop_propagation();
            return;
          }
          if (k === "left" || k === "right") {
            const dur = this.audioDuration();
            const cur = this.audioStatus?.position ?? 0;
            const next = k === "left" ? Math.max(0, cur - 5) : dur > 0 ? Math.min(dur, cur + 5) : cur + 5;
            this.seekAudio(next, cx);
            cx.stop_propagation();
          }
        }
        if (this.mediaMode === "pdf" && !showingOpenWith) {
          if (k === "f" && (e.modifiers?.control || e.modifiers?.platform) && !this.pdfTextMode) {
            if (!this.pdfSearchOpen) this.togglePdfSearch(cx);
            else this.pdfSearchInput.focus();
            cx.stop_propagation();
            return;
          }
          if (k === "escape" && this.pdfSearchOpen) {
            this.togglePdfSearch(cx);
            cx.stop_propagation();
            return;
          }
          if (!this.pdfTextMode && !this.pdfSearchOpen) {
            if (k === "left" || k === "pageup" || k === "k" || k === "p") {
              this.goToPdfPage(this.pdfPage - 1, cx);
              cx.stop_propagation();
              return;
            }
            if (k === "right" || k === "pagedown" || k === "j" || k === "n" || k === "space") {
              this.goToPdfPage(this.pdfPage + 1, cx);
              cx.stop_propagation();
              return;
            }
            if (k === "home") {
              this.goToPdfPage(1, cx);
              cx.stop_propagation();
              return;
            }
            if (k === "end") {
              this.goToPdfPage(this.mediaData?.pages || 1, cx);
              cx.stop_propagation();
              return;
            }
            if (k === "+" || k === "=") {
              this.stepPdfZoom(0.25, null, cx);
              cx.stop_propagation();
              return;
            }
            if (k === "-") {
              this.stepPdfZoom(-0.25, null, cx);
              cx.stop_propagation();
            }
          }
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
          .when(mode === "file" && !showingOpenWith && !this.mediaMode && this.code && !this.fileSearchOpen, (el) =>
            el.child(
              h_flex()
                .gap(2)
                .p(2)
                .rounded(6)
                .bg(t.background)
                .border(1)
                .border_color(t.border)
                .child(chip("fv-find-open", "Find", false, (_e, cx) => this.openFileSearch(cx))),
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
          .when(isSvg, (el) =>
            el.child(
              h_flex()
                .gap(2)
                .p(2)
                .rounded(6)
                .bg(t.background)
                .border(1)
                .border_color(t.border)
                .child(chip("fv-svg-code", "Code", !this.svgPreview, (_e, cx) => { this.svgPreview = false; cx.notify(); }))
                .child(chip("fv-svg-prev", "Preview", this.svgPreview, (_e, cx) => { this.svgPreview = true; cx.notify(); })),
            ),
          )
          .when(this.mediaMode === "pdf" && mode === "file" && !showingOpenWith, (el) =>
            el.child(
              h_flex()
                .gap(2)
                .p(2)
                .rounded(6)
                .bg(t.background)
                .border(1)
                .border_color(t.border)
                .child(
                  chip("fv-pdf-page", "Page", !this.pdfTextMode, (_e, cx) => {
                    this.pdfTextMode = false;
                    this.focusHandle.focus();
                    cx.notify();
                  }),
                )
                .child(
                  chip("fv-pdf-text", "Text", this.pdfTextMode, (_e, cx) => {
                    this.pdfTextMode = true;
                    this.ensurePdfText(fullPath, this.loadSeq, cx, { buildEditor: true });
                    cx.notify();
                  }),
                ),
            ),
          )
          .when(!slot.on, (el) =>
            el.child(
              div()
                .id("fv-open-with-btn")
                .h(24)
                .px(8)
                .flex()
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .text_size(11.5)
                .bg(showingOpenWith ? t.selected : t.chrome)
                .text_color(showingOpenWith ? t.foreground : t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => {
                  if (showingOpenWith && this.hasNativeView()) {
                    this.openWithManual = false;
                    cx.notify();
                  } else {
                    this.openExternalPicker(cx);
                  }
                })
                .child("Open with"),
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
      .when(showingOpenWith, (el) => el.child(renderOpenWithScreen(this, slot, fullPath, t)))
      .when(!showingOpenWith && (mode === "file") && this.mediaMode === "image", (el) =>
        el.child(renderImageView(this, slot, fullPath, t)),
      )
      .when(!showingOpenWith && (mode === "file") && this.mediaMode === "audio", (el) =>
        el.child(renderAudioView(this, slot, fullPath, t)),
      )
      .when(!showingOpenWith && (mode === "file") && this.mediaMode === "video", (el) =>
        el.child(renderVideoView(this, slot, fullPath, t)),
      )
      .when(!showingOpenWith && (mode === "file") && this.mediaMode === "pdf", (el) =>
        el.child(
          this.pdfTextMode
            ? this.pdfTextCode
              ? Editor.new(this.pdfTextCode).flex_1().min_h(0)
              : div().p(16).text_color(t.dim).child(this.pdfTextLoading ? "Extracting PDF text…" : "No text available")
            : renderPdfView(this, slot, fullPath, t),
        ),
      )
      .when(!showingOpenWith && mode === "file" && !this.mediaMode && this.fileSearchOpen, (el) =>
        el.child(
          h_flex()
            .h(38)
            .flex_none()
            .px(12)
            .gap(8)
            .items_center()
            .bg(t.chrome)
            .border_b(1)
            .border_color(t.border)
            .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(t.dim))
            .child(
              div()
                .flex_1()
                .max_w(320)
                .h(26)
                .px(8)
                .flex()
                .items_center()
                .rounded(6)
                .bg(t.background)
                .border(1)
                .border_color(t.border)
                .child(Input.new(this.fileSearchInput).w_full().h_full().text_size(12).text_color(t.foreground)),
            )
            .child(
              div()
                .text_size(11.5)
                .text_color(t.muted)
                .child(
                  !this.fileSearchQuery
                    ? ""
                    : this.fileMatches.length
                      ? `${this.fileMatchIdx + 1} / ${this.fileMatches.length}`
                      : "No matches",
                ),
            )
            .child(chip("fv-find-prev", "Prev", false, (_e, cx) => this.stepFileMatch(-1, cx)))
            .child(chip("fv-find-next", "Next", false, (_e, cx) => this.stepFileMatch(1, cx)))
            .child(div().flex_1())
            .child(chip("fv-find-close", "×", false, (_e, cx) => this.closeFileSearch(cx))),
        ),
      )
      .when(!showingOpenWith && (mode === "file") && !this.mediaMode, (el) =>
        el.child(
          this.error
            ? div().p(16).text_color(t.dim).child(this.error)
            : isSvg && this.svgPreview
              ? renderImageView(this, slot, fullPath, t)
              : this.mdPreview && this.markdownText
                ? this.fileSearchOpen && this.fileSearchQuery.trim()
                  ? this.renderMdSearchView(t)
                  : this.renderMdPreview()
                : this.code && this.fileSearchOpen && this.fileSearchQuery.trim()
                  ? this.renderCodeSearchView(t)
                  : this.code
                  ? Editor.new(this.code).flex_1().min_h(0)
                  : div().p(16).text_color(t.dim).child(this.loading ? "Loading file…" : ""),
        ),
      )
      .when(!showingOpenWith && mode === "diff", (el) =>
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
