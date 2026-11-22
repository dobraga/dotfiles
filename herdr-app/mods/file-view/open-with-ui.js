// Inline "Open With" UI and Python/Gio bridge for Herdr's file-view mod.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { exec, appHome, run } from "herdr";

const TILE_PALETTE = ["ansi4", "ansi5", "ansi2", "ansi3", "ansi6", "ansi1"];

export async function runPythonHelper(scriptName, args = [], { timeout = 30000 } = {}) {
  const scriptPath = `${appHome()}/mods/file-view/${scriptName}`;
  let res;
  try {
    res = await exec("/usr/bin/python3", [scriptPath, ...args], { timeout });
  } catch (e) {
    const msg = String(e || "");
    if (msg.includes("not found") || msg.includes("No such file") || msg.includes("cannot start")) {
      res = await exec("python3", [scriptPath, ...args], { timeout });
    } else {
      throw e;
    }
  }

  let parsed = null;
  const out = (res.stdout || "").trim();
  if (out) {
    try {
      parsed = JSON.parse(out);
    } catch {
      parsed = null;
    }
  }
  if (res.code !== 0) {
    throw new Error(parsed?.error || res.stderr?.trim() || `${scriptName} exited with code ${res.code}`);
  }
  if (!parsed || parsed.error) {
    throw new Error(parsed?.error || `Invalid response from ${scriptName}`);
  }
  return parsed;
}

export function inspectFile(fullPath) {
  return runPythonHelper("open-with.py", ["inspect", fullPath], { timeout: 15000 });
}

export function launchApp(desktopIdOrDefault, fullPath) {
  return runPythonHelper("open-with.py", ["launch", desktopIdOrDefault, fullPath], { timeout: 10000 });
}

export function setDefaultApp(mime, desktopId) {
  return runPythonHelper("open-with.py", ["set-default", mime, desktopId], { timeout: 10000 });
}

