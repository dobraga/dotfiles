// System stats (CPU / RAM / disk / network) for macOS and Linux. Parsers are pure; `readStats` takes injected
// `exec` and `readTextFile` so it is unit-testable.

export function fmtRate(bytesPerSec) {
  const n = Math.max(0, bytesPerSec || 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Pads a number to 2 digits with figure spaces (digit-wide) so the layout does not shift. */
export const pad2 = (v) => String(v).padStart(2, "\u2007");

const clampPct = (v) => Math.max(0, Math.min(100, Math.round(v)));

// ---- Linux ----
export function parseProcStat(text) {
  const line = (text ?? "").split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (v[3] ?? 0) + (v[4] ?? 0); // idle + iowait
  return { idle, total: v.slice(0, 8).reduce((a, b) => a + b, 0) };
}

export function parseMeminfo(text) {
  const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(text ?? "")?.[1] ?? NaN);
  const total = kb("MemTotal");
  const avail = kb("MemAvailable");
  return Number.isFinite(total) && Number.isFinite(avail) && total > 0 ? clampPct(((total - avail) / total) * 100) : null;
}

export function parseProcNetDev(text) {
  let rx = 0;
  let tx = 0;
  for (const l of (text ?? "").split("\n")) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(l);
    if (!m || m[1] === "lo") continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    rx += f[0] || 0;
    tx += f[8] || 0;
  }
  return { rx, tx };
}

// ---- macOS ----
export function parseTopCpu(text) {
  const lines = (text ?? "").split("\n").filter((l) => l.startsWith("CPU usage:"));
  const m = /([\d.]+)%\s*idle/.exec(lines.at(-1) ?? ""); // last sample: first one is since boot
  return m ? clampPct(100 - Number(m[1])) : null;
}

export function parseVmStatBytes(text) {
  const page = Number(/page size of (\d+) bytes/.exec(text ?? "")?.[1] ?? 16384);
  const n = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(text ?? "")?.[1] ?? 0);
  return (n("Pages active") + n("Pages wired down") + n("Pages occupied by compressor")) * page;
}

export function parseVmStat(text, memsize) {
  return memsize > 0 ? clampPct((parseVmStatBytes(text) / memsize) * 100) : null;
}

export function parseNetstatIb(text) {
  let rx = 0;
  let tx = 0;
  const lines = (text ?? "").trim().split("\n");
  const head = lines[0]?.trim().split(/\s+/) ?? [];
  const ib = head.indexOf("Ibytes");
  const ob = head.indexOf("Obytes");
  if (ib < 0 || ob < 0) return null;
  for (const l of lines.slice(1)) {
    const f = l.trim().split(/\s+/);
    if (!f[2]?.startsWith("<Link#") || f[0].startsWith("lo")) continue;
    // Address column is absent on some interfaces, shifting the byte columns left by one.
    const shift = f.length < head.length ? head.length - f.length : 0;
    rx += Number(f[ib - shift]) || 0;
    tx += Number(f[ob - shift]) || 0;
  }
  return { rx, tx };
}

// ---- shared ----
export function parseDf(text) {
  const f = (text ?? "").trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  const used = Number(f[2]);
  const avail = Number(f[3]);
  return used >= 0 && avail >= 0 && used + avail > 0 ? clampPct((used / (used + avail)) * 100) : null;
}

/** `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits` -> first GPU. */
export function parseNvidiaSmi(text) {
  const f = (text ?? "").trim().split("\n")[0]?.split(",").map((x) => Number(x.trim()));
  if (!f || f.length < 3 || !Number.isFinite(f[0])) return null;
  return { util: clampPct(f[0]), memUsed: f[1] * 2 ** 20, memTotal: f[2] * 2 ** 20, temp: Number.isFinite(f[3]) ? f[3] : null };
}

