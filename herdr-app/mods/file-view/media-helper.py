#!/usr/bin/env python3
"""Media staging, metadata extraction, waveform, and video frame helper for Herdr file-view."""

import array
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

try:
    from PIL import Image, ImageOps

    HAS_PIL = True
except Exception:
    Image = None
    ImageOps = None
    HAS_PIL = False

NATIVE_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico"}
MAX_NATIVE_IMAGE_BYTES = 25 * 1024 * 1024
MAX_CACHE_FILES = 90
MAX_CACHE_BYTES = 80 * 1024 * 1024
WAVEFORM_BARS = 72
STORYBOARD_COUNT = 8
MAX_PDF_TEXT_PAGES = 200
MAX_PDF_TEXT_CHARS = 400000


class PdfEncryptedError(RuntimeError):
    pass


def emit(payload, exit_code=0):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(exit_code)


def cache_key(path):
    st = os.stat(path)
    raw = f"{os.path.abspath(path)}|{st.st_mtime_ns}|{st.st_size}".encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:14], int(st.st_size)


def touch_file(path):
    try:
        os.utime(path, None)
    except OSError:
        pass


def rel_cache_path(filename):
    return f"data/file-view-cache/{filename}"


def prune_cache(cache_dir, max_files=MAX_CACHE_FILES, max_bytes=MAX_CACHE_BYTES):
    if not os.path.isdir(cache_dir):
        return
    entries = []
    total_bytes = 0
    for name in os.listdir(cache_dir):
        full = os.path.join(cache_dir, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        if not os.path.isfile(full):
            continue
        entries.append((st.st_mtime_ns, st.st_size, full))
        total_bytes += st.st_size

    if len(entries) <= max_files and total_bytes <= max_bytes:
        return

    entries.sort(key=lambda item: item[0])
    while entries and (len(entries) > max_files or total_bytes > max_bytes):
        _, sz, full = entries.pop(0)
        try:
            os.unlink(full)
            total_bytes -= sz
        except OSError:
            pass


def parse_svg_length(raw):
    if not raw:
        return None
    raw = raw.strip()
    if raw.endswith("%"):
        return None
    m = re.match(r"^([0-9]+(?:\.[0-9]+)?)", raw)
    if not m:
        return None
    val = float(m.group(1))
    return int(round(val)) if val > 0 else None


def parse_svg_dimensions(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            head = f.read(32768)
    except OSError:
        return 800, 600

    tag_match = re.search(r"<svg\b([^>]*)>", head, re.IGNORECASE | re.DOTALL)
    if not tag_match:
        return 800, 600
    attrs = tag_match.group(1)

    w_match = re.search(r'\bwidth\s*=\s*["\']([^"\']+)["\']', attrs, re.IGNORECASE)
    h_match = re.search(r'\bheight\s*=\s*["\']([^"\']+)["\']', attrs, re.IGNORECASE)
    w = parse_svg_length(w_match.group(1)) if w_match else None
    h = parse_svg_length(h_match.group(1)) if h_match else None
    if w and h:
        return w, h

    vb_match = re.search(r'\bviewBox\s*=\s*["\']([^"\']+)["\']', attrs, re.IGNORECASE)
    if vb_match:
        parts = [p for p in re.split(r"[\s,]+", vb_match.group(1).strip()) if p]
        if len(parts) == 4:
            try:
                vb_w = float(parts[2])
                vb_h = float(parts[3])
                if vb_w > 0 and vb_h > 0:
                    return int(round(vb_w)), int(round(vb_h))
            except ValueError:
                pass
    return w or 800, h or 600


def ffmpeg_transcode_image(src, dst):
    res = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src, "-frames:v", "1", dst],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=20,
    )
    if res.returncode != 0 or not os.path.exists(dst) or os.path.getsize(dst) == 0:
        raise RuntimeError(res.stderr.strip() or "Failed to decode image")


