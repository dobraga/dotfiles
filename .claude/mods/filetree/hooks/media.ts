// Media in the viewer: images (converted with sips), audio (afplay) and video (a poster frame from ffmpeg, seekable). Owns the playback atoms.
import { atom, read, type EngineInterface, type Timer, update } from 'claude-code'
import { cacheName } from './pure'

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i
export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|aiff?)$/i
export const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi)$/i
const MEDIA_CACHE = '/tmp/file-viewer-cache'
export const VIDEO_STEP = 5
const playPid = atom({ plugin: 'filetree', key: 'playPid' } as const, 0)
const playStart = atom({ plugin: 'filetree', key: 'playStart' } as const, 0)
const playDuration = atom({ plugin: 'filetree', key: 'playDuration' } as const, 0)
const videoPos = atom({ plugin: 'filetree', key: 'videoPos' } as const, 0)
const tick = atom({ plugin: 'filetree', key: 'tick' } as const, 0)
let ticker: Timer | undefined

// Terminals that draw real images through the terminal's own protocol (iTerm2, WezTerm, Ghostty, Kitty); others get the text-cell picture
export async function supportsImages($: EngineInterface): Promise<boolean> {
  const program = (await $.env.get('TERM_PROGRAM')) ?? ''
  if (/^(iTerm\.app|WezTerm|ghostty)$/i.test(program)) return true

  return Boolean(await $.env.get('KITTY_WINDOW_ID')) || (await $.env.get('TERM')) === 'xterm-kitty'
}


export async function mediaDuration($: EngineInterface, path: string): Promise<number> {
  const run = await $.process.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeoutMs: 15000 })
  const seconds = Number(run.stdout.trim())

  return run.exitCode === 0 && Number.isFinite(seconds) ? seconds : 0
}

// A PNG for the terminal to draw (png stays as is), and its pixel size
export async function imageFile($: EngineInterface, path: string): Promise<{ file: string; width: number; height: number } | undefined> {
  let file = path
  if (!/\.png$/i.test(path)) {
    file = `${MEDIA_CACHE}/${cacheName(path)}.png`
    await $.process.run(['mkdir', '-p', MEDIA_CACHE])
    if (!(await $.fs.exists(file))) {
      let made = await $.process.run(['sips', '-s', 'format', 'png', path, '--out', file], { timeoutMs: 30000 }).catch(() => ({ exitCode: 1 }))
      // sips is macOS only; ffmpeg converts elsewhere
      if (made.exitCode !== 0) made = await $.process.run(['ffmpeg', '-y', '-v', 'error', '-i', path, '-frames:v', '1', file], { timeoutMs: 30000 })
      if (made.exitCode !== 0) return undefined
    }
  }
  // ffprobe first (Linux and macOS with ffmpeg); sips is the macOS fallback and its absence must not abort the preview
  const size = async (cmd: string[]): Promise<[number, number]> => {
    try {
      const run = await $.process.run(cmd, { timeoutMs: 15000 })
      const text = run.stdout.trim()
      if (cmd[0] === 'sips') return [Number(/pixelWidth:\s*(\d+)/.exec(text)?.[1]), Number(/pixelHeight:\s*(\d+)/.exec(text)?.[1])]
      const [w, h] = text.split(',').map(Number)

      return [w, h]
    } catch {
      return [0, 0]
    }
  }
  let [width, height] = await size(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
  if (!(width > 0 && height > 0)) [width, height] = await size(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file])

  return width > 0 && height > 0 ? { file, width, height } : undefined
}

export async function videoFrame($: EngineInterface, path: string, at: number): Promise<string | undefined> {
  const file = `${MEDIA_CACHE}/${cacheName(path)}_${Math.round(at)}.png`
  await $.process.run(['mkdir', '-p', MEDIA_CACHE])
  if (!(await $.fs.exists(file))) {
    const run = await $.process.run(['ffmpeg', '-y', '-v', 'error', '-ss', String(at), '-i', path, '-frames:v', '1', file], { timeoutMs: 30000 })
    if (run.exitCode !== 0) return undefined
  }

  return file
}

// A PNG of a rendered HTML page, from the first headless browser found (the default one is often Brave or Chrome); re-made when the file is newer
const HTML_SHOT = [
  'out=$1; f=$2',
  '[ "$out" -nt "$f" ] && exit 0',
  'for b in brave-browser chromium chromium-browser google-chrome-stable google-chrome "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do',
  '  if command -v "$b" >/dev/null 2>&1 || [ -x "$b" ]; then',
  '    exec "$b" --headless --disable-gpu --hide-scrollbars --screenshot="$out" --window-size=1200,900 "file://$f"',
  '  fi',
  'done',
  'command -v firefox >/dev/null 2>&1 && exec firefox --headless --screenshot "$out" --window-size=1200,900 "file://$f"',
  'exit 127',
].join('\n')

export async function htmlFrame($: EngineInterface, path: string): Promise<string | undefined> {
  const file = `${MEDIA_CACHE}/${cacheName(path)}_html.png`
  await $.process.run(['mkdir', '-p', MEDIA_CACHE])
  const run = await $.process.run(['sh', '-c', HTML_SHOT, 'sh', file, path], { timeoutMs: 40000 }).catch(() => ({ exitCode: 1 }))

  return run.exitCode === 0 && (await $.fs.exists(file)) ? file : undefined
}

