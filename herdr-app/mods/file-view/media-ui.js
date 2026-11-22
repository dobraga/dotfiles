// Inline image, audio, and video preview renderers + media helper bridge for Herdr file-view.
import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Slider, SliderTrack, SliderIndicator, SliderThumb, Input } from "gpui-base";
import { appHome, settings } from "herdr";
import { runPythonHelper, formatBytes } from "./open-with-ui.js";

export const AUDIO_RATES = [1, 1.25, 1.5, 2, 0.75];

export function mediaCacheDir() {
  return `${appHome()}/data/file-view-cache`;
}

export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

export function loadImagePreview(fullPath) {
  return runPythonHelper("media-helper.py", ["image-info", mediaCacheDir(), fullPath], { timeout: 25000 });
}

export function loadAudioPreview(fullPath) {
  return runPythonHelper("media-helper.py", ["audio-info", mediaCacheDir(), fullPath], { timeout: 25000 });
}

export function loadVideoPreview(fullPath) {
  return runPythonHelper("media-helper.py", ["video-info", mediaCacheDir(), fullPath], { timeout: 35000 });
}

export function extractVideoFrame(fullPath, sec) {
  return runPythonHelper("media-helper.py", ["video-frame", mediaCacheDir(), fullPath, String(sec)], { timeout: 15000 });
}

export function startAudioDaemon(fullPath) {
  return runPythonHelper("media-helper.py", ["audio-start", fullPath], { timeout: 10000 });
}

export function loadPdfPreview(fullPath) {
  return runPythonHelper("media-helper.py", ["pdf-info", mediaCacheDir(), fullPath], { timeout: 25000 });
}

export function loadPdfPage(fullPath, page, dpi = 150) {
  return runPythonHelper("media-helper.py", ["pdf-page", mediaCacheDir(), fullPath, String(page), String(dpi)], { timeout: 25000 });
}

export function loadPdfText(fullPath, page = null) {
  const args = page !== null && page !== undefined ? ["pdf-text", fullPath, String(page)] : ["pdf-text", fullPath];
  return runPythonHelper("media-helper.py", args, { timeout: 25000 });
}

