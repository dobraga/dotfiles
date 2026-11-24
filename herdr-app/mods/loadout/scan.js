// Read-only inventory of the skills and MCP servers configured for a folder.
// Nothing here writes: the shell script only lists, reads and `readlink`s.
// Secret values (env, headers, tokens in args) never leave this module; only their key names do.

export const TOOLS = [
  { id: "claude", title: "Claude" },
  { id: "agy", title: "Antigravity" },
  { id: "codex", title: "Codex" },
  { id: "gemini", title: "Gemini" },
  { id: "shared", title: "Shared" },
];

const SECRET_KEY = /token|key|secret|passw|auth|credential|bearer/i;
const SECRET_VALUE = /^(sk-|ghp_|gho_|github_pat_|xox[abp]-|AIza|ya29\.|eyJ)/;

// What to look at for a folder. `~` is expanded by the shell on the machine being scanned.
export function buildSpecs(cwd) {
  const p = (path) => (cwd ? `${cwd.replace(/\/+$/, "")}/${path}` : null);
  const specs = [];
  const add = (kind, tool, scope, label, path) => path && specs.push({ kind, tool, scope, label, path });
  add("skills", "claude", "project", "", p(".claude/skills"));
  add("skills", "claude", "global", "", "~/.claude/skills");
  add("skills", "agy", "global", "", "~/.gemini/skills");
  add("skills", "agy", "global", "builtin", "~/.gemini/antigravity-cli/builtin/skills");
  add("skills", "codex", "project", "", p(".codex/skills"));
  add("skills", "codex", "global", "", "~/.codex/skills");
  add("skills", "gemini", "project", "", p(".gemini/skills"));
  add("skills", "shared", "project", "", p(".agents/skills"));
  add("skills", "shared", "global", "", "~/.agents/skills");
  add("mcp-json", "claude", "project", ".mcp.json", p(".mcp.json"));
  add("mcp-json", "claude", "project", "settings.json", p(".claude/settings.json"));
  add("mcp-json", "claude", "project", "settings.local.json", p(".claude/settings.local.json"));
  add("claude-json", "claude", "global", "~/.claude.json", "~/.claude.json");
  add("mcp-json", "claude", "global", "settings.json", "~/.claude/settings.json");
  add("mcp-json", "agy", "global", "mcp_config.json", "~/.gemini/config/mcp_config.json");
  add("mcp-toml", "codex", "global", "config.toml", "~/.codex/config.toml");
  add("mcp-json", "gemini", "project", "settings.json", p(".gemini/settings.json"));
  add("mcp-json", "gemini", "global", "settings.json", "~/.gemini/settings.json");
  add("plugins", "claude", "plugin", "", "~/.claude/plugins/installed_plugins.json");
  return specs;
}

// $1.. = groups of five (kind tool scope label path). Output is NUL separated records:
//   T tool scope path                       the path exists (tool is set up)
//   S tool scope label dir link head        a skill folder with SKILL.md (first lines)
//   F kind tool scope label path content    a config file
export const SCAN_SCRIPT = String.raw`
while [ $# -ge 5 ]; do
  kind=$1; tool=$2; scope=$3; label=$4; path=$5; shift 5
  case $path in "~/"*) path=$HOME/\${path#"~/"};; esac
  [ -e "$path" ] || continue
  printf 'T\0%s\0%s\0%s\0' "$tool" "$scope" "$path"
  case $kind in
    skills)
      for d in "$path"/*/; do
        d=\${d%/}
        [ -f "$d/SKILL.md" ] || continue
        printf 'S\0%s\0%s\0%s\0%s\0%s\0%s\0' "$tool" "$scope" "$label" "$d" "$(readlink "$d" 2>/dev/null)" "$(head -n 30 "$d/SKILL.md" 2>/dev/null)"
      done;;
    *)
      [ -f "$path" ] && printf 'F\0%s\0%s\0%s\0%s\0%s\0' "$kind" "$tool" "$scope" "$label" "$path" && printf '%s\0' "$(head -c 400000 "$path" 2>/dev/null)";;
  esac
done
`.replace(/\\\$/g, "$");

