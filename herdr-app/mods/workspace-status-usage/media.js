// MPRIS2 helpers (busctl --user). Pure/injectable `exec` so they are unit-testable.
const PLAYER = "org.mpris.MediaPlayer2.Player";
const PATH = "/org/mpris/MediaPlayer2";

export function brandOf(bus = "") {
  const b = bus.toLowerCase();
  if (b.includes("spotify")) return "spotify";
  return "music";
}

export function parseListOutput(stdout) {
  return (stdout ?? "")
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((n) => n?.startsWith("org.mpris.MediaPlayer2."));
}

export function parseMetadata(md = {}) {
  const v = (k) => md[k]?.data;
  const artist = v("xesam:artist");
  return {
    title: v("xesam:title") ?? "",
    artist: Array.isArray(artist) ? artist.join(", ") : (artist ?? ""),
    album: v("xesam:album") ?? "",
    artUrl: v("mpris:artUrl") ?? "",
    lengthUs: Number(v("mpris:length") ?? 0),
  };
}

async function prop(exec, bus, name) {
  try {
    const r = await exec("busctl", ["--user", "--json=short", "get-property", "--", bus, PATH, PLAYER, name], { timeout: 1500 });
    if (r.code !== 0) return undefined;
    return JSON.parse(r.stdout).data;
  } catch {
    return undefined;
  }
}

export async function readPlayer(exec, bus) {
  const [status, md, pos, prev, next, vol] = await Promise.all(
    ["PlaybackStatus", "Metadata", "Position", "CanGoPrevious", "CanGoNext", "Volume"].map((p) => prop(exec, bus, p)),
  );
  if (!status) return null;
  return {
    bus,
    brand: brandOf(bus),
    status,
    ...parseMetadata(md),
    positionUs: Number(pos ?? 0),
    canPrev: Boolean(prev),
    canNext: Boolean(next),
    volume: typeof vol === "number" ? vol : null,
  };
}

// macOS backend: `nowplaying-cli` (brew install nowplaying-cli). No volume, art or per-player list.
const MAC_BUS = "macos.nowplaying";
const MAC_BINS = ["nowplaying-cli", "/opt/homebrew/bin/nowplaying-cli", "/usr/local/bin/nowplaying-cli"];
let macBin = null;

export function parseMacRaw(stdout) {
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const k = (name) => raw[`kMRMediaRemoteNowPlayingInfo${name}`];
  const title = k("Title");
  if (!title) return null;
  const bundle = String(k("ClientBundleIdentifier") ?? "");
  return {
    bus: MAC_BUS,
    brand: brandOf(bundle),
    status: Number(k("PlaybackRate") ?? 0) > 0 ? "Playing" : "Paused",
    title,
    artist: k("Artist") ?? "",
    album: k("Album") ?? "",
    artUrl: "",
    lengthUs: Math.round(Number(k("Duration") ?? 0) * 1e6),
    positionUs: Math.round(Number(k("ElapsedTime") ?? 0) * 1e6),
    canPrev: true,
    canNext: true,
    volume: null,
  };
}

async function runMac(exec, args) {
  for (const bin of macBin ? [macBin] : MAC_BINS) {
    try {
      const r = await exec(bin, args, { timeout: 2000 });
      if (r.code === 0) {
        macBin = bin;
        return r;
      }
    } catch {
      // binary not found at this path, try the next one
    }
  }
  return null;
}

// get-raw's ElapsedTime is a snapshot that only changes on play/pause/seek/track change and its timestamp
// is not exposed, so while playing we extrapolate from the moment we first saw that snapshot.
let macAnchor = null;

export function anchorMacPosition(p, now = Date.now()) {
  const same = macAnchor && macAnchor.title === p.title && macAnchor.lengthUs === p.lengthUs && macAnchor.snapUs === p.positionUs;
  if (!same) macAnchor = { title: p.title, lengthUs: p.lengthUs, snapUs: p.positionUs, seenAt: now };
  if (p.status !== "Playing") return p;
  const extrapolated = p.positionUs + (now - macAnchor.seenAt) * 1000;
  return { ...p, positionUs: p.lengthUs > 0 ? Math.min(p.lengthUs, extrapolated) : extrapolated };
}

async function readPlayersMac(exec) {
  const r = await runMac(exec, ["get-raw"]);
  const p = r ? parseMacRaw(r.stdout) : null;
  return p ? [anchorMacPosition(p)] : [];
}

export async function readPlayers(exec) {
  const r = await exec("busctl", ["--user", "--no-legend", "list"], { timeout: 1500 }).catch(() => null);
  if (!r || r.code !== 0) return readPlayersMac(exec);
  const all = await Promise.all(parseListOutput(r.stdout).map((b) => readPlayer(exec, b)));
  return all.filter((p) => p && (p.title || p.status === "Playing"));
}

// Playing player wins; otherwise paused one; otherwise null (pill hidden).
export function pickActive(players = []) {
  return players.find((p) => p.status === "Playing") ?? players.find((p) => p.status === "Paused") ?? null;
}

// Excludes positionUs so ticking position never churns shared state.
export function signature(state) {
  if (!state) return "";
  const { positionUs, syncedAt, ...rest } = state;
  return JSON.stringify(rest);
}

const MAC_CMD = { play: "play", pause: "pause", toggle: "togglePlayPause", next: "next", prev: "previous" };

async function sendCommandMac(exec, cmd, arg) {
  if (cmd === "seek") {
    const raw = parseMacRaw((await runMac(exec, ["get-raw"]))?.stdout);
    if (!raw) return null;
    const cur = anchorMacPosition(raw);
    return runMac(exec, ["seek", String(Math.max(0, (cur.positionUs + arg) / 1e6).toFixed(1))]);
  }
  if (!MAC_CMD[cmd]) throw new Error(`unsupported media command on macOS: ${cmd}`);
  return runMac(exec, [MAC_CMD[cmd]]);
}

const CMD = { play: "Play", pause: "Pause", toggle: "PlayPause", next: "Next", prev: "Previous" };

export async function sendCommand(exec, bus, cmd, arg) {
  if (bus === MAC_BUS) return sendCommandMac(exec, cmd, arg);
  if (cmd === "seek") {
    // negative deltas need `--` so they are not parsed as flags
    return exec("busctl", ["--user", "call", "--", bus, PATH, PLAYER, "Seek", "x", String(Math.round(arg))]);
  }
  if (cmd === "volume") {
    const v = Math.max(0, Math.min(1, arg));
    const r = await exec("busctl", ["--user", "set-property", "--", bus, PATH, PLAYER, "Volume", "d", String(v)]);
    if (r.code === 0) return r;
    return exec("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", v.toFixed(2)]);
  }
  if (!CMD[cmd]) throw new Error(`unknown media command: ${cmd}`);
  return exec("busctl", ["--user", "call", "--", bus, PATH, PLAYER, CMD[cmd]]);
}

export function fmtTime(us) {
  const s = Math.max(0, Math.floor((us || 0) / 1e6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function pillLabel(p, max = 40) {
  return truncate([p.title, p.artist].filter(Boolean).join(" · "), max);
}