export async function audioRequest(daemon, method, endpoint, body) {
  if (!daemon?.port || !daemon?.token) throw new Error("Audio daemon not running");
  const res = await fetch(`http://127.0.0.1:${daemon.port}${endpoint}`, {
    method,
    headers: {
      "X-Token": daemon.token,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    throw new Error(parsed?.error || `Audio daemon returned HTTP ${res.status}`);
  }
  return parsed;
}

export function renderSlider(state, t, { height = 22, trackH = 5, thumbSize = 14 } = {}) {
  const trackR = Math.ceil(trackH / 2);
  const thumbR = Math.ceil(thumbSize / 2);
  return Slider.new(state).child(
    SliderTrack.new(state)
      .flex()
      .items_center()
      .h(height)
      .w_full()
      .cursor_pointer()
      .child(
        SliderIndicator.new(state)
          .relative()
          .w_full()
          .h(trackH)
          .rounded(trackR)
          .bg(t.border)
          .range_style((fill) => fill.rounded(trackR).bg(t.accent))
          .child(
            SliderThumb.new(state)
              .size(thumbSize)
              .rounded(thumbR)
              .bg(t.foreground)
              .border(1)
              .border_color(t.border)
              .ml(-Math.round(thumbSize / 2)),
          ),
      ),
  );
}

function pillBtn(id, label, active, t, onClick, { primary = false } = {}) {
  return h_flex()
    .id(id)
    .h(26)
    .px(9)
    .gap(5)
    .items_center()
    .rounded(6)
    .text_size(11.5)
    .font_medium()
    .border(1)
    .border_color(primary ? t.solid : active ? t.accent : t.border)
    .bg(primary ? t.solid : active ? t.selected : t.raised)
    .text_color(primary ? t.solid_foreground : active ? t.foreground : t.muted)
    .cursor_pointer()
    .hover((s) => (primary ? s.opacity(0.9) : s.bg(t.hover).text_color(t.foreground)))
    .on_click(onClick)
    .child(label);
}

export function renderImageView(view, _slot, fullPath, t) {
  const data = view.mediaData;
  if (view.mediaLoading && !data) {
    return div().p(20).text_size(13).text_color(t.dim).child("Loading image preview…");
  }
  if (view.mediaError && !data) {
    return v_flex()
      .p(20)
      .gap(10)
      .child(div().text_size(13).text_color(t.ansi1).child(view.mediaError))
      .child(pillBtn("fv-img-err-ow", "Open with external app", false, t, (_e, cx) => view.openExternalPicker(cx)));
  }
  if (!data) {
    return div().p(20).text_size(13).text_color(t.dim).child("Preparing image preview…");
  }

  const zoom = Number(settings()?.zoom) || 1;
  const vpW = Math.max(120, (view.viewportSize?.width ?? 900) / zoom - 48);
  const vpH = Math.max(120, (view.viewportSize?.height ?? 600) / zoom - 48);
  const imgW = Math.max(1, data.width || 1);
  const imgH = Math.max(1, data.height || 1);
  const fitScale = Math.min(1, vpW / imgW, vpH / imgH);
  const scale = view.imgFit ? fitScale : view.imgZoom;
  const drawW = Math.max(1, Math.round(imgW * scale));
  const drawH = Math.max(1, Math.round(imgH * scale));
  const pct = `${Math.round(scale * 100)}%`;

  const metaParts = [`${imgW} × ${imgH}`, data.format];
  if (data.animated) metaParts.push(`Animated · ${data.frames} frames`);
  if (data.size != null) metaParts.push(formatBytes(data.size));

  const stage = div()
    .border(1)
    .border_color(t.border)
    .rounded(8)
    .overflow_hidden()
    .bg(t.chrome)
    .p(4)
    .child(image(data.relPath).w(drawW).h(drawH));

  return v_flex()
    .id("fv-image-root")
    .flex_1()
    .min_h(0)
    .child(
      div()
        .id("fv-img-viewport")
        .flex_1()
        .min_h(0)
        .on_size_change((size, cx) => {
          const prev = view.viewportSize;
          if (!prev || Math.abs(prev.width - size.width) >= 1 || Math.abs(prev.height - size.height) >= 1) {
            view.viewportSize = size;
            cx.notify();
          }
        })
        .when(view.imgFit, (el) => el.flex().items_center().justify_center().p(16).child(stage))
        .when(!view.imgFit, (el) =>
          el.overflow_scrollbar().p(20).child(div().flex().justify_center().child(stage)),
        ),
    )
    .child(
      h_flex()
        .h(38)
        .flex_none()
        .px(12)
        .gap(8)
        .items_center()
        .bg(t.chrome)
        .border_t(1)
        .border_color(t.border)
        .child(
          pillBtn("fv-img-fit", "Fit", view.imgFit, t, (_e, cx) => {
            view.imgFit = true;
            cx.notify();
          }),
        )
        .child(
          pillBtn("fv-img-100", "100%", !view.imgFit && Math.abs(view.imgZoom - 1) < 0.01, t, (_e, cx) => {
            view.imgFit = false;
            view.imgZoom = 1;
            cx.notify();
          }),
        )
        .child(
          pillBtn("fv-img-minus", "−", false, t, (_e, cx) => {
            const cur = view.imgFit ? fitScale : view.imgZoom;
            view.imgFit = false;
            view.imgZoom = Math.max(0.25, Math.round((cur - 0.25) * 100) / 100);
            cx.notify();
          }),
        )
        .child(
          pillBtn("fv-img-plus", "+", false, t, (_e, cx) => {
            const cur = view.imgFit ? fitScale : view.imgZoom;
            view.imgFit = false;
            view.imgZoom = Math.min(4, Math.round((cur + 0.25) * 100) / 100);
            cx.notify();
          }),
        )
        .child(div().px(6).text_size(11.5).text_color(t.muted).child(pct))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(metaParts.join(" · ")))
        .child(pillBtn("fv-img-reveal", "Reveal in Files", false, t, (_e, cx) => view.revealCurrentFile(fullPath, cx)))
        .child(
          pillBtn("fv-img-copy", view.openWithCopied ? "Copied" : "Copy path", false, t, (_e, cx) =>
            view.copyFilePath(fullPath, cx),
          ),
        ),
    );
}

export function renderAudioView(view, slot, fullPath, t) {
  const data = view.mediaData;
  if (view.mediaLoading && !data) {
    return div().p(20).text_size(13).text_color(t.dim).child("Loading audio metadata…");
  }
  if (view.mediaError && !data) {
    return v_flex()
      .p(20)
      .gap(10)
      .child(div().text_size(13).text_color(t.ansi1).child(view.mediaError))
      .child(pillBtn("fv-aud-err-ow", "Open with external app", false, t, (_e, cx) => view.openExternalPicker(cx)));
  }
  if (!data) {
    return div().p(20).text_size(13).text_color(t.dim).child("Preparing audio player…");
  }

  const fileName = slot.name || slot.path.split(/[\\/]/).pop() || slot.path;
  const title = data.title || fileName;
  const subtitle = [data.artist, data.album].filter(Boolean).join(" · ") || "Audio file";
  const duration = view.audioStatus?.duration > 0 ? view.audioStatus.duration : data.duration || 0;
  const livePos = view.audioScrubPos !== null ? view.audioScrubPos : view.audioStatus?.position ?? 0;
  const progress = duration > 0 ? Math.max(0, Math.min(1, livePos / duration)) : 0;
  const playing = view.audioStatus?.state === "playing";
  const peaks = Array.isArray(data.peaks) && data.peaks.length ? data.peaks : new Array(72).fill(0.25);

  const techParts = [];
  if (data.codec) techParts.push(data.codec);
  if (data.sampleRate) techParts.push(`${Math.round((data.sampleRate / 1000) * 10) / 10} kHz`);
  if (data.channels) techParts.push(`${data.channels}ch`);
  if (data.bitrate) techParts.push(`${Math.round(data.bitrate / 1000)} kbps`);
  if (data.size != null) techParts.push(formatBytes(data.size));

  const playErr = view.audioStatus?.error || view.audioError;

  return v_flex()
    .id("fv-audio-scroll")
    .flex_1()
    .min_h(0)
    .overflow_y_scrollbar()
    .items_center()
    .justify_center()
    .p(24)
    .child(
      v_flex()
        .max_w(640)
        .w_full()
        .p(20)
        .gap(16)
        .rounded(12)
        .bg(t.chrome)
        .border(1)
        .border_color(t.border)
        .child(
          h_flex()
            .gap(14)
            .items_center()
            .child(
              data.coverRelPath
                ? div()
                    .size(72)
                    .flex_none()
                    .rounded(8)
                    .overflow_hidden()
                    .border(1)
                    .border_color(t.border)
                    .child(image(data.coverRelPath).size(72))
                : div()
                    .size(72)
                    .flex_none()
                    .rounded(8)
                    .bg(t.raised)
                    .border(1)
                    .border_color(t.border)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(svg("mods/files/file.svg").size(24).text_color(t.accent)),
            )
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(4)
                .child(div().truncate().text_size(16).font_semibold().text_color(t.foreground).child(title))
                .child(div().truncate().text_size(12.5).text_color(t.muted).child(subtitle))
                .child(div().truncate().text_size(11.5).text_color(t.dim).child(techParts.join(" · "))),
            ),
        )
        .child(
          h_flex()
            .h(64)
            .w_full()
            .px(6)
            .gap(2)
            .items_center()
            .rounded(8)
            .bg(t.background)
            .border(1)
            .border_color(t.border)
            .children(
              peaks.map((amp, i) => {
                const ratio = i / peaks.length;
                const active = ratio <= progress && (livePos > 0 || playing);
                return div()
                  .id(`fv-wave-${i}`)
                  .flex_1()
                  .h(56)
                  .flex()
                  .items_center()
                  .justify_center()
                  .cursor_pointer()
                  .on_click((_e, cx) => {
                    if (duration > 0) view.seekAudio(ratio * duration, cx);
                  })
                  .child(
                    div()
                      .w_full()
                      .h(Math.max(4, Math.round(amp * 48)))
                      .rounded(2)
                      .bg(active ? t.accent : t.border),
                  );
              }),
            ),
        )
        .child(
          h_flex()
            .gap(10)
            .items_center()
            .child(div().w(46).text_size(11.5).text_color(t.muted).child(formatDuration(livePos)))
            .child(div().flex_1().min_w(0).child(renderSlider(view.audioSeekSlider, t)))
            .child(div().w(46).text_size(11.5).text_right().text_color(t.dim).child(formatDuration(duration))),
        )
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(
              pillBtn("fv-aud-back10", "−10s", false, t, (_e, cx) =>
                view.seekAudio(Math.max(0, livePos - 10), cx),
              ),
            )
            .child(
              pillBtn(
                "fv-aud-play",
                view.audioStarting ? "Starting…" : playing ? "Pause" : "Play",
                playing,
                t,
                (_e, cx) => view.toggleAudioPlay(cx),
                { primary: true },
              ),
            )
            .child(
              pillBtn("fv-aud-fwd10", "+10s", false, t, (_e, cx) =>
                view.seekAudio(duration > 0 ? Math.min(duration, livePos + 10) : livePos + 10, cx),
              ),
            )
            .child(
              pillBtn("fv-aud-rate", `${view.audioRate}x`, view.audioRate !== 1, t, (_e, cx) =>
                view.cycleAudioRate(cx),
              ),
            )
            .child(div().flex_1())
            .child(
              pillBtn("fv-aud-mute", view.audioMuted ? "Muted" : "Vol", view.audioMuted, t, (_e, cx) =>
                view.toggleAudioMute(cx),
              ),
            )
            .child(div().w(84).flex_none().child(renderSlider(view.audioVolSlider, t, { height: 22, trackH: 4, thumbSize: 12 }))),
        )
        .when(Boolean(playErr), (el) =>
          el.child(
            h_flex()
              .px(12)
              .py(8)
              .gap(8)
              .items_center()
              .rounded(7)
              .bg(t.ansi1 + "18")
              .border(1)
              .border_color(t.ansi1 + "55")
              .child(div().flex_1().text_size(12).text_color(t.ansi1).child(playErr))
              .child(pillBtn("fv-aud-fallback-ow", "Open with…", false, t, (_e, cx) => view.openExternalPicker(cx))),
          ),
        )
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .pt(4)
            .border_t(1)
            .border_color(t.border)
            .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child("Space: Play/Pause · ←/→: ±5s"))
            .child(pillBtn("fv-aud-reveal", "Reveal in Files", false, t, (_e, cx) => view.revealCurrentFile(fullPath, cx)))
            .child(
              pillBtn("fv-aud-copy", view.openWithCopied ? "Copied" : "Copy path", false, t, (_e, cx) =>
                view.copyFilePath(fullPath, cx),
              ),
            ),
        ),
    );
}