export async function stopAudio($: EngineInterface): Promise<void> {
  const pid = await read($, playPid)
  ticker?.cancel()
  ticker = undefined
  if (pid > 0) await $.process.run(['kill', String(pid)]).catch(() => undefined)
  await update($, playPid, () => 0)
}

export async function startAudio($: EngineInterface, path: string, duration: number): Promise<void> {
  await stopAudio($)
  // afplay reads the sound of mp4/mov/m4v itself; other containers get their audio pulled out into a cached m4a first
  let playable = path
  if (VIDEO_EXT.test(path) && !/\.(mp4|mov|m4v)$/i.test(path)) {
    playable = `${MEDIA_CACHE}/${cacheName(path)}.m4a`
    await $.process.run(['mkdir', '-p', MEDIA_CACHE])
    if (!(await $.fs.exists(playable))) {
      $.ui.toast('Extracting the audio...')
      const made = await $.process.run(['ffmpeg', '-y', '-v', 'error', '-i', path, '-vn', '-c:a', 'aac', playable], { timeoutMs: 600000 })
      if (made.exitCode !== 0) return $.ui.toast(`Could not extract the audio of ${path}`)
    }
  }
  const run = await $.process.run(['sh', '-c', 'afplay "$1" >/dev/null 2>&1 & echo $!', 'sh', playable], { timeoutMs: 10000 })
  const pid = Number(run.stdout.trim())
  if (!(pid > 0)) return $.ui.toast(`Could not play ${path}`)
  await update($, playPid, () => pid)
  await update($, playStart, () => Date.now())
  await update($, playDuration, () => duration)
  // Redraw once a second for the elapsed time; stop the bookkeeping when the clip has run its length
  ticker = $.clock.every(1000, async () => {
    if (duration > 0 && Date.now() - (await read($, playStart)) > duration * 1000 + 500) await stopAudio($)
    else await update($, tick, n => n + 1)
  })
}

// A picture as cells: each cell is a braille glyph (2x4 dots) coloured with the bright dots' average on the average of the dark ones,
// which is four times the detail of half-blocks in the same space
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

export async function pictureCells($: EngineInterface, file: string, columns: number, rows: number): Promise<string | undefined> {
  const wide = columns * 2
  const tall = rows * 4
  const raw = `${MEDIA_CACHE}/${cacheName(file)}_${wide}x${tall}.rgb`
  if (!(await $.fs.exists(raw))) {
    await $.process.run(['mkdir', '-p', MEDIA_CACHE])
    const run = await $.process.run(
      ['ffmpeg', '-y', '-v', 'error', '-i', file, '-vf', `scale=${wide}:${tall}:flags=lanczos`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw],
      { timeoutMs: 30000 },
    )
    if (run.exitCode !== 0) return undefined
  }
  const { base64 } = await $.fs.read(raw, { as: 'bytes' })
  // The engine's runtime has the base64 helpers; the TypeScript lib does not declare them yet.
  const rgb = (Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(base64)
  const cells = new Uint32Array(columns * rows * 3)
  const pack = (r: number, g: number, b: number): number => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      const dots: { x: number; y: number; r: number; g: number; b: number; lum: number }[] = []
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 2; x++) {
          const i = ((cy * 4 + y) * wide + cx * 2 + x) * 3
          const r = rgb[i] ?? 0
          const g = rgb[i + 1] ?? 0
          const b = rgb[i + 2] ?? 0
          dots.push({ x, y, r, g, b, lum: 0.299 * r + 0.587 * g + 0.114 * b })
        }
      }
      const mean = dots.reduce((n, d) => n + d.lum, 0) / dots.length
      const lit = dots.filter(d => d.lum >= mean)
      const dark = dots.filter(d => d.lum < mean)
      const avg = (group: typeof dots): number => {
        const n = Math.max(1, group.length)

        return pack(group.reduce((t, d) => t + d.r, 0) / n, group.reduce((t, d) => t + d.g, 0) / n, group.reduce((t, d) => t + d.b, 0) / n)
      }
      const k = (cy * columns + cx) * 3
      if (dark.length === 0) {
        // flat cell: a blank braille on the average colour
        cells[k] = 0x2800
        cells[k + 1] = avg(lit)
        cells[k + 2] = avg(lit)
      } else {
        cells[k] = 0x2800 + lit.reduce((bits, d) => bits | (BRAILLE_BITS[d.y]?.[d.x] ?? 0), 0)
        cells[k + 1] = avg(lit)
        cells[k + 2] = avg(dark)
      }
    }
  }

  return (new Uint8Array(cells.buffer) as unknown as { toBase64(): string }).toBase64()
}

/** Playback state the viewer draws: the audio pid (0 when stopped), when it started, and the video seek position. */
export async function getPlayback($: EngineInterface): Promise<{ pid: number; started: number; at: number }> {
  const [pid, started, at] = await Promise.all([read($, playPid), read($, playStart), read($, videoPos)])
  await read($, tick)
  return { pid, started, at }
}
export async function setVideoPos($: EngineInterface, to: number): Promise<void> {
  await update($, videoPos, () => to)
}
