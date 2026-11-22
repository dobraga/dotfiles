#!/usr/bin/env python3
"""Background GStreamer audio playback HTTP daemon for Herdr file-view."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import signal
import sys
import threading
import time

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GLib", "2.0")
from gi.repository import GLib, Gst

IDLE_TIMEOUT_SECS = 600.0


class AudioPlayer:
    def __init__(self, initial_file):
        Gst.init(None)
        self.lock = threading.RLock()
        self.playbin = Gst.ElementFactory.make("playbin", "player")
        if self.playbin is None:
            raise RuntimeError("Failed to create GStreamer playbin element")

        self.loop = GLib.MainLoop()
        self.loop_thread = threading.Thread(target=self.loop.run, daemon=True)
        self.loop_thread.start()

        bus = self.playbin.get_bus()
        bus.add_signal_watch()
        bus.connect("message::eos", self._on_eos)
        bus.connect("message::error", self._on_error)

        self.eos = False
        self.error = None
        self.rate = 1.0
        self.volume = 1.0
        self.muted = False
        self.last_activity = time.monotonic()

        self.load(initial_file)

    def _touch(self):
        self.last_activity = time.monotonic()

    def _on_eos(self, _bus, _msg):
        with self.lock:
            self.eos = True
            self._touch()
        self.playbin.set_state(Gst.State.PAUSED)

    def _on_error(self, _bus, msg):
        err, _dbg = msg.parse_error()
        with self.lock:
            self.error = str(err) if err else "GStreamer playback error"
            self._touch()
        self.playbin.set_state(Gst.State.NULL)

    def _current_state_name(self):
        _, cur, _pending = self.playbin.get_state(0)
        if self.eos:
            return "eos"
        if cur == Gst.State.PLAYING:
            return "playing"
        if cur == Gst.State.PAUSED:
            return "paused"
        return "stopped"

    def _query_times(self):
        ok_pos, pos_ns = self.playbin.query_position(Gst.Format.TIME)
        ok_dur, dur_ns = self.playbin.query_duration(Gst.Format.TIME)
        position = max(0.0, pos_ns / Gst.SECOND) if ok_pos and pos_ns >= 0 else 0.0
        duration = max(0.0, dur_ns / Gst.SECOND) if ok_dur and dur_ns >= 0 else 0.0
        return position, duration

    def status(self):
        with self.lock:
            position, duration = self._query_times()
            state = self._current_state_name()
            if state == "playing":
                self._touch()
            return {
                "state": state,
                "position": round(position, 3),
                "duration": round(duration, 3),
                "volume": round(float(self.volume), 3),
                "muted": bool(self.muted),
                "rate": round(float(self.rate), 2),
                "error": self.error,
            }

    def load(self, file_path):
        if not os.path.isfile(file_path):
            raise FileNotFoundError(f"Audio file not found: {file_path}")
        uri = Path(file_path).resolve().as_uri()
        with self.lock:
            self.playbin.set_state(Gst.State.NULL)
            self.eos = False
            self.error = None
            self.rate = 1.0
            self.playbin.set_property("uri", uri)
            self.playbin.set_property("volume", self.volume)
            self.playbin.set_property("mute", self.muted)
            self.playbin.set_state(Gst.State.PAUSED)
            self.playbin.get_state(2 * Gst.SECOND)
            self._touch()
        return self.status()

    def play(self):
        with self.lock:
            self._touch()
            if self.eos:
                self.eos = False
                self._apply_seek_ns(0, self.rate)
            self.error = None
            self.playbin.set_state(Gst.State.PLAYING)
        return self.status()

    def pause(self):
        with self.lock:
            self._touch()
            self.playbin.set_state(Gst.State.PAUSED)
        return self.status()

    def _apply_seek_ns(self, pos_ns, rate):
        flags = Gst.SeekFlags.FLUSH | Gst.SeekFlags.ACCURATE
        if rate >= 0:
            self.playbin.seek(
                rate,
                Gst.Format.TIME,
                flags,
                Gst.SeekType.SET,
                max(0, int(pos_ns)),
                Gst.SeekType.NONE,
                0,
            )

    def seek(self, position_sec):
        with self.lock:
            self._touch()
            self.eos = False
            _, duration = self._query_times()
            target = max(0.0, float(position_sec))
            if duration > 0:
                target = min(target, duration)
            self._apply_seek_ns(int(target * Gst.SECOND), self.rate)
            self.playbin.get_state(int(0.5 * Gst.SECOND))
        return self.status()

    def set_volume(self, volume=None, muted=None):
        with self.lock:
            self._touch()
            if volume is not None:
                self.volume = max(0.0, min(1.0, float(volume)))
                self.playbin.set_property("volume", self.volume)
            if muted is not None:
                self.muted = bool(muted)
                self.playbin.set_property("mute", self.muted)
        return self.status()

    def set_rate(self, rate):
        with self.lock:
            self._touch()
            self.rate = max(0.25, min(3.0, float(rate)))
            pos_s, _ = self._query_times()
            self._apply_seek_ns(int(pos_s * Gst.SECOND), self.rate)
        return self.status()

    def shutdown(self):
        try:
            self.playbin.set_state(Gst.State.NULL)
        except Exception:
            pass
        try:
            self.loop.quit()
        except Exception:
            pass


def make_handler(player, token, shutdown_event):
    class AudioHandler(BaseHTTPRequestHandler):
        def log_message(self, _fmt, *_args):
            return

        def _send_json(self, code, payload):
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _authorized(self):
            return self.headers.get("X-Token") == token

        def _read_body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8")) if raw else {}

        def do_GET(self):
            if not self._authorized():
                self._send_json(403, {"error": "Forbidden"})
                return
            if self.path == "/status":
                self._send_json(200, player.status())
                return
            self._send_json(404, {"error": "Not found"})

        def do_POST(self):
            if not self._authorized():
                self._send_json(403, {"error": "Forbidden"})
                return
            try:
                body = self._read_body()
                if self.path == "/play":
                    self._send_json(200, player.play())
                elif self.path == "/pause":
                    self._send_json(200, player.pause())
                elif self.path == "/seek":
                    self._send_json(200, player.seek(body.get("position", 0)))
                elif self.path == "/volume":
                    self._send_json(200, player.set_volume(body.get("volume"), body.get("muted")))
                elif self.path == "/rate":
                    self._send_json(200, player.set_rate(body.get("rate", 1.0)))
                elif self.path == "/load":
                    self._send_json(200, player.load(body.get("path", "")))
                elif self.path == "/quit":
                    self._send_json(200, {"ok": True})
                    shutdown_event.set()
                else:
                    self._send_json(404, {"error": "Not found"})
            except Exception as exc:
                self._send_json(400, {"error": str(exc)})

    return AudioHandler


def pid_alive(pid):
    if pid <= 1:
        return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def write_ready_atomic(ready_file, payload):
    tmp = f"{ready_file}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, ready_file)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--ready-file", required=True)
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()

    token = secrets.token_hex(16)
    shutdown_event = threading.Event()
    player = None
    server = None

    try:
        player = AudioPlayer(args.file)
        handler_cls = make_handler(player, token, shutdown_event)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        port = server.server_address[1]
        write_ready_atomic(args.ready_file, {"port": port, "token": token, "pid": os.getpid()})
    except Exception as exc:
        try:
            write_ready_atomic(args.ready_file, {"error": str(exc)})
        except Exception:
            pass
        if player:
            player.shutdown()
        sys.exit(1)

    def handle_sig(_sig, _frame):
        shutdown_event.set()

    signal.signal(signal.SIGTERM, handle_sig)
    signal.signal(signal.SIGINT, handle_sig)

    def watchdog():
        while not shutdown_event.is_set():
            if not pid_alive(args.parent_pid):
                shutdown_event.set()
                break
            st = player.status()
            if st["state"] != "playing" and (time.monotonic() - player.last_activity) > IDLE_TIMEOUT_SECS:
                shutdown_event.set()
                break
            shutdown_event.wait(2.0)

        player.shutdown()
        try:
            server.shutdown()
        except Exception:
            pass
        os._exit(0)

    threading.Thread(target=watchdog, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
