# Plan: Herdr Inline Media Previews, PDF Viewer & Open With Screen

- **Repo:** `/home/dobraga/src/dotfiles`
- **Branch:** `master`
- **Scope:** `herdr-app/mods/file-view/`, `herdr-app/mods/files-tabs/main.js`, `herdr-app/mods/changes-tabs/main.js`, `tests/test_herdr_open_with.py`

## Goal
Replace raw UTF-8 / binary / size preview failures in Herdr's `file-view` with:
1. Inline native media & document previews inside `file-view` tabs:
   - **Images & SVG** (`image()` with LRU cache in `data/file-view-cache/`, Fit/100%/Zoom, metadata, and `Code | Preview` toggle for SVG)
   - **Audio** (waveform, metadata/cover art, seek/volume `Slider`, playback controls backed by an on-demand `GStreamer` daemon)
   - **Video** (poster frame, metadata, timeline `Slider` frame scrubber, clickable 8-frame storyboard)
   - **PDF** (Poppler `pdftoppm`/`pdfinfo`/`pdftotext` page renderer, `Fit W`/`Fit P`/Zoom + 220 DPI hi-res upgrade, `Page | Text` toggle, `Ctrl+F` multi-page search, page scrubber slider, `Copy text`, background neighbor prefetch, and automatic Open With fallback for password-protected PDFs)
2. Inline **"Open With"** application chooser for unsupported files (archives, binaries, encrypted PDFs, etc.) and manual **"Open with"** triggers in `file-view` header and `files-tabs` / `changes-tabs` right-click menus, with MIME discovery (`Gio`), detached launch (`gio launch`), `Set default`, `Reveal in Files` (D-Bus `FileManager1.ShowItems`), `Copy path`, and automatic tab close after launching on unsupported / `open-with` tabs when `space.tabs.length > 1`.

## Checklist
- [x] Research `herdr-app` mods, `gpui-kit` / `gpui-base` APIs, and Linux `Gio` / `GStreamer` / `ffmpeg` / Poppler support
- [x] Create `herdr-app/mods/file-view/open-with.py`
- [x] Create `herdr-app/mods/file-view/media-helper.py`
- [x] Create `herdr-app/mods/file-view/audio-daemon.py`
- [x] Create `herdr-app/mods/file-view/open-with-ui.js`
- [x] Create `herdr-app/mods/file-view/media-ui.js`
- [x] Update `herdr-app/mods/file-view/main.js`
- [x] Update `herdr-app/mods/files-tabs/main.js` and `herdr-app/mods/changes-tabs/main.js`
- [x] Add inline PDF support (`pdf-info`, `pdf-page`, `pdf-text`, `renderPdfView`, `Page | Text`, `Ctrl+F` search, prefetch, encrypted PDF fallback)
- [x] Add automated test suite `tests/test_herdr_open_with.py`
- [x] Run `node --check`, `herdr-app check`, `herdr-app status`, and Python `unittest` suite (11/11 OK)
- [x] Live manual verification in Herdr UI