async function sh(exec, cmd, args, timeout = 4000) {
  try {
    const r = await exec(cmd, args, { timeout });
    return r.code === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/** Reads one snapshot. `prev` is the previous snapshot's raw counters (null on first call). */
export async function readStats({ mac, exec, readTextFile, herdr: wantHerdr = true }, prev) {
  const now = Date.now();
  let cpuRaw = null;
  let cpu = null;
  let mem = null;
  let net;
  let disk;
  let gpu = null;
  let gpuMissing = prev?.gpuMissing ?? false;
  if (!mac && !gpuMissing) {
    const out = await sh(exec, "nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"]);
    gpu = parseNvidiaSmi(out);
    if (out == null) gpuMissing = true; // no NVIDIA driver/binary: stop spawning
  }
  if (mac) {
    const [top, vm, memsize, df, ns] = await Promise.all([
      sh(exec, "top", ["-l", "2", "-n", "0", "-s", "1"], 6000),
      sh(exec, "vm_stat", []),
      sh(exec, "sysctl", ["-n", "hw.memsize"]),
      sh(exec, "df", ["-k", "/System/Volumes/Data"]).then((o) => o ?? sh(exec, "df", ["-k", "/"])),
      sh(exec, "netstat", ["-ib"]),
    ]);
    cpu = parseTopCpu(top);
    mem = parseVmStat(vm, Number(memsize));
    disk = parseDf(df);
    net = parseNetstatIb(ns);
  } else {
    const [stat, mi, df, nd] = await Promise.all([
      readTextFile("/proc/stat"),
      readTextFile("/proc/meminfo"),
      sh(exec, "df", ["-kP", "/"]),
      readTextFile("/proc/net/dev"),
    ]);
    cpuRaw = parseProcStat(stat);
    if (cpuRaw && prev?.cpuRaw && cpuRaw.total > prev.cpuRaw.total) {
      cpu = clampPct((1 - (cpuRaw.idle - prev.cpuRaw.idle) / (cpuRaw.total - prev.cpuRaw.total)) * 100);
    }
    mem = parseMeminfo(mi);
    disk = parseDf(df);
    net = nd ? parseProcNetDev(nd) : null;
  }
  const herdr = !wantHerdr ? null : parseHerdrTree(await sh(exec, "ps", mac ? ["-Aeo", "pid,ppid,rss,command"] : ["-eo", "pid,ppid,rss,args"]));
  const dt = prev?.net && net ? (now - prev.at) / 1000 : 0;
  const down = dt > 0 ? Math.max(0, (net.rx - prev.net.rx) / dt) : 0;
  const up = dt > 0 ? Math.max(0, (net.tx - prev.net.tx) / dt) : 0;
  return { at: now, cpuRaw, net: net ?? prev?.net ?? null, cpu, mem, disk, down, up, gpu, gpuMissing, herdr };
}

// ---- history (sparklines) ----
export const HIST_LEN = 60;
export function pushHist(hist, s) {
  const h = hist ?? { cpu: [], mem: [], down: [], up: [], gpu: [] };
  const add = (k, v) => [...h[k], v ?? 0].slice(-HIST_LEN);
  return { cpu: add("cpu", s.cpu), mem: add("mem", s.mem), down: add("down", s.down), up: add("up", s.up), gpu: add("gpu", s.gpu?.util) };
}

// ---- detail (read only while the card is open) ----
export function fmtBytes(b) {
  const n = Math.max(0, b || 0);
  if (n >= 2 ** 40) return `${(n / 2 ** 40).toFixed(1)} TB`;
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`;
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** `ps -o pid,pcpu,rss,comm` output -> [{pid, cpu, rssKb, name}] (header skipped, name may contain spaces). */
export function parsePs(text) {
  const out = [];
  for (const l of (text ?? "").split("\n").slice(1)) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(l);
    if (m) out.push({ pid: Number(m[1]), cpu: Number(m[2]), rssKb: Number(m[3]), name: m[4].split("/").pop() });
  }
  return out;
}

export function topProcs(procs, n = 5) {
  return {
    cpu: [...procs].sort((a, b) => b.cpu - a.cpu).slice(0, n),
    mem: [...procs].sort((a, b) => b.rssKb - a.rssKb).slice(0, n),
  };
}

export function parseDfBytes(text) {
  const f = (text ?? "").trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  const used = Number(f[2]) * 1024;
  const avail = Number(f[3]) * 1024;
  return used >= 0 && avail >= 0 ? { used, total: used + avail } : null;
}

export function parseSwapMac(text) {
  const m = /total = ([\d.]+)([MG]).*used = ([\d.]+)([MG])/.exec(text ?? "");
  if (!m) return null;
  const u = { M: 2 ** 20, G: 2 ** 30 };
  return { total: Number(m[1]) * u[m[2]], used: Number(m[3]) * u[m[4]] };
}

export function parseMeminfoBytes(text) {
  const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(text ?? "")?.[1] ?? NaN);
  const total = kb("MemTotal") * 1024;
  const avail = kb("MemAvailable") * 1024;
  const st = kb("SwapTotal") * 1024;
  const sf = kb("SwapFree") * 1024;
  return {
    mem: Number.isFinite(total) && Number.isFinite(avail) ? { used: total - avail, total } : null,
    swap: Number.isFinite(st) && Number.isFinite(sf) ? { used: st - sf, total: st } : null,
  };
}

export function parseLoad(text) {
  const m = /load averages?:\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `ps -eo pid,ppid,rss,comm,args` -> memory of Herdr (herdr-app/herdr-core) and everything it runs, by kind. */
export function parseHerdrTree(text) {
  const rows = [];
  for (const l of (text ?? "").split("\n").slice(1)) {
    // macOS `ps` truncates the comm column to 16 chars, so the executable is derived from the full command (paths may hold spaces: "Herdr Core.app").
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const exe = /^(.*?\.app\/Contents\/MacOS\/[^ ]+)/.exec(m[4])?.[1] ?? m[4].split(" ")[0];
    rows.push({ pid: +m[1], ppid: +m[2], kb: +m[3], comm: exe.split("/").pop(), args: m[4] });
  }
  const isHerdr = (r) => /^(herdr-(app|core)|Herdr)$/.test(r.comm);
  const kids = new Map();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const roots = rows.filter((r) => isHerdr(r) && !isHerdr(byPid.get(r.ppid) ?? {}));
  const kinds = { claude: { label: "Claude sessions", n: 0, kb: 0 }, agent: { label: "Other agents", n: 0, kb: 0 }, chat: { label: "Chat hosts", n: 0, kb: 0 }, herdr: { label: "Herdr app", n: 0, kb: 0 }, shell: { label: "Shells", n: 0, kb: 0 }, other: { label: "Other", n: 0, kb: 0 } };
  // An agent's whole subtree (its bun/node helpers) counts under it.
  const kindOf = (r) => /^\d+\.\d+\.\d+$/.test(r.comm) || r.comm === "claude" ? "claude"
    : /^(agy|codex|pi|gemini|opencode)$/.test(r.comm) ? "agent"
    : /herdr-chat\/host/.test(r.args) ? "chat" : isHerdr(r) ? "herdr" : /^-?(zsh|bash|fish|sh)$/.test(r.comm) ? "shell" : "other";
  const walk = (r, inherited) => {
    const k = inherited ?? kindOf(r);
    const own = inherited ?? (k === "claude" || k === "agent" ? k : null);
    kinds[k].kb += r.kb;
    if (!inherited) kinds[k].n += 1;
    for (const c of kids.get(r.pid) ?? []) walk(c, own);
  };
  roots.forEach((r) => walk(r, null));
  const total = Object.values(kinds).reduce((a, k) => a + k.kb, 0) * 1024;
  return roots.length ? { total, kinds: Object.values(kinds).filter((k) => k.kb > 0).map((k) => ({ ...k, bytes: k.kb * 1024 })).sort((a, b) => b.bytes - a.bytes) } : null;
}

export async function readDetail({ mac, exec, readTextFile }) {
  const [ps, df, cores, up] = await Promise.all([
    sh(exec, "ps", mac ? ["-Aceo", "pid,pcpu,rss,comm"] : ["-eo", "pid,pcpu,rss,comm"]),
    mac ? sh(exec, "df", ["-k", "/System/Volumes/Data"]).then((o) => o ?? sh(exec, "df", ["-k", "/"])) : sh(exec, "df", ["-kP", "/"]),
    sh(exec, "getconf", ["_NPROCESSORS_ONLN"]),
    sh(exec, "uptime", []),
  ]);
  let mem = null;
  let swap = null;
  if (mac) {
    const [vm, ms, sw] = await Promise.all([sh(exec, "vm_stat", []), sh(exec, "sysctl", ["-n", "hw.memsize"]), sh(exec, "sysctl", ["-n", "vm.swapusage"])]);
    const total = Number(ms);
    if (vm && total > 0) mem = { used: parseVmStatBytes(vm), total };
    swap = parseSwapMac(sw);
  } else {
    ({ mem, swap } = parseMeminfoBytes(await readTextFile("/proc/meminfo")));
  }
  return { at: Date.now(), procs: topProcs(parsePs(ps)), mem, swap, disk: parseDfBytes(df), cores: Number(cores) || null, load: parseLoad(up) };
}

/** `du -kx -d1` output -> [{ path, kb }] sorted by size, without the scanned root itself. */
export function parseDu(text, root) {
  const out = [];
  for (const l of (text ?? "").split("\n")) {
    const m = /^(\d+)\s+(.+?)\s*$/.exec(l);
    if (m && m[2] !== root) out.push({ path: m[2], kb: +m[1] });
  }
  return out.sort((a, b) => b.kb - a.kb);
}

/** Biggest folders under $HOME, with ~/Library (usually the biggest, not actionable as one line) split into its own children. Slow (tens of seconds): call rarely. */
export async function readDiskTop({ exec }, limit = 10) {
  const run = (dir) => sh(exec, "sh", ["-c", `du -kx -d1 "${dir}" 2>/dev/null; true`], 300000);
  const [home, lib] = await Promise.all([run("$HOME"), run("$HOME/Library")]);
  const root = (await sh(exec, "sh", ["-c", 'printf %s "$HOME"'], 2000)) ?? "";
  if (!home || !root) return null;
  const libPath = `${root}/Library`;
  const items = [...parseDu(home, root).filter((r) => r.path !== libPath || !lib), ...parseDu(lib, libPath)]
    .sort((a, b) => b.kb - a.kb)
    .slice(0, limit)
    .map((r) => ({ name: r.path.startsWith(root) ? `~${r.path.slice(root.length)}` : r.path, bytes: r.kb * 1024 }));
  return { at: Date.now(), items };
}