export function renderVideoView(view, _slot, fullPath, t) {
  const data = view.mediaData;
  if (view.mediaLoading && !data) {
    return div().p(20).text_size(13).text_color(t.dim).child("Extracting video preview and storyboard…");
  }
  if (view.mediaError && !data) {
    return v_flex()
      .p(20)
      .gap(10)
      .child(div().text_size(13).text_color(t.ansi1).child(view.mediaError))
      .child(pillBtn("fv-vid-err-ow", "Open with external app", false, t, (_e, cx) => view.openExternalPicker(cx)));
  }
  if (!data) {
    return div().p(20).text_size(13).text_color(t.dim).child("Preparing video preview…");
  }

  const activeRel = view.videoFrame?.relPath || data.posterRelPath;
  const activeW = Math.max(1, view.videoFrame?.width || data.posterWidth || data.width || 640);
  const activeH = Math.max(1, view.videoFrame?.height || data.posterHeight || data.height || 360);
  const activeTime = view.videoFrame?.time ?? data.posterTime ?? 0;
  const displayTime = view.videoScrubPos !== null ? view.videoScrubPos : activeTime;
  const duration = data.duration || 0;

  const zoom = Number(settings()?.zoom) || 1;
  const vpW = Math.max(160, (view.viewportSize?.width ?? 900) / zoom - 32);
  const vpH = Math.max(140, (view.viewportSize?.height ?? 420) / zoom - 24);
  const scale = Math.min(2, vpW / activeW, vpH / activeH);
  const drawW = Math.max(1, Math.round(activeW * scale));
  const drawH = Math.max(1, Math.round(activeH * scale));

  const thumbs = data.thumbs ?? [];
  let nearestIdx = -1;
  let bestDist = Infinity;
  thumbs.forEach((th, idx) => {
    const d = Math.abs(th.time - activeTime);
    if (d < bestDist) {
      bestDist = d;
      nearestIdx = idx;
    }
  });

  const metaParts = [];
  if (data.width && data.height) metaParts.push(`${data.width}×${data.height}`);
  if (data.fps) metaParts.push(`${data.fps} fps`);
  const codecs = [data.videoCodec, data.audioCodec].filter(Boolean).join(" / ");
  if (codecs) metaParts.push(codecs);
  if (duration > 0) metaParts.push(formatDuration(duration));
  if (data.size != null) metaParts.push(formatBytes(data.size));

  return v_flex()
    .id("fv-video-root")
    .flex_1()
    .min_h(0)
    .items_center()
    .child(
      v_flex()
        .max_w(960)
        .size_full()
        .min_h(0)
        .p(16)
        .gap(12)
        .child(
          div()
            .id("fv-vid-stage")
            .flex_1()
            .min_h(0)
            .relative()
            .rounded(10)
            .overflow_hidden()
            .bg(t.chrome)
            .border(1)
            .border_color(t.border)
            .flex()
            .items_center()
            .justify_center()
            .on_size_change((size, cx) => {
              const prev = view.viewportSize;
              if (!prev || Math.abs(prev.width - size.width) >= 1 || Math.abs(prev.height - size.height) >= 1) {
                view.viewportSize = size;
                cx.notify();
              }
            })
            .when(Boolean(activeRel), (el) => el.child(image(activeRel).w(drawW).h(drawH)))
            .when(!activeRel, (el) => el.child(div().text_size(12.5).text_color(t.dim).child("No video frame available")))
            .child(
              div()
                .absolute()
                .right(10)
                .bottom(10)
                .px(8)
                .py(3)
                .rounded(5)
                .bg(t.popover)
                .border(1)
                .border_color(t.border)
                .text_size(11)
                .text_color(t.foreground)
                .child(`${formatDuration(displayTime)} / ${formatDuration(duration)}${view.videoSeeking ? " · Seeking…" : ""}`),
            ),
        )
        .child(
          h_flex()
            .flex_none()
            .gap(10)
            .items_center()
            .child(div().w(46).text_size(11.5).text_color(t.muted).child(formatDuration(displayTime)))
            .child(div().flex_1().min_w(0).child(renderSlider(view.videoSeekSlider, t)))
            .child(div().w(46).text_size(11.5).text_right().text_color(t.dim).child(formatDuration(duration))),
        )
        .when(thumbs.length > 0, (el) =>
          el.child(
            h_flex()
              .id("fv-vid-storyboard")
              .flex_none()
              .w_full()
              .gap(8)
              .items_center()
              .overflow_x_scrollbar()
              .py(2)
              .children(
                thumbs.map((th, idx) => {
                  const active = idx === nearestIdx;
                  return v_flex()
                    .id(`fv-vid-thumb-${idx}`)
                    .flex_none()
                    .w(104)
                    .p(3)
                    .gap(3)
                    .items_center()
                    .rounded(7)
                    .border(1)
                    .border_color(active ? t.accent : t.border)
                    .bg(active ? t.selected : t.chrome)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => view.seekVideoFrame(th.time, cx))
                    .child(div().w(96).h(54).rounded(4).overflow_hidden().child(image(th.relPath).w(96).h(54)))
                    .child(div().text_size(10.5).text_color(active ? t.foreground : t.dim).child(formatDuration(th.time)));
                }),
              ),
          ),
        )
        .child(
          h_flex()
            .flex_none()
            .gap(8)
            .items_center()
            .pt(6)
            .border_t(1)
            .border_color(t.border)
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(metaParts.join(" · ")))
            .child(pillBtn("fv-vid-reveal", "Reveal in Files", false, t, (_e, cx) => view.revealCurrentFile(fullPath, cx)))
            .child(
              pillBtn("fv-vid-copy", view.openWithCopied ? "Copied" : "Copy path", false, t, (_e, cx) =>
                view.copyFilePath(fullPath, cx),
              ),
            )
            .child(pillBtn("fv-vid-ow", "Open with…", false, t, (_e, cx) => view.openExternalPicker(cx), { primary: true })),
        ),
    );
}