export function revealInFolder(fullPath) {
  return runPythonHelper("open-with.py", ["reveal", fullPath], { timeout: 10000 });
}

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fileExtBadge(name) {
  const base = (name || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "FILE";
  return base.slice(dot + 1).toUpperCase().slice(0, 5);
}

export function visibleApps(data, query, showAll) {
  const rec = data?.recommended ?? [];
  const oth = data?.others ?? [];
  const tokens = (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    const expanded = rec.length === 0 || Boolean(showAll);
    const shownOthers = expanded ? oth : [];
    return {
      recommended: rec,
      others: shownOthers,
      flat: [...rec, ...shownOthers],
      hasQuery: false,
      expanded,
    };
  }

  const matches = (app) => {
    const hay = `${app.name ?? ""} ${app.description ?? ""} ${app.executable ?? ""} ${app.id ?? ""}`.toLowerCase();
    return tokens.every((tok) => hay.includes(tok));
  };
  const fRec = rec.filter(matches);
  const fOth = oth.filter(matches);
  return {
    recommended: fRec,
    others: fOth,
    flat: [...fRec, ...fOth],
    hasQuery: true,
    expanded: true,
  };
}

function tileColor(app, t) {
  const s = `${app.name || ""}${app.id || ""}`;
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  const key = TILE_PALETTE[Math.abs(hash) % TILE_PALETTE.length];
  return t[key] || t.accent;
}

function actionBtn(id, label, primary, t, onClick, { disabled = false } = {}) {
  return h_flex()
    .id(id)
    .h(30)
    .px(12)
    .gap(6)
    .items_center()
    .rounded(7)
    .text_size(12)
    .font_medium()
    .border(1)
    .border_color(primary ? (disabled ? t.border : t.solid) : t.border)
    .bg(primary ? (disabled ? t.raised : t.solid) : t.raised)
    .text_color(primary ? (disabled ? t.dim : t.solid_foreground) : disabled ? t.dim : t.foreground)
    .when(!disabled, (el) =>
      el.cursor_pointer().hover((s) => (primary ? s.opacity(0.9) : s.bg(t.hover))),
    )
    .when(!disabled, (el) => el.on_click(onClick))
    .child(label);
}

export function renderOpenWithScreen(view, slot, fullPath, t) {
  const fileName = slot.name || slot.path.split(/[\\/]/).pop() || slot.path;
  const extBadge = fileExtBadge(fileName);
  const data = view.openWithData;
  const reasonLabel =
    view.unsupported?.detail ||
    (slot.kind === "open-with" ? "Open externally" : "Open with application");

  if (slot.on) {
    return v_flex()
      .id("fv-open-with-remote")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .items_center()
      .p(28)
      .child(
        v_flex()
          .max_w(620)
          .w_full()
          .p(20)
          .gap(14)
          .rounded(10)
          .bg(t.chrome)
          .border(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(12)
              .items_center()
              .child(
                div()
                  .px(10)
                  .py(6)
                  .rounded(7)
                  .bg(t.raised)
                  .border(1)
                  .border_color(t.border)
                  .text_size(11)
                  .font_semibold()
                  .text_color(t.accent)
                  .child(extBadge),
              )
              .child(
                v_flex()
                  .flex_1()
                  .min_w(0)
                  .gap(2)
                  .child(div().truncate().text_size(15).font_semibold().text_color(t.foreground).child(fileName))
                  .child(div().truncate().text_size(12).text_color(t.muted).child(`Remote file on ${slot.on}`)),
              ),
          )
          .child(
            div()
              .text_size(12.5)
              .text_color(t.muted)
              .child(
                `${view.unsupported?.detail || "This file cannot be previewed as text"} and lives on remote machine "${slot.on}", so local desktop applications cannot open it directly.`,
              ),
          )
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(fullPath))
          .child(
            h_flex()
              .gap(8)
              .child(
                actionBtn("fv-ow-remote-copy", view.openWithCopied ? "Copied" : "Copy path", true, t, (_e, cx) =>
                  view.copyFilePath(fullPath, cx),
                ),
              )
              .child(
                actionBtn("fv-ow-remote-term", "Open Terminal", false, t, () =>
                  run("terminal.open", { place: "right", folder: slot.root }),
                ),
              ),
          ),
      );
  }

  const defaultApp = data?.recommended?.find((a) => a.isDefault) ?? data?.recommended?.[0] ?? null;
  const primaryLabel = view.openWithLaunching
    ? "Opening…"
    : defaultApp
      ? `Open with ${defaultApp.name}`
      : "Open with System Default";

  const { recommended, others, flat, hasQuery, expanded } = visibleApps(
    data,
    view.openWithQuery,
    view.openWithShowAll,
  );
  if (flat.length > 0) {
    view.openWithAt = Math.max(0, Math.min(view.openWithAt, flat.length - 1));
  } else {
    view.openWithAt = 0;
  }

  const metaParts = [];
  if (data?.mimeDescription) metaParts.push(data.mimeDescription);
  if (data?.mime && data.mime !== data.mimeDescription) metaParts.push(data.mime);
  if (data?.size != null) metaParts.push(formatBytes(data.size));

  let cursorIdx = 0;

  const renderAppRow = (app) => {
    const idx = cursorIdx++;
    const active = idx === view.openWithAt;
    const accent = tileColor(app, t);
    const letter = (app.name || app.id || "?").trim().charAt(0).toUpperCase() || "?";
    const sub = app.description || app.executable || app.id;
    const srcTag = app.source === "flatpak" ? "Flatpak" : app.source === "snap" ? "Snap" : null;

    return h_flex()
      .id(`fv-ow-app-${idx}`)
      .w_full()
      .min_h(44)
      .px(12)
      .py(7)
      .gap(10)
      .items_center()
      .rounded(8)
      .border(1)
      .border_color(active ? t.accent : t.border)
      .bg(active ? t.selected : t.background)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => view.launchExternal(app, cx))
      .child(
        div()
          .size(28)
          .flex_none()
          .rounded(7)
          .bg(accent + "24")
          .border(1)
          .border_color(accent + "55")
          .flex()
          .items_center()
          .justify_center()
          .text_size(12.5)
          .font_semibold()
          .text_color(accent)
          .child(letter),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().truncate().text_size(13).font_medium().text_color(t.foreground).child(app.name || app.id))
              .when(app.isDefault, (el) =>
                el.child(
                  div()
                    .px(6)
                    .py(1)
                    .rounded(4)
                    .bg(t.accent + "24")
                    .border(1)
                    .border_color(t.accent + "66")
                    .text_size(10)
                    .font_medium()
                    .text_color(t.accent)
                    .child("Default"),
                ),
              )
              .when(Boolean(srcTag), (el) =>
                el.child(
                  div()
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.raised)
                    .border(1)
                    .border_color(t.border)
                    .text_size(10)
                    .text_color(t.dim)
                    .child(srcTag),
                ),
              ),
          )
          .when(Boolean(sub), (el) =>
            el.child(div().truncate().text_size(11.5).text_color(t.dim).child(sub)),
          ),
      )
      .when(Boolean(data?.canSetDefault) && !app.isDefault, (el) =>
        el.child(
          div()
            .id(`fv-ow-setdef-${idx}`)
            .h(24)
            .px(8)
            .flex_none()
            .flex()
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(t.border)
            .bg(t.raised)
            .text_size(11)
            .text_color(t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
              cx.stop_propagation();
              view.setAppDefault(app, cx);
            })
            .child("Set default"),
        ),
      );
  };

  return v_flex()
    .id("fv-open-with-scroll")
    .flex_1()
    .min_h(0)
    .overflow_y_scrollbar()
    .items_center()
    .p(24)
    .child(
      v_flex()
        .max_w(680)
        .w_full()
        .gap(14)
        .child(
          v_flex()
            .p(16)
            .gap(12)
            .rounded(10)
            .bg(t.chrome)
            .border(1)
            .border_color(t.border)
            .child(
              h_flex()
                .gap(12)
                .items_center()
                .child(
                  div()
                    .min_w(44)
                    .h(44)
                    .px(8)
                    .flex_none()
                    .rounded(8)
                    .bg(t.raised)
                    .border(1)
                    .border_color(t.border)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(11.5)
                    .font_semibold()
                    .text_color(t.accent)
                    .child(extBadge),
                )
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(3)
                    .child(
                      h_flex()
                        .gap(8)
                        .items_center()
                        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(fileName))
                        .child(
                          div()
                            .flex_none()
                            .px(7)
                            .py(2)
                            .rounded(5)
                            .bg(t.raised)
                            .border(1)
                            .border_color(t.border)
                            .text_size(10.5)
                            .text_color(t.muted)
                            .child(reasonLabel),
                        ),
                    )
                    .child(
                      div()
                        .truncate()
                        .text_size(12)
                        .text_color(t.muted)
                        .child(metaParts.length ? metaParts.join(" · ") : view.openWithLoading ? "Inspecting file type…" : "Binary or unsupported file"),
                    )
                    .child(div().truncate().text_size(11).text_color(t.dim).child(fullPath)),
                ),
            )
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(
                  actionBtn(
                    "fv-ow-launch-default",
                    primaryLabel,
                    true,
                    t,
                    (_e, cx) => view.launchExternal(defaultApp, cx),
                    { disabled: Boolean(view.openWithLaunching) },
                  ),
                )
                .child(
                  actionBtn("fv-ow-reveal", "Reveal in Files", false, t, (_e, cx) =>
                    view.revealCurrentFile(fullPath, cx),
                  ),
                )
                .child(
                  actionBtn("fv-ow-copy", view.openWithCopied ? "Copied" : "Copy path", false, t, (_e, cx) =>
                    view.copyFilePath(fullPath, cx),
                  ),
                )
                .when(view.hasNativeView(), (el) =>
                  el.child(
                    actionBtn("fv-ow-back", "Back (Esc)", false, t, (_e, cx) => {
                      view.openWithManual = false;
                      cx.notify();
                    }),
                  ),
                ),
            ),
        )
        .when(Boolean(view.openWithNotice), (el) =>
          el.child(
            div()
              .px(12)
              .py(8)
              .rounded(7)
              .bg(t.ansi2 + "18")
              .border(1)
              .border_color(t.ansi2 + "55")
              .text_size(12)
              .text_color(t.ansi2)
              .child(view.openWithNotice),
          ),
        )
        .when(Boolean(view.openWithError), (el) =>
          el.child(
            div()
              .px(12)
              .py(8)
              .rounded(7)
              .bg(t.ansi1 + "18")
              .border(1)
              .border_color(t.ansi1 + "55")
              .text_size(12)
              .text_color(t.ansi1)
              .child(view.openWithError),
          ),
        )
        .child(
          h_flex()
            .h(36)
            .px(10)
            .gap(8)
            .items_center()
            .rounded(8)
            .bg(t.chrome)
            .border(1)
            .border_color(t.border)
            .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(t.dim))
            .child(Input.new(view.openWithInput).flex_1().h_full().text_size(12.5).text_color(t.foreground))
            .child(div().flex_none().text_size(11).text_color(t.dim).child("↑↓ Enter")),
        )
        .when(view.openWithLoading && !data, (el) =>
          el.child(div().p(12).text_size(12.5).text_color(t.dim).child("Finding installed applications…")),
        )
        .when(Boolean(data) && !hasQuery && recommended.length === 0, (el) =>
          el.child(
            div()
              .px(12)
              .py(8)
              .rounded(7)
              .bg(t.chrome)
              .border(1)
              .border_color(t.border)
              .text_size(12)
              .text_color(t.muted)
              .child(`No applications are registered for ${data.mime || "this file type"}. Pick one from installed applications below:`),
          ),
        )
        .when(recommended.length > 0, (el) =>
          el.child(
            v_flex()
              .gap(6)
              .child(
                div()
                  .px(2)
                  .text_size(11)
                  .font_semibold()
                  .text_color(t.dim)
                  .child(hasQuery ? "Matching recommended" : "Recommended"),
              )
              .children(recommended.map(renderAppRow)),
          ),
        )
        .when(Boolean(data) && !hasQuery && (data.others?.length ?? 0) > 0 && data.recommended.length > 0, (el) =>
          el.child(
            h_flex()
              .id("fv-ow-toggle-all")
              .px(10)
              .py(7)
              .rounded(7)
              .bg(t.chrome)
              .border(1)
              .border_color(t.border)
              .items_center()
              .justify_between()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                view.openWithShowAll = !view.openWithShowAll;
                cx.notify();
              })
              .child(
                div()
                  .text_size(12)
                  .font_medium()
                  .text_color(t.muted)
                  .child(`All installed applications (${data.others.length})`),
              )
              .child(div().text_size(11).text_color(t.dim).child(expanded ? "Hide ▲" : "Show ▼")),
          ),
        )
        .when(others.length > 0, (el) =>
          el.child(
            v_flex()
              .gap(6)
              .when(hasQuery || recommended.length === 0, (s) =>
                s.child(
                  div()
                    .px(2)
                    .text_size(11)
                    .font_semibold()
                    .text_color(t.dim)
                    .child(hasQuery ? "All matching applications" : `All installed applications (${others.length})`),
                ),
              )
              .children(others.map(renderAppRow)),
          ),
        )
        .when(Boolean(data) && flat.length === 0, (el) =>
          el.child(
            div()
              .p(14)
              .text_size(12.5)
              .text_color(t.dim)
              .child(hasQuery ? `No applications matching "${view.openWithQuery.trim()}"` : "No file-capable applications found"),
          ),
        ),
    );
}
