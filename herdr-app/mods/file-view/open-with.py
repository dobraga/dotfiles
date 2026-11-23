#!/usr/bin/env python3
"""MIME type, desktop application discovery, launching, and reveal helper for Herdr file-view."""

import json
import mimetypes
import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import gi

    gi.require_version("Gio", "2.0")
    gi.require_version("GLib", "2.0")
    from gi.repository import Gio, GLib

    HAS_GI = True
except Exception:
    Gio = None
    GLib = None
    HAS_GI = False

IMAGE_EXTS = {
    "png",
    "jpg",
    "jpeg",
    "webp",
    "gif",
    "bmp",
    "ico",
    "tiff",
    "tif",
    "avif",
    "heic",
    "heif",
    "svg",
}
AUDIO_EXTS = {
    "mp3",
    "wav",
    "flac",
    "ogg",
    "oga",
    "opus",
    "m4a",
    "aac",
    "wma",
    "aiff",
    "aif",
}
VIDEO_EXTS = {
    "mp4",
    "mkv",
    "webm",
    "mov",
    "avi",
    "m4v",
    "wmv",
    "flv",
    "mpeg",
    "mpg",
    "ogv",
}
GENERIC_MIMES = {"", "application/octet-stream", "inode/x-empty"}


def emit(payload, exit_code=0):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(exit_code)


def classify_media_kind(mime, path):
    m = (mime or "").lower()
    ext = os.path.splitext(path)[1].lstrip(".").lower()
    if m in ("application/pdf", "application/x-pdf") or ext == "pdf":
        return "pdf"
    if m.startswith("image/"):
        return "image"
    if m.startswith("audio/"):
        return "audio"
    if m.startswith("video/"):
        return "video"
    if ext == "ts":
        # Never classify TypeScript files as MPEG-TS video unless MIME explicitly says video/*.
        return None
    if ext in IMAGE_EXTS:
        return "image"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in VIDEO_EXTS:
        return "video"
    return None


def desktop_source(desktop_file):
    if not desktop_file:
        return "system"
    if "/flatpak/" in desktop_file:
        return "flatpak"
    if "/snapd/" in desktop_file:
        return "snap"
    user_dir = os.path.expanduser("~/.local/share/applications/")
    if desktop_file.startswith(user_dir):
        return "user"
    return "system"


def serialize_app(app, is_default=False):
    desktop_file = app.get_filename() if hasattr(app, "get_filename") else None
    terminal = bool(app.get_boolean("Terminal")) if hasattr(app, "get_boolean") else False
    return {
        "id": app.get_id() or "",
        "name": app.get_name() or "",
        "description": app.get_description() or "",
        "executable": app.get_executable() or "",
        "desktopFile": desktop_file,
        "source": desktop_source(desktop_file),
        "terminal": terminal,
        "isDefault": bool(is_default),
    }


def app_dedup_key(app):
    name = (app.get_name() or "").strip().lower()
    exe = os.path.basename(app.get_executable() or "").strip().lower()
    if exe:
        return (name, exe)
    return (name, (app.get_id() or "").strip().lower())


def inspect_with_gi(path):
    gfile = Gio.File.new_for_path(path)
    info = gfile.query_info(
        "standard::content-type,standard::size",
        Gio.FileQueryInfoFlags.NONE,
        None,
    )
    size = int(info.get_size())
    mime = info.get_content_type() or "application/octet-stream"
    mime_desc = Gio.content_type_get_description(mime) or mime
    can_set_default = mime not in GENERIC_MIMES

    default_app = Gio.AppInfo.get_default_for_type(mime, False)
    default_id = default_app.get_id() if default_app else None

    recommended = []
    seen_ids = set()
    seen_keys = set()

    def try_add_rec(app, is_default=False):
        if not app or not app.should_show():
            return
        aid = app.get_id() or ""
        key = app_dedup_key(app)
        if (aid and aid in seen_ids) or key in seen_keys:
            return
        if aid:
            seen_ids.add(aid)
        seen_keys.add(key)
        recommended.append(serialize_app(app, is_default=is_default or (aid == default_id)))

    if default_app:
        try_add_rec(default_app, is_default=True)
    for app in Gio.AppInfo.get_recommended_for_type(mime):
        try_add_rec(app)
    for app in Gio.AppInfo.get_all_for_type(mime):
        try_add_rec(app)

    others = []
    for app in Gio.AppInfo.get_all():
        if not app.should_show():
            continue
        if not (app.supports_files() or app.supports_uris()):
            continue
        aid = app.get_id() or ""
        key = app_dedup_key(app)
        if (aid and aid in seen_ids) or key in seen_keys:
            continue
        if aid:
            seen_ids.add(aid)
        seen_keys.add(key)
        others.append(serialize_app(app, is_default=False))

    others.sort(key=lambda a: (a["name"].lower(), a["id"].lower()))

    return {
        "exists": True,
        "isDir": False,
        "size": size,
        "mime": mime,
        "mimeDescription": mime_desc,
        "canSetDefault": can_set_default,
        "mediaKind": classify_media_kind(mime, path),
        "recommended": recommended,
        "others": others,
    }