export function parseRecords(stdout) {
  const f = stdout.split("\0");
  const out = [];
  for (let i = 0; i < f.length; ) {
    const t = f[i];
    if (t === "T") { out.push({ t, tool: f[i + 1], scope: f[i + 2], path: f[i + 3] }); i += 4; }
    else if (t === "S") { out.push({ t, tool: f[i + 1], scope: f[i + 2], label: f[i + 3], dir: f[i + 4], link: f[i + 5], head: f[i + 6] }); i += 7; }
    else if (t === "F") { out.push({ t, kind: f[i + 1], tool: f[i + 2], scope: f[i + 3], label: f[i + 4], path: f[i + 5], content: f[i + 6] ?? "" }); i += 7; }
    else i++;
  }
  return out;
}

export function parseFrontmatter(head, fallbackName) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(head ?? "");
  const out = { name: fallbackName, description: "" };
  if (!m) return out;
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      v = "";
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) v += (v ? " " : "") + lines[++i].trim();
    }
    out[kv[1]] = v.replace(/^["']|["']$/g, "");
  }
  return out;
}

const redactArg = (a) => {
  const s = String(a);
  const eq = /^(--?[\w.-]+)=(.*)$/.exec(s);
  if (eq && SECRET_KEY.test(eq[1])) return `${eq[1]}=•••`;
  if (SECRET_VALUE.test(s)) return "•••";
  return s;
};

// url userinfo and query strings can carry credentials.
const safeUrl = (u) => String(u).replace(/\/\/[^/@\s]+@/, "//•••@").replace(/\?.*$/, "?…");

export function describeServer(name, cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const url = c.url ?? c.serverUrl ?? c.httpUrl;
  const transport = c.type ?? (url ? "http" : "stdio");
  const target = url ? safeUrl(url) : [c.command, ...(Array.isArray(c.args) ? c.args.map(redactArg) : [])].filter(Boolean).join(" ");
  return {
    name,
    transport,
    target,
    envKeys: c.env && typeof c.env === "object" ? Object.keys(c.env) : [],
    headerKeys: c.headers && typeof c.headers === "object" ? Object.keys(c.headers) : [],
    disabled: c.disabled === true,
  };
}

function serversFromObject(obj) {
  const s = obj?.mcpServers;
  return s && typeof s === "object" ? Object.entries(s).map(([n, c]) => describeServer(n, c)) : [];
}

