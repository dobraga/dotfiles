import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest import mock
import urllib.error
import urllib.request

MOD_DIR = Path(__file__).resolve().parent.parent / "herdr-app" / "mods" / "file-view"
OPEN_WITH_PY = MOD_DIR / "open-with.py"
MEDIA_HELPER_PY = MOD_DIR / "media-helper.py"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


open_with = load_module("open_with", OPEN_WITH_PY)
media_helper = load_module("media_helper", MEDIA_HELPER_PY)


def run_cli(script_path, *args):
    proc = subprocess.run(
        ["/usr/bin/python3", str(script_path), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=20,
    )
    data = json.loads(proc.stdout.strip()) if proc.stdout.strip() else None
    return proc.returncode, data, proc.stderr


class TestOpenWith(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_inspect_pdf_and_dedup(self):
        pdf = self.root / "sample.pdf"
        pdf.write_bytes(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")
        rc, data, err = run_cli(OPEN_WITH_PY, "inspect", str(pdf))
        self.assertEqual(rc, 0, err)
        self.assertTrue(data["exists"])
        self.assertFalse(data["isDir"])
        self.assertEqual(data["mime"], "application/pdf")
        self.assertTrue(data["canSetDefault"])
        self.assertEqual(data["mediaKind"], "pdf")
        rec_ids = [a["id"] for a in data["recommended"]]
        self.assertEqual(len(rec_ids), len(set(rec_ids)))
        self.assertTrue(len(data["others"]) > 0)
        # Ensure recommended IDs are excluded from others.
        other_ids = {a["id"] for a in data["others"]}
        self.assertTrue(set(rec_ids).isdisjoint(other_ids))

    def test_inspect_unknown_binary(self):
        blob = self.root / "mystery.bin"
        blob.write_bytes(b"\xff\xfe\x00\x80\x81\x82\x00\x99" * 16)
        rc, data, err = run_cli(OPEN_WITH_PY, "inspect", str(blob))
        self.assertEqual(rc, 0, err)
        self.assertTrue(data["exists"])
        self.assertEqual(data["mime"], "application/octet-stream")
        self.assertFalse(data["canSetDefault"])
        self.assertIsNone(data["mediaKind"])
        self.assertTrue(len(data["others"]) > 0)

    def test_inspect_typescript_not_video(self):
        ts = self.root / "app.ts"
        ts.write_text("export const answer: number = 42;\n", encoding="utf-8")
        rc, data, err = run_cli(OPEN_WITH_PY, "inspect", str(ts))
        self.assertEqual(rc, 0, err)
        self.assertIsNone(data["mediaKind"])

    def test_inspect_missing_broken_symlink_and_dir(self):
        missing = self.root / "missing.pdf"
        rc, data, _ = run_cli(OPEN_WITH_PY, "inspect", str(missing))
        self.assertEqual(rc, 0)
        self.assertFalse(data["exists"])
        self.assertFalse(data["brokenSymlink"])

        broken = self.root / "broken.pdf"
        broken.symlink_to(self.root / "does_not_exist.pdf")
        rc, data, _ = run_cli(OPEN_WITH_PY, "inspect", str(broken))
        self.assertEqual(rc, 0)
        self.assertFalse(data["exists"])
        self.assertTrue(data["brokenSymlink"])

        subdir = self.root / "folder"
        subdir.mkdir()
        rc, data, _ = run_cli(OPEN_WITH_PY, "inspect", str(subdir))
        self.assertEqual(rc, 0)
        self.assertTrue(data["exists"])
        self.assertTrue(data["isDir"])

    def test_set_default_rejects_generic_or_empty_mime(self):
        for bad_mime in ("application/octet-stream", "inode/x-empty", ""):
            rc, data, _ = run_cli(OPEN_WITH_PY, "set-default", bad_mime, "code_code.desktop")
            self.assertNotEqual(rc, 0)
            self.assertIn("error", data)

    def test_launch_missing_and_detached_mock(self):
        missing = self.root / "nope.pdf"
        rc, data, _ = run_cli(OPEN_WITH_PY, "launch", "--default", str(missing))
        self.assertNotEqual(rc, 0)
        self.assertIn("error", data)

        target = self.root / "doc.pdf"
        target.write_bytes(b"%PDF-1.4\n")
        with mock.patch.object(open_with.subprocess, "Popen") as popen_mock:
            res = open_with.cmd_launch("--default", str(target))
            self.assertTrue(res["ok"])
            popen_mock.assert_called_once()
            args, kwargs = popen_mock.call_args
            self.assertIn(str(target), args[0])
            self.assertTrue(kwargs["start_new_session"])
            self.assertTrue(kwargs["close_fds"])
            self.assertEqual(kwargs["stdin"], open_with.subprocess.DEVNULL)
            self.assertEqual(kwargs["stdout"], open_with.subprocess.DEVNULL)
            self.assertEqual(kwargs["stderr"], open_with.subprocess.DEVNULL)

    def test_reveal_dbus_uri_and_fallback(self):
        target = self.root / "my [file] #1.pdf"
        target.write_bytes(b"%PDF-1.4\n")
        fake_bus = mock.MagicMock()
        with mock.patch.object(open_with.Gio, "bus_get_sync", return_value=fake_bus):
            res = open_with.cmd_reveal(str(target))
            self.assertTrue(res["ok"])
            fake_bus.call_sync.assert_called_once()
            call_args = fake_bus.call_sync.call_args[0]
            self.assertEqual(call_args[3], "ShowItems")
            variant_val = call_args[4].unpack()
            self.assertEqual(variant_val[0], [target.resolve().as_uri()])

        with (
            mock.patch.object(open_with.Gio, "bus_get_sync", side_effect=RuntimeError("no dbus")),
            mock.patch.object(open_with.subprocess, "Popen") as popen_mock,
        ):
            res = open_with.cmd_reveal(str(target))
            self.assertTrue(res["ok"])
            popen_mock.assert_called_once()
            self.assertEqual(popen_mock.call_args[0][0][-1], str(target.resolve().parent))


class TestMediaAndAudioDaemon(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cache_dir = self.root / "data" / "file-view-cache"

    def tearDown(self):
        self.tmp.cleanup()

    def test_image_info_png_gif_svg_and_lru_prune(self):
        from PIL import Image

        png = self.root / "pic.png"
        Image.new("RGBA", (320, 180), (10, 120, 220, 255)).save(png)
        rc, data, err = run_cli(MEDIA_HELPER_PY, "image-info", str(self.cache_dir), str(png))
        self.assertEqual(rc, 0, err)
        self.assertEqual(data["width"], 320)
        self.assertEqual(data["height"], 180)
        self.assertEqual(data["format"], "PNG")
        self.assertFalse(data["animated"])
        cached_file = self.cache_dir / Path(data["relPath"]).name
        self.assertTrue(cached_file.is_file())

        # Animated 2-frame GIF
        gif = self.root / "anim.gif"
        f1 = Image.new("RGB", (64, 48), (255, 0, 0))
        f2 = Image.new("RGB", (64, 48), (0, 255, 0))
        f1.save(gif, save_all=True, append_images=[f2], duration=100, loop=0)
        rc, gdata, err = run_cli(MEDIA_HELPER_PY, "image-info", str(self.cache_dir), str(gif))
        self.assertEqual(rc, 0, err)
        self.assertTrue(gdata["animated"])
        self.assertEqual(gdata["frames"], 2)
        self.assertEqual(gdata["width"], 64)
        self.assertEqual(gdata["height"], 48)

        # SVG viewBox parsing
        svg = self.root / "icon.svg"
        svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect width="120" height="80"/></svg>')
        rc, sdata, err = run_cli(MEDIA_HELPER_PY, "image-info", str(self.cache_dir), str(svg))
        self.assertEqual(rc, 0, err)
        self.assertEqual(sdata["width"], 120)
        self.assertEqual(sdata["height"], 80)
        self.assertEqual(sdata["format"], "SVG")

        # LRU prune test
        for idx in range(5):
            p = self.cache_dir / f"dummy-{idx}.tmp"
            p.write_bytes(b"x" * 100)
            os.utime(p, (1000 + idx, 1000 + idx))
        media_helper.prune_cache(str(self.cache_dir), max_files=3, max_bytes=1024 * 1024)
        remaining = [p for p in self.cache_dir.iterdir() if p.is_file()]
        self.assertLessEqual(len(remaining), 3)

    def test_audio_info_and_daemon_lifecycle(self):
        if not shutil.which("ffmpeg"):
            self.skipTest("ffmpeg unavailable")

        wav = self.root / "tone.wav"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", str(wav)],
            check=True,
        )

        rc, adata, err = run_cli(MEDIA_HELPER_PY, "audio-info", str(self.cache_dir), str(wav))
        self.assertEqual(rc, 0, err)
        self.assertAlmostEqual(adata["duration"], 1.0, delta=0.15)
        self.assertGreater(adata["sampleRate"], 0)
        self.assertEqual(len(adata["peaks"]), 72)
        for pk in adata["peaks"]:
            self.assertGreaterEqual(pk, 0.06)
            self.assertLessEqual(pk, 1.0)

        rc, daemon, err = run_cli(MEDIA_HELPER_PY, "audio-start", str(wav))
        self.assertEqual(rc, 0, err)
        port = daemon["port"]
        token = daemon["token"]
        pid = daemon["pid"]
        base_url = f"http://127.0.0.1:{port}"

        try:
            # Unauthorized without X-Token
            req_unauth = urllib.request.Request(f"{base_url}/status")
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(req_unauth, timeout=3)
            self.assertEqual(ctx.exception.code, 403)

            # Authorized GET /status
            req_status = urllib.request.Request(f"{base_url}/status", headers={"X-Token": token})
            with urllib.request.urlopen(req_status, timeout=3) as resp:
                st = json.loads(resp.read().decode("utf-8"))
            self.assertIn(st["state"], ("paused", "stopped"))
            self.assertAlmostEqual(st["duration"], 1.0, delta=0.2)

            # POST /volume
            req_vol = urllib.request.Request(
                f"{base_url}/volume",
                data=json.dumps({"volume": 0.5, "muted": True}).encode("utf-8"),
                headers={"X-Token": token, "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req_vol, timeout=3) as resp:
                vst = json.loads(resp.read().decode("utf-8"))
            self.assertAlmostEqual(vst["volume"], 0.5, places=2)
            self.assertTrue(vst["muted"])

            # POST /quit
            req_quit = urllib.request.Request(
                f"{base_url}/quit",
                data=b"{}",
                headers={"X-Token": token, "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req_quit, timeout=3) as resp:
                qres = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(qres["ok"])

            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:
                try:
                    os.kill(pid, 0)
                    time.sleep(0.05)
                except ProcessLookupError:
                    break
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        finally:
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass

    def test_video_info_and_frame_extraction(self):
        if not shutil.which("ffmpeg"):
            self.skipTest("ffmpeg unavailable")

        mp4 = self.root / "clip.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=2:size=320x240:rate=15",
                "-pix_fmt",
                "yuv420p",
                str(mp4),
            ],
            check=True,
        )

        rc, vdata, err = run_cli(MEDIA_HELPER_PY, "video-info", str(self.cache_dir), str(mp4))
        self.assertEqual(rc, 0, err)
        self.assertEqual(vdata["width"], 320)
        self.assertEqual(vdata["height"], 240)
        self.assertAlmostEqual(vdata["duration"], 2.0, delta=0.25)
        self.assertTrue(vdata["posterRelPath"])
        poster_path = self.cache_dir / Path(vdata["posterRelPath"]).name
        self.assertTrue(poster_path.is_file())
        self.assertTrue(len(vdata["thumbs"]) > 0)
        for th in vdata["thumbs"]:
            self.assertTrue((self.cache_dir / Path(th["relPath"]).name).is_file())

        rc, fdata, err = run_cli(MEDIA_HELPER_PY, "video-frame", str(self.cache_dir), str(mp4), "1.0")
        self.assertEqual(rc, 0, err)
        self.assertEqual(fdata["width"], 320)
        self.assertEqual(fdata["height"], 240)
        self.assertTrue((self.cache_dir / Path(fdata["relPath"]).name).is_file())

    def test_pdf_info_page_and_text(self):
        if not shutil.which("pdftoppm") or not shutil.which("pdfinfo"):
            self.skipTest("Poppler tools unavailable")
        import cairo

        pdf = self.root / "multi.pdf"
        surf = cairo.PDFSurface(str(pdf), 595, 842)
        ctx = cairo.Context(surf)
        for i in range(1, 4):
            ctx.set_source_rgb(1, 1, 1)
            ctx.paint()
            ctx.set_source_rgb(0.1, 0.1, 0.1)
            ctx.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(24)
            ctx.move_to(72, 100)
            ctx.show_text(f"Page {i}")
            if i == 2:
                ctx.set_font_size(14)
                ctx.move_to(72, 140)
                ctx.show_text("keyword-beta is here")
            ctx.show_page()
        surf.finish()

        rc, pinfo, err = run_cli(MEDIA_HELPER_PY, "pdf-info", str(self.cache_dir), str(pdf))
        self.assertEqual(rc, 0, err)
        self.assertEqual(pinfo["pages"], 3)
        self.assertEqual(pinfo["page"], 1)
        self.assertEqual(pinfo["dpi"], 150)
        self.assertGreater(pinfo["width"], 0)
        self.assertGreater(pinfo["height"], 0)
        self.assertTrue((self.cache_dir / Path(pinfo["relPath"]).name).is_file())

        rc, p2_150, err = run_cli(MEDIA_HELPER_PY, "pdf-page", str(self.cache_dir), str(pdf), "2", "150")
        self.assertEqual(rc, 0, err)
        self.assertEqual(p2_150["page"], 2)
        self.assertEqual(p2_150["dpi"], 150)
        self.assertTrue((self.cache_dir / Path(p2_150["relPath"]).name).is_file())

        rc, p2_220, err = run_cli(MEDIA_HELPER_PY, "pdf-page", str(self.cache_dir), str(pdf), "2", "220")
        self.assertEqual(rc, 0, err)
        self.assertEqual(p2_220["dpi"], 220)
        self.assertGreater(p2_220["width"], p2_150["width"])
        self.assertTrue((self.cache_dir / Path(p2_220["relPath"]).name).is_file())

        rc, tpage2, err = run_cli(MEDIA_HELPER_PY, "pdf-text", str(pdf), "2")
        self.assertEqual(rc, 0, err)
        self.assertEqual(tpage2["page"], 2)
        self.assertIn("keyword-beta", tpage2["text"])
        self.assertNotIn("Page 1", tpage2["text"])

        rc, tall, err = run_cli(MEDIA_HELPER_PY, "pdf-text", str(pdf))
        self.assertEqual(rc, 0, err)
        self.assertEqual(len(tall["pages"]), 3)
        self.assertFalse(tall["truncated"])
        self.assertIn("keyword-beta", tall["pages"][1])


if __name__ == "__main__":
    unittest.main()