def cmd_image_info(cache_dir, file_path):
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    os.makedirs(cache_dir, exist_ok=True)
    key, size = cache_key(file_path)
    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".svg":
        w, h = parse_svg_dimensions(file_path)
        out_name = f"{key}.svg"
        out_path = os.path.join(cache_dir, out_name)
        if not os.path.exists(out_path):
            shutil.copy2(file_path, out_path)
        else:
            touch_file(out_path)
        prune_cache(cache_dir)
        return {
            "relPath": rel_cache_path(out_name),
            "width": w,
            "height": h,
            "format": "SVG",
            "animated": False,
            "frames": 1,
            "size": size,
        }

    if HAS_PIL:
        try:
            with Image.open(file_path) as im:
                fmt = (im.format or ext.lstrip(".") or "IMAGE").upper()
                animated = bool(getattr(im, "is_animated", False))
                frames = int(getattr(im, "n_frames", 1))
                exif = im.getexif()
                orient = exif.get(274, 1) if exif else 1
                w, h = im.size
                if orient in (5, 6, 7, 8):
                    w, h = h, w

                can_copy_native = (
                    ext in NATIVE_IMAGE_EXTS
                    and size <= MAX_NATIVE_IMAGE_BYTES
                    and (orient == 1 or animated)
                )
                if can_copy_native:
                    out_name = f"{key}{ext}"
                    out_path = os.path.join(cache_dir, out_name)
                    if not os.path.exists(out_path):
                        shutil.copy2(file_path, out_path)
                    else:
                        touch_file(out_path)
                else:
                    out_name = f"{key}.png"
                    out_path = os.path.join(cache_dir, out_name)
                    if not os.path.exists(out_path):
                        work = ImageOps.exif_transpose(im)
                        if size > MAX_NATIVE_IMAGE_BYTES and max(work.size) > 4096:
                            work.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
                        w, h = work.size
                        if work.mode not in ("RGB", "RGBA"):
                            work = work.convert("RGBA" if "A" in work.getbands() else "RGB")
                        work.save(out_path, format="PNG")
                    else:
                        touch_file(out_path)
                        with Image.open(out_path) as cached:
                            w, h = cached.size

                prune_cache(cache_dir)
                return {
                    "relPath": rel_cache_path(out_name),
                    "width": int(w),
                    "height": int(h),
                    "format": fmt,
                    "animated": animated,
                    "frames": frames,
                    "size": size,
                }
        except Exception:
            if not shutil.which("ffmpeg"):
                raise

    # Fallback via ffmpeg for HEIC/AVIF or when Pillow cannot open directly.
    out_name = f"{key}.png"
    out_path = os.path.join(cache_dir, out_name)
    if not os.path.exists(out_path):
        ffmpeg_transcode_image(file_path, out_path)
    else:
        touch_file(out_path)

    w, h = 800, 600
    if HAS_PIL:
        with Image.open(out_path) as cached:
            w, h = cached.size
    prune_cache(cache_dir)
    return {
        "relPath": rel_cache_path(out_name),
        "width": int(w),
        "height": int(h),
        "format": ext.lstrip(".").upper() or "IMAGE",
        "animated": False,
        "frames": 1,
        "size": size,
    }


def run_ffprobe(file_path):
    if not shutil.which("ffprobe"):
        raise RuntimeError("ffprobe is not installed")
    res = subprocess.run(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            file_path,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=15,
    )
    if res.returncode != 0 or not res.stdout.strip():
        raise RuntimeError(res.stderr.strip() or "ffprobe failed to read file")
    return json.loads(res.stdout)


def parse_float(val, default=0.0):
    try:
        out = float(val)
        return out if math.isfinite(out) else default
    except Exception:
        return default


def parse_int(val, default=0):
    try:
        return int(float(val))
    except Exception:
        return default


def parse_fps(rate_str):
    if not rate_str or rate_str == "0/0":
        return None
    if "/" in rate_str:
        num, den = rate_str.split("/", 1)
        n = parse_float(num, 0.0)
        d = parse_float(den, 0.0)
        if d > 0 and n > 0:
            return round(n / d, 2)
        return None
    v = parse_float(rate_str, 0.0)
    return round(v, 2) if v > 0 else None


