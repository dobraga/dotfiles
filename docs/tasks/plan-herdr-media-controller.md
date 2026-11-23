# Plan: Herdr Bottom-Bar Media Controller (`workspace-status-usage` + `media-card`)

- **Repo:** `/home/dobraga/src/dotfiles`
- **Branch:** `master`
- **Scope:**
  - `herdr-app/mods/workspace-status-usage/media.js`
  - `herdr-app/mods/workspace-status-usage/main.js`
  - `herdr-app/mods/media-card/mod.json`
  - `herdr-app/mods/media-card/main.js`
  - `herdr-app/mods/media-card/icons/*.svg`
  - `tests/test_herdr_media.test.js`

## Goal
Add a native MPRIS2/D-Bus media controller (YouTube, YouTube Music, Spotify Web/Desktop, and generic MPRIS2 players) to Herdr's bottom status bar (`workspace-status-usage`) with a floating hover/pinned details card (`media-card`), following user preferences:
1. Hide the bottom-bar pill completely when no media is active.
2. Show inline mini controls (`prev` when supported, `play/pause`, `next` when supported) + truncated `Title · Artist` on the bottom bar.
3. Do not modify `herdr-app/keys.json`.

## Architecture Notes
- **MPRIS2 via `busctl --user`**: zero extra dependencies; queries `org.mpris.MediaPlayer2.*` in ~3 ms. Always pass `--` before bus names/args so negative seek deltas are never parsed as flags.
- **No `shared.json` churn**: `workspace-status-usage` computes a signature excluding `positionUs`/`syncedAt` and only calls `setShared("media.state", ...)` when metadata, status, players, art, or volume actually change. `media-card` interpolates elapsed time locally once per second while open.
- **Artwork cache outside `mods/`**: cached under `<appHome()>/data/media-card/` (LRU max 12 files) to avoid triggering Herdr's mod hot-reload. Local `/tmp/` thumbnails (Brave/Chromium) are copied via `exec("cp", ...)` and renamed after inspecting magic bytes.
- **Volume routing**: native players use MPRIS2 `Volume`; browsers where MPRIS2 `Volume` is read-only fall back to PipeWire `wpctl @DEFAULT_AUDIO_SINK@`.

## Checklist
- [x] Research Herdr layout, `gpui-kit` / `herdr` APIs, `busctl` MPRIS2 output, and `wpctl`
- [x] Create `herdr-app/mods/media-card/icons/*.svg`
- [x] Create `herdr-app/mods/workspace-status-usage/media.js`
- [x] Update `herdr-app/mods/workspace-status-usage/main.js` (`#status-media` pill, hover/pin coordination with `usage-card`, MPRIS polling & command dispatch)
- [x] Create `herdr-app/mods/media-card/mod.json` and `herdr-app/mods/media-card/main.js`
- [x] Symlink `~/.config/herdr-app/mods/media-card`
- [x] Add `tests/test_herdr_media.test.js` and run `bun test`
- [x] Run `herdr-app check`, `herdr-app status`, and inspect `herdr-app shot`
- [ ] Live manual verification in Herdr UI by the user

## Deviations (pivot notes)
- Mods cannot import across directories → `media-card` posts commands via `shared("media.cmdReq")`; `workspace-status-usage` executes them. `fmtTime` is duplicated in the card.
- Artwork cache dropped for simplicity: card renders `file://` art URLs directly (http art falls back to brand icon).
- Position is re-anchored in shared state only on seek/drift >1.5s.