// Minimal TOML: [mcp_servers.NAME] with command/args/url, and [mcp_servers.NAME.env|headers] key names.
export function parseCodexToml(text) {
  const servers = new Map();
  let cur = null;
  let sub = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    const sec = /^\[mcp_servers\.("[^"]+"|[^.\]]+)(?:\.(\w+))?\]$/.exec(line);
    if (sec) {
      const name = sec[1].replace(/^"|"$/g, "");
      if (!servers.has(name)) servers.set(name, { command: undefined, args: [], url: undefined, env: {}, headers: {} });
      cur = servers.get(name);
      sub = sec[2] ?? null;
      continue;
    }
    if (line.startsWith("[")) { cur = null; continue; }
    if (!cur || !line || line.startsWith("#")) continue;
    const kv = /^([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (sub === "env" || sub === "http_headers" || sub === "headers") { (sub === "env" ? cur.env : cur.headers)[kv[1]] = ""; continue; }
    if (sub) continue;
    if (kv[1] === "command") cur.command = kv[2].replace(/^"|"$/g, "");
    else if (kv[1] === "url") cur.url = kv[2].replace(/^"|"$/g, "");
    else if (kv[1] === "args") cur.args = [...kv[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  }
  return [...servers].map(([n, c]) => describeServer(n, c));
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// records (from parseRecords) + cwd => { tools, skills, mcps }
export function buildInventory(records, cwd, pluginRecords = []) {
  const found = new Set(); // tools that contribute at least one skill or MCP server
  const skills = new Map();
  const mcps = new Map();
  const addSkill = (r, scope = r.scope, label = r.label) => {
    const base = r.dir.split("/").pop();
    const fm = parseFrontmatter(r.head, base);
    const key = `${scope}|${label}|${fm.name}`;
    const e = skills.get(key) ?? { kind: "skill", name: fm.name, description: fm.description, scope, label, tools: new Set(), paths: [], links: [] };
    e.tools.add(r.tool);
    if (!e.paths.includes(r.dir)) e.paths.push(r.dir);
    if (r.link && !e.links.includes(r.link)) e.links.push(r.link);
    skills.set(key, e);
    found.add(r.tool);
  };
  const addServers = (list, tool, scope, label, path) => {
    for (const s of list) {
      const key = `${scope}|${s.name}`;
      const e = mcps.get(key) ?? { kind: "mcp", ...s, scope, label: "", tools: new Set(), sources: [] };
      e.tools.add(tool);
      e.sources.push({ label, path });
      mcps.set(key, e);
      found.add(tool);
    }
  };
  for (const r of [...records, ...pluginRecords]) {
    if (r.t === "T") continue; // an existing folder or file alone does not make a tool "set up"
    if (r.t === "S") { addSkill(r); continue; }
    if (r.t !== "F") continue;
    if (r.kind === "plugins") continue; // consumed by pluginSpecs()
    if (r.kind === "mcp-toml") addServers(parseCodexToml(r.content), r.tool, r.scope, r.label, r.path);
    else if (r.kind === "claude-json") {
      const j = tryJson(r.content);
      addServers(serversFromObject(j), r.tool, "global", r.label, r.path);
      addServers(serversFromObject(j?.projects?.[cwd]), r.tool, "local", r.label, r.path);
    } else addServers(serversFromObject(tryJson(r.content)), r.tool, r.scope, r.label, r.path);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const skillList = [...skills.values()].sort(byName);
  const mcpList = [...mcps.values()].sort(byName);
  return {
    tools: TOOLS.filter((t) => found.has(t.id)),
    skills: skillList,
    mcps: mcpList,
    plugins: buildPlugins(records, cwd, skillList, mcpList),
  };
}

// installed_plugins.json => one row per plugin that applies to this folder, with skill / MCP counts.
export function buildPlugins(records, cwd, skills, mcps) {
  const rec = records.find((r) => r.t === "F" && r.kind === "plugins");
  const j = rec ? tryJson(rec.content) : null;
  const out = [];
  for (const [id, installs] of Object.entries(j?.plugins ?? {})) {
    const [name, marketplace = ""] = id.split("@");
    const inst = (Array.isArray(installs) ? installs : []).find((i) => i.installPath && !(i.scope === "project" && i.projectPath && i.projectPath !== cwd));
    if (!inst) continue;
    out.push({
      name, marketplace, version: inst.version ?? "", scope: inst.scope ?? "user", path: inst.installPath,
      skills: skills.filter((r) => r.scope === "plugin" && r.label === name).length,
      mcps: mcps.filter((r) => r.scope === "plugin" && r.label === name).length,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// `claude mcp list` => claude.ai connectors with status: connected | auth | failed.
export function parseMcpList(stdout) {
  const out = [];
  for (const line of String(stdout).split("\n")) {
    const m = /^(claude\.ai .+?): (\S+) - (.*)$/.exec(line.trim());
    if (!m) continue;
    const st = m[3];
    const status = /connected/i.test(st) && !/disconnected/i.test(st) ? "connected" : /auth/i.test(st) ? "auth" : "failed";
    out.push({ name: m[1].replace(/^claude\.ai /, ""), url: safeUrl(m[2]), status });
  }
  return out;
}

// installed_plugins.json => extra specs for the plugin skills / .mcp.json that apply to this folder.
export function pluginSpecs(records, cwd) {
  const rec = records.find((r) => r.t === "F" && r.kind === "plugins");
  const j = rec ? tryJson(rec.content) : null;
  const specs = [];
  for (const [id, installs] of Object.entries(j?.plugins ?? {})) {
    const label = id.split("@")[0];
    for (const inst of Array.isArray(installs) ? installs : []) {
      if (!inst.installPath) continue;
      if (inst.scope === "project" && inst.projectPath && inst.projectPath !== cwd) continue;
      specs.push({ kind: "skills", tool: "claude", scope: "plugin", label, path: `${inst.installPath}/skills` });
      specs.push({ kind: "mcp-json", tool: "claude", scope: "plugin", label, path: `${inst.installPath}/.mcp.json` });
    }
  }
  return specs;
}

export const flattenSpecs = (specs) => specs.flatMap((s) => [s.kind, s.tool, s.scope, s.label, s.path]);