def compute_waveform(file_path, bars=WAVEFORM_BARS):
    fallback = [0.25] * bars
    if not shutil.which("ffmpeg"):
        return fallback
    try:
        res = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                file_path,
                "-vn",
                "-ac",
                "1",
                "-ar",
                "4000",
                "-f",
                "s16le",
                "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        raw = res.stdout
        usable = len(raw) - (len(raw) % 2)
        if res.returncode != 0 or usable < 2:
            return fallback
        samples = array.array("h")
        samples.frombytes(raw[:usable])
        n = len(samples)
        if n == 0:
            return fallback

        peaks = []
        for i in range(bars):
            start = (i * n) // bars
            end = ((i + 1) * n) // bars
            if end <= start:
                end = min(n, start + 1)
            chunk = samples[start:end]
            rms = math.sqrt(sum(s * s for s in chunk) / len(chunk))
            peaks.append(rms)

        max_peak = max(peaks) if peaks else 0.0
        if max_peak <= 0:
            return fallback
        return [round(max(0.06, min(1.0, p / max_peak)), 3) for p in peaks]
    except Exception:
        return fallback


def cmd_audio_info(cache_dir, file_path):
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    os.makedirs(cache_dir, exist_ok=True)
    key, size = cache_key(file_path)

    probe = run_ffprobe(file_path)
    fmt = probe.get("format") or {}
    streams = probe.get("streams") or []

    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not audio_stream:
        raise RuntimeError("No audio stream found in file")

    cover_stream = next(
        (s for s in streams if (s.get("disposition") or {}).get("attached_pic") == 1),
        None,
    )
    cover_rel = None
    if cover_stream and shutil.which("ffmpeg"):
        cover_name = f"{key}-cover.jpg"
        cover_path = os.path.join(cache_dir, cover_name)
        if not os.path.exists(cover_path):
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-y",
                    "-i",
                    file_path,
                    "-an",
                    "-vcodec",
                    "mjpeg",
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale='min(400,iw)':-2",
                    cover_path,
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=10,
            )
        else:
            touch_file(cover_path)
        if os.path.exists(cover_path) and os.path.getsize(cover_path) > 0:
            cover_rel = rel_cache_path(cover_name)

    tags_raw = {}
    for source in (audio_stream.get("tags") or {}, fmt.get("tags") or {}):
        for k, v in source.items():
            if v is not None:
                tags_raw[str(k).lower()] = str(v).strip()

    duration = parse_float(fmt.get("duration") or audio_stream.get("duration"), 0.0)
    bitrate = parse_int(audio_stream.get("bit_rate") or fmt.get("bit_rate"), 0)

    peaks = compute_waveform(file_path, WAVEFORM_BARS)
    prune_cache(cache_dir)
    return {
        "duration": duration,
        "codec": (audio_stream.get("codec_name") or "").upper(),
        "sampleRate": parse_int(audio_stream.get("sample_rate"), 0),
        "channels": parse_int(audio_stream.get("channels"), 0),
        "bitrate": bitrate,
        "size": size,
        "title": tags_raw.get("title") or "",
        "artist": tags_raw.get("artist") or "",
        "album": tags_raw.get("album") or "",
        "coverRelPath": cover_rel,
        "peaks": peaks,
    }


def extract_jpeg_frame(file_path, t_sec, out_path, scale_expr="scale='min(1280,iw)':-2", quality="3"):
    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        touch_file(out_path)
        return True

    def attempt(ts):
        res = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-ss",
                f"{max(0.0, ts):.3f}",
                "-i",
                file_path,
                "-frames:v",
                "1",
                "-vf",
                scale_expr,
                "-q:v",
                quality,
                out_path,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
        )
        return res.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0

    if attempt(t_sec):
        return True
    if t_sec > 0.0:
        return attempt(max(0.0, t_sec - 0.25))
    return False