export function renderPdfView(view, _slot, fullPath, t) {
  const data = view.mediaData;
  if (view.mediaLoading && !data) {
    return div().p(20).text_size(13).text_color(t.dim).child("Rendering PDF preview…");
  }
  if (view.mediaError && !data) {
    return v_flex()
      .p(20)
      .gap(10)
      .child(div().text_size(13).text_color(t.ansi1).child(view.mediaError))
      .child(pillBtn("fv-pdf-err-ow", "Open with external app", false, t, (_e, cx) => view.openExternalPicker(cx)));
  }
  if (!data) {
    return div().p(20).text_size(13).text_color(t.dim).child("Preparing PDF preview…");
  }

  const active = view.pdfPageData || data;
  const imgW = Math.max(1, active.width || 800);
  const imgH = Math.max(1, active.height || 1100);
  const zoom = Number(settings()?.zoom) || 1;
  const vpW = Math.max(160, (view.viewportSize?.width ?? 900) / zoom);
  const vpH = Math.max(160, (view.viewportSize?.height ?? 620) / zoom);
  const widthTarget = Math.max(120, Math.min(vpW - 40, 1080));
  const baseScale = widthTarget / imgW;

  let scale;
  if (view.pdfFitMode === "page") {
    scale = Math.min((vpW - 40) / imgW, (vpH - 32) / imgH);
  } else if (view.pdfFitMode === "manual") {
    scale = baseScale * view.pdfZoom;
  } else {
    scale = baseScale;
  }

  const drawW = Math.max(1, Math.round(imgW * scale));
  const drawH = Math.max(1, Math.round(imgH * scale));
  const visualZoom = Math.max(0.25, drawW / widthTarget);
  const pct = `${Math.round((view.pdfFitMode === "manual" ? view.pdfZoom : visualZoom) * 100)}%`;

  const displayPage = view.pdfScrubPage !== null ? view.pdfScrubPage : view.pdfPage;
  const totalPages = data.pages || 1;
  const metaParts = [];
  if (data.pageSizeLabel) metaParts.push(data.pageSizeLabel);
  if (data.size != null) metaParts.push(formatBytes(data.size));

  const searchStatus = view.pdfTextLoading
    ? "Extracting text…"
    : !view.pdfSearchQuery?.trim()
      ? "Type to search"
      : view.pdfMatches.length === 0
        ? "No matches"
        : `${view.pdfMatchIdx + 1}/${view.pdfMatches.length} · Page ${view.pdfMatches[view.pdfMatchIdx]?.page ?? 1}`;

  const pageCard = div()
    .rounded(6)
    .overflow_hidden()
    .bg("#ffffff")
    .border(1)
    .border_color(t.border)
    .child(image(active.relPath).w(drawW).h(drawH));

  const navBtn = (id, label, enabled, onClick) =>
    h_flex()
      .id(id)
      .h(26)
      .px(9)
      .items_center()
      .rounded(6)
      .text_size(11.5)
      .font_medium()
      .border(1)
      .border_color(t.border)
      .bg(t.raised)
      .text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
      .child(label);

  return v_flex()
    .id("fv-pdf-root")
    .flex_1()
    .min_h(0)
    .when(view.pdfSearchOpen, (el) =>
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
              .child(Input.new(view.pdfSearchInput).w_full().h_full().text_size(12).text_color(t.foreground)),
          )
          .child(div().text_size(11.5).text_color(t.muted).child(searchStatus))
          .child(navBtn("fv-pdf-match-prev", "Prev", view.pdfMatches.length > 0, (_e, cx) => view.stepPdfMatch(-1, cx)))
          .child(navBtn("fv-pdf-match-next", "Next", view.pdfMatches.length > 0, (_e, cx) => view.stepPdfMatch(1, cx)))
          .child(div().flex_1())
          .child(pillBtn("fv-pdf-search-close", "×", false, t, (_e, cx) => view.togglePdfSearch(cx))),
      ),
    )
    .child(
      div()
        .id("fv-pdf-viewport")
        .flex_1()
        .min_h(0)
        .relative()
        .on_size_change((size, cx) => {
          const prev = view.viewportSize;
          if (!prev || Math.abs(prev.width - size.width) >= 1 || Math.abs(prev.height - size.height) >= 1) {
            view.viewportSize = size;
            cx.notify();
          }
        })
        .when(view.pdfFitMode === "page", (el) => el.flex().items_center().justify_center().p(16).child(pageCard))
        .when(view.pdfFitMode === "width", (el) =>
          el.overflow_y_scrollbar().p(20).child(div().flex().justify_center().child(pageCard)),
        )
        .when(view.pdfFitMode === "manual", (el) =>
          el.overflow_scrollbar().p(20).child(div().flex().justify_center().child(pageCard)),
        )
        .when(view.pdfPageLoading, (el) =>
          el.child(
            div()
              .absolute()
              .right(14)
              .bottom(14)
              .px(8)
              .py(3)
              .rounded(5)
              .bg(t.popover)
              .border(1)
              .border_color(t.border)
              .text_size(11)
              .text_color(t.muted)
              .child("Rendering page…"),
          ),
        ),
    )
    .when(totalPages > 2, (el) =>
      el.child(
        h_flex()
          .h(28)
          .flex_none()
          .px(12)
          .gap(10)
          .items_center()
          .bg(t.chrome)
          .border_t(1)
          .border_color(t.border)
          .child(div().w(68).text_size(11).text_color(t.muted).child(`Page ${displayPage}`))
          .child(div().flex_1().min_w(0).child(renderSlider(view.pdfPageSlider, t, { height: 20, trackH: 4, thumbSize: 12 })))
          .child(div().w(44).text_size(11).text_right().text_color(t.dim).child(String(totalPages))),
      ),
    )
    .child(
      h_flex()
        .h(38)
        .flex_none()
        .px(12)
        .gap(6)
        .items_center()
        .bg(t.chrome)
        .border_t(1)
        .border_color(t.border)
        .child(navBtn("fv-pdf-prev", "← Prev", view.pdfPage > 1, (_e, cx) => view.goToPdfPage(view.pdfPage - 1, cx)))
        .child(div().px(6).text_size(11.5).text_color(t.foreground).child(`Page ${displayPage} / ${totalPages}`))
        .child(navBtn("fv-pdf-next", "Next →", view.pdfPage < totalPages, (_e, cx) => view.goToPdfPage(view.pdfPage + 1, cx)))
        .child(pillBtn("fv-pdf-search", "Search", view.pdfSearchOpen, t, (_e, cx) => view.togglePdfSearch(cx)))
        .child(
          pillBtn("fv-pdf-fitw", "Fit W", view.pdfFitMode === "width", t, (_e, cx) => {
            view.setPdfFitMode("width", cx);
          }),
        )
        .child(
          pillBtn("fv-pdf-fitp", "Fit P", view.pdfFitMode === "page", t, (_e, cx) => {
            view.setPdfFitMode("page", cx);
          }),
        )
        .child(pillBtn("fv-pdf-minus", "−", false, t, (_e, cx) => view.stepPdfZoom(-0.25, visualZoom, cx)))
        .child(pillBtn("fv-pdf-plus", "+", false, t, (_e, cx) => view.stepPdfZoom(0.25, visualZoom, cx)))
        .child(div().px(4).text_size(11.5).text_color(t.muted).child(pct))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(metaParts.join(" · ")))
        .child(
          pillBtn("fv-pdf-copy-text", view.pdfTextCopied ? "Copied" : "Copy text", false, t, (_e, cx) =>
            view.copyPdfPageText(fullPath, cx),
          ),
        )
        .child(pillBtn("fv-pdf-reveal", "Reveal in Files", false, t, (_e, cx) => view.revealCurrentFile(fullPath, cx)))
        .child(
          pillBtn("fv-pdf-copy", view.openWithCopied ? "Copied" : "Copy path", false, t, (_e, cx) =>
            view.copyFilePath(fullPath, cx),
          ),
        ),
    );
}