def inspect_fallback(path):
    st = os.stat(path)
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    if shutil.which("gio"):
        res = subprocess.run(
            ["gio", "info", "-a", "standard::content-type", path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if res.returncode == 0:
            for line in res.stdout.splitlines():
                if "standard::content-type:" in line:
                    mime = line.split(":", 2)[-1].strip() or mime
                    break
    return {
        "exists": True,
        "isDir": False,
        "size": int(st.st_size),
        "mime": mime,
        "mimeDescription": mime,
        "canSetDefault": mime not in GENERIC_MIMES,
        "mediaKind": classify_media_kind(mime, path),
        "recommended": [],
        "others": [],
    }


def cmd_inspect(path):
    if not os.path.exists(path):
        return {
            "exists": False,
            "brokenSymlink": os.path.islink(path),
        }
    if os.path.isdir(path):
        return {
            "exists": True,
            "isDir": True,
        }
    if HAS_GI:
        return inspect_with_gi(path)
    return inspect_fallback(path)


def spawn_detached(cmd):
    subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )


def _default_opener():
    if sys.platform == "darwin":
        return ["open"]
    if shutil.which("gio"):
        return ["gio", "open"]
    if shutil.which("xdg-open"):
        return ["xdg-open"]
    raise RuntimeError("No opener available (open, gio or xdg-open)")


def find_desktop_app(target):
    if "/" in target:
        return Gio.DesktopAppInfo.new_from_filename(target)
    return Gio.DesktopAppInfo.new(target)


def cmd_launch(target, path):
    if not os.path.exists(path):
        raise FileNotFoundError(f"File not found: {path}")

    if target == "--default":
        spawn_detached(_default_opener() + [path])
        return {"ok": True, "app": "System Default"}

    if HAS_GI:
        app = find_desktop_app(target)
        if not app:
            raise LookupError(f"Application not found: {target}")
        desktop_file = app.get_filename()
        app_id = app.get_id() or target
        app_name = app.get_name() or app_id
        if desktop_file and shutil.which("gio"):
            spawn_detached(["gio", "launch", desktop_file, path])
        elif shutil.which("gtk-launch"):
            spawn_detached(["gtk-launch", app_id, path])
        else:
            app.launch([Gio.File.new_for_path(path)], None)
        return {"ok": True, "app": app_name}

    if shutil.which("gtk-launch"):
        spawn_detached(["gtk-launch", target, path])
        return {"ok": True, "app": target}
    raise RuntimeError("Cannot launch application without gi or gtk-launch")


def cmd_set_default(mime, desktop_id):
    mime = (mime or "").strip()
    if mime in GENERIC_MIMES:
        raise ValueError(f"Refusing to set default for generic MIME type: {mime or 'empty'}")

    if HAS_GI:
        app = find_desktop_app(desktop_id)
        if not app:
            raise LookupError(f"Application not found: {desktop_id}")
        if not app.set_as_default_for_type(mime):
            raise RuntimeError(f"Failed to set {desktop_id} as default for {mime}")
        return {"ok": True, "mime": mime, "id": app.get_id() or desktop_id}

    if shutil.which("gio"):
        res = subprocess.run(
            ["gio", "mime", mime, desktop_id],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if res.returncode != 0:
            raise RuntimeError(res.stderr.strip() or "gio mime failed")
        return {"ok": True, "mime": mime, "id": desktop_id}

    raise RuntimeError("Cannot update default MIME handler without gi or gio")


def cmd_reveal(path):
    if not os.path.lexists(path):
        raise FileNotFoundError(f"File not found: {path}")

    resolved = Path(path).resolve(strict=False)
    uri = resolved.as_uri()
    if HAS_GI:
        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            bus.call_sync(
                "org.freedesktop.FileManager1",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1",
                "ShowItems",
                GLib.Variant("(ass)", ([uri], "")),
                None,
                Gio.DBusCallFlags.NONE,
                2000,
                None,
            )
            return {"ok": True}
        except Exception:
            pass

    if sys.platform == "darwin":
        spawn_detached(["open", "-R", str(resolved)])
        return {"ok": True}
    spawn_detached(_default_opener() + [str(resolved.parent)])
    return {"ok": True}


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if not args:
        emit({"error": "Usage: open-with.py <inspect|launch|set-default|reveal> ..."}, 1)

    cmd = args[0]
    try:
        if cmd == "inspect" and len(args) == 2:
            emit(cmd_inspect(args[1]))
        elif cmd == "launch" and len(args) == 3:
            emit(cmd_launch(args[1], args[2]))
        elif cmd == "set-default" and len(args) == 3:
            emit(cmd_set_default(args[1], args[2]))
        elif cmd == "reveal" and len(args) == 2:
            emit(cmd_reveal(args[1]))
        else:
            emit({"error": f"Invalid arguments for command: {cmd}"}, 1)
    except Exception as exc:
        emit({"error": str(exc)}, 1)


if __name__ == "__main__":
    main()