def jpeg_dimensions(path, fallback_w, fallback_h):
    if HAS_PIL:
        try:
            with Image.open(path) as im:
                return int(im.width), int(im.height)
        except Exception:
            pass
    return fallback_w, fallback_h


def cmd_video_info(cache_dir, file_path):
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed")
    os.makedirs(cache_dir, exist_ok=True)
    key, size = cache_key(file_path)

    probe = run_ffprobe(file_path)
    fmt = probe.get("format") or {}
    streams = probe.get("streams") or []

    video_stream = next(
        (
            s
            for s in streams
            if s.get("codec_type") == "video" and (s.get("disposition") or {}).get("attached_pic") != 1
        ),
        None,
    )
    if not video_stream:
        raise RuntimeError("No video stream found in file")
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    width = parse_int(video_stream.get("width"), 0)
    height = parse_int(video_stream.get("height"), 0)
    duration = parse_float(fmt.get("duration") or video_stream.get("duration"), 0.0)
    fps = parse_fps(video_stream.get("avg_frame_rate")) or parse_fps(video_stream.get("r_frame_rate"))
    bitrate = parse_int(fmt.get("bit_rate") or video_stream.get("bit_rate"), 0)
    video_codec = (video_stream.get("codec_name") or "").upper()
    audio_codec = (audio_stream.get("codec_name") or "").upper() if audio_stream else ""

    poster_t = min(1.0, duration * 0.1) if duration > 0 else 0.0
    poster_name = f"{key}-poster.jpg"
    poster_path = os.path.join(cache_dir, poster_name)
    poster_rel = None
    poster_w, poster_h = width or 640, height or 360
    if extract_jpeg_frame(file_path, poster_t, poster_path):
        poster_rel = rel_cache_path(poster_name)
        poster_w, poster_h = jpeg_dimensions(poster_path, poster_w, poster_h)

    if duration > 0.5:
        times = [round(duration * (0.05 + 0.90 * (i / (STORYBOARD_COUNT - 1))), 2) for i in range(STORYBOARD_COUNT)]
    else:
        times = [0.0]

    def make_thumb(idx, ts):
        name = f"{key}-thumb-{idx}.jpg"
        out = os.path.join(cache_dir, name)
        if extract_jpeg_frame(file_path, ts, out, scale_expr="scale=240:-2", quality="5"):
            return {"time": ts, "relPath": rel_cache_path(name)}
        return None

    thumbs = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(make_thumb, i, ts) for i, ts in enumerate(times)]
        for fut in futures:
            item = fut.result()
            if item:
                thumbs.append(item)

    prune_cache(cache_dir)
    return {
        "duration": duration,
        "width": width,
        "height": height,
        "fps": fps,
        "videoCodec": video_codec,
        "audioCodec": audio_codec,
        "bitrate": bitrate,
        "size": size,
        "posterTime": poster_t,
        "posterRelPath": poster_rel,
        "posterWidth": poster_w,
        "posterHeight": poster_h,
        "thumbs": thumbs,
    }


def cmd_video_frame(cache_dir, file_path, timestamp_sec):
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed")
    os.makedirs(cache_dir, exist_ok=True)
    key, _ = cache_key(file_path)

    t = max(0.0, float(timestamp_sec))
    ms = int(round(t * 1000))
    name = f"{key}-f-{ms}.jpg"
    out = os.path.join(cache_dir, name)
    if not extract_jpeg_frame(file_path, t, out):
        raise RuntimeError(f"Failed to extract video frame at {t:.2f}s")
    w, h = jpeg_dimensions(out, 640, 360)
    prune_cache(cache_dir)
    return {
        "time": t,
        "relPath": rel_cache_path(name),
        "width": w,
        "height": h,
    }


def cmd_audio_start(file_path):
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    daemon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio-daemon.py")
    if not os.path.isfile(daemon_path):
        raise FileNotFoundError(f"Missing audio-daemon.py at {daemon_path}")

    parent_pid = os.getppid()
    fd, ready_path = tempfile.mkstemp(prefix="herdr-audio-", suffix=".json")
    os.close(fd)
    try:
        os.unlink(ready_path)
    except OSError:
        pass

    try:
        proc = subprocess.Popen(
            [
                sys.executable,
                daemon_path,
                "--file",
                file_path,
                "--ready-file",
                ready_path,
                "--parent-pid",
                str(parent_pid),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )

        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if os.path.exists(ready_path):
                try:
                    with open(ready_path, "r", encoding="utf-8") as f:
                        content = f.read().strip()
                    if content:
                        data = json.loads(content)
                        if isinstance(data, dict) and data.get("error"):
                            raise RuntimeError(data["error"])
                        if isinstance(data, dict) and data.get("port") and data.get("token"):
                            return data
                except (OSError, json.JSONDecodeError):
                    pass
            if proc.poll() is not None:
                raise RuntimeError(f"Audio daemon exited early with code {proc.returncode}")
            time.sleep(0.02)
        raise TimeoutError("Timed out waiting for audio daemon startup")
    finally:
        try:
            if os.path.exists(ready_path):
                os.unlink(ready_path)
        except OSError:
            pass


def clamp_pdf_dpi(raw):
    if raw <= 125:
        return 110
    if raw <= 185:
        return 150
    return 220


def _is_pdf_password_err(stderr_text):
    low = (stderr_text or "").lower()
    return "incorrect password" in low or "encrypted" in low


def render_pdf_page_png(cache_dir, key, file_path, page_num, dpi):
    if not shutil.which("pdftoppm"):
        raise RuntimeError("pdftoppm is not installed")
    out_stem = f"{key}-pdf-p{page_num}-r{dpi}"
    out_name = f"{out_stem}.png"
    prefix = os.path.join(cache_dir, out_stem)
    out_path = f"{prefix}.png"
    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        touch_file(out_path)
    else:
        res = subprocess.run(
            [
                "pdftoppm",
                "-png",
                "-r",
                str(dpi),
                "-f",
                str(page_num),
                "-l",
                str(page_num),
                "-singlefile",
                file_path,
                prefix,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=20,
        )
        if res.returncode != 0:
            if _is_pdf_password_err(res.stderr):
                raise PdfEncryptedError("Password-protected PDF")
            raise RuntimeError(res.stderr.strip() or f"pdftoppm failed on page {page_num}")
        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            raise RuntimeError(f"Failed to render PDF page {page_num}")

    w, h = jpeg_dimensions(out_path, 800, 1100)
    return {
        "page": page_num,
        "dpi": dpi,
        "relPath": rel_cache_path(out_name),
        "width": w,
        "height": h,
    }


def _parse_pdf_page_size(raw_size):
    if not raw_size:
        return ""
    m_paren = re.search(r"\(([^)]+)\)", raw_size)
    if m_paren:
        return m_paren.group(1).strip()
    m_dims = re.match(r"^\s*([0-9.]+)\s*x\s*([0-9.]+)\s*pts?", raw_size, re.IGNORECASE)
    if m_dims:
        return f"{int(round(float(m_dims.group(1))))}×{int(round(float(m_dims.group(2))))} pt"
    return raw_size.strip()


def cmd_pdf_info(cache_dir, file_path):
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    if not shutil.which("pdfinfo") or not shutil.which("pdftoppm"):
        raise RuntimeError("Poppler tools (pdfinfo/pdftoppm) are not installed")
    os.makedirs(cache_dir, exist_ok=True)
    key, size = cache_key(file_path)

    res = subprocess.run(
        ["pdfinfo", file_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
    )
    if res.returncode != 0:
        if _is_pdf_password_err(res.stderr):
            raise PdfEncryptedError("Password-protected PDF")
        raise RuntimeError(res.stderr.strip() or "pdfinfo failed to read file")

    meta = {}
    for line in res.stdout.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip().lower()] = v.strip()

    pages = parse_int(meta.get("pages"), 0)
    if pages < 1:
        raise RuntimeError("PDF has no pages")

    page1 = render_pdf_page_png(cache_dir, key, file_path, 1, 150)
    prune_cache(cache_dir)
    return {
        "pages": pages,
        "title": meta.get("title") or "",
        "author": meta.get("author") or "",
        "pageSizeLabel": _parse_pdf_page_size(meta.get("page size") or ""),
        "size": size,
        "page": 1,
        "dpi": 150,
        "relPath": page1["relPath"],
        "width": page1["width"],
        "height": page1["height"],
    }


def cmd_pdf_page(cache_dir, file_path, page_num, dpi=150):
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    os.makedirs(cache_dir, exist_ok=True)
    key, _ = cache_key(file_path)
    p = max(1, int(page_num))
    d = clamp_pdf_dpi(int(dpi) if dpi else 150)
    page_data = render_pdf_page_png(cache_dir, key, file_path, p, d)
    prune_cache(cache_dir)
    return page_data


def cmd_pdf_text(file_path, page_num=None):
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    if not shutil.which("pdftotext"):
        raise RuntimeError("pdftotext is not installed")

    if page_num is not None:
        p = max(1, int(page_num))
        res = subprocess.run(
            ["pdftotext", "-layout", "-f", str(p), "-l", str(p), file_path, "-"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
        )
        if res.returncode != 0:
            if _is_pdf_password_err(res.stderr):
                raise PdfEncryptedError("Password-protected PDF")
            raise RuntimeError(res.stderr.strip() or f"pdftotext failed on page {p}")
        return {"page": p, "text": res.stdout[:MAX_PDF_TEXT_CHARS]}

    res = subprocess.run(
        ["pdftotext", file_path, "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=20,
    )
    if res.returncode != 0:
        if _is_pdf_password_err(res.stderr):
            raise PdfEncryptedError("Password-protected PDF")
        raise RuntimeError(res.stderr.strip() or "pdftotext failed")

    parts = res.stdout.split("\f")
    if parts and parts[-1] == "":
        parts = parts[:-1]

    capped = []
    total = 0
    truncated = len(parts) > MAX_PDF_TEXT_PAGES
    for pg in parts[:MAX_PDF_TEXT_PAGES]:
        if total >= MAX_PDF_TEXT_CHARS:
            truncated = True
            break
        remain = MAX_PDF_TEXT_CHARS - total
        if len(pg) > remain:
            capped.append(pg[:remain])
            total += remain
            truncated = True
            break
        capped.append(pg)
        total += len(pg)
    return {"pages": capped, "truncated": truncated}


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if not args:
        emit({"error": "Usage: media-helper.py <image-info|audio-info|video-info|video-frame|audio-start|pdf-info|pdf-page|pdf-text> ..."}, 1)

    cmd = args[0]
    try:
        if cmd == "image-info" and len(args) == 3:
            emit(cmd_image_info(args[1], args[2]))
        elif cmd == "audio-info" and len(args) == 3:
            emit(cmd_audio_info(args[1], args[2]))
        elif cmd == "video-info" and len(args) == 3:
            emit(cmd_video_info(args[1], args[2]))
        elif cmd == "video-frame" and len(args) == 4:
            emit(cmd_video_frame(args[1], args[2], args[3]))
        elif cmd == "audio-start" and len(args) == 2:
            emit(cmd_audio_start(args[1]))
        elif cmd == "pdf-info" and len(args) == 3:
            emit(cmd_pdf_info(args[1], args[2]))
        elif cmd == "pdf-page" and len(args) in (4, 5):
            emit(cmd_pdf_page(args[1], args[2], args[3], args[4] if len(args) == 5 else 150))
        elif cmd == "pdf-text" and len(args) in (2, 3):
            emit(cmd_pdf_text(args[1], args[2] if len(args) == 3 else None))
        else:
            emit({"error": f"Invalid arguments for command: {cmd}"}, 1)
    except PdfEncryptedError as exc:
        emit({"encrypted": True, "error": str(exc)}, 1)
    except Exception as exc:
        emit({"error": str(exc)}, 1)


if __name__ == "__main__":
    main()
