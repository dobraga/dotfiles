#!/usr/bin/env bash
# ==============================================================================
# Setup Antigravity & Claude Code (install tools + configure shared setup)
# ==============================================================================
set -e

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="${DOTFILES_DIR}/skills"
AGENTS_DIR="${DOTFILES_DIR}/agents"
RULES_DIR="${DOTFILES_DIR}/rules"
CLAUDE_DIR="${DOTFILES_DIR}/.claude"
GEMINI_DIR="${DOTFILES_DIR}/.gemini"
GEMINI_HOME="${HOME}/.gemini"
CLAUDE_HOME="${HOME}/.claude"

echo "=== AI Agents Setup (Claude Code & Antigravity) ==="
echo "Dotfiles directory: ${DOTFILES_DIR}"

# 1. Install CLI tools if not present
echo "[+] Checking and installing AI CLI tools..."

# Claude Code CLI
if ! command -v claude &>/dev/null; then
  echo "  - Installing Claude Code CLI..."
  curl -fsSL https://claude.ai/install.sh | bash || true
else
  echo "  [✓] claude CLI is installed"
fi

# RTK (token-saving CLI proxy)
if ! command -v rtk &>/dev/null; then
  echo "  - Installing RTK CLI..."
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh || true
else
  echo "  [✓] rtk CLI is installed"
fi

# Graphify
if ! command -v graphify &>/dev/null; then
  if command -v uv &>/dev/null; then
    echo "  - Installing graphifyy via uv..."
    uv tool install graphifyy || true
  fi
else
  echo "  [✓] graphify CLI is installed"
fi

# browser-harness (browser control via CDP)
if command -v uv &>/dev/null; then
  echo "  - Installing browser-harness via uv..."
  uv tool install --python 3.12 --upgrade --force browser-harness || true
  browser-harness skill > "${SKILLS_DIR}/browser-harness/SKILL.md" 2>/dev/null || true
fi

# Bun runtime (required by claude-mem worker daemon)
if ! command -v bun &>/dev/null && [ ! -f "${HOME}/.bun/bin/bun" ]; then
  echo "  - Installing Bun..."
  curl -fsSL https://bun.sh/install | bash || true
else
  echo "  [✓] bun is installed"
fi
if [ -f "${HOME}/.bun/bin/bun" ]; then
  mkdir -p "${HOME}/.local/bin"
  ln -sf "${HOME}/.bun/bin/bun" "${HOME}/.local/bin/bun"
fi

# 2. Configure user-scoped MCP servers and plugins for Claude Code
if command -v claude &>/dev/null; then
  echo "[+] Ensuring Claude Code user MCP servers and plugins are configured..."

  # claude-mem plugin
  echo "  - Registering and installing claude-mem plugin..."
  claude plugin marketplace add thedotmack/claude-mem 2>/dev/null || true
  claude plugin install claude-mem@thedotmack 2>/dev/null || true
fi

# Create dynamic launcher for claude-mem background worker
mkdir -p "${HOME}/.local/bin"
cat << 'EOF' > "${HOME}/.local/bin/claude-mem"
#!/usr/bin/env bash
BUN_BIN="${HOME}/.bun/bin/bun"
if [ ! -x "${BUN_BIN}" ]; then
  BUN_BIN="$(command -v bun || true)"
fi

SCRIPT=$(find "${HOME}/.claude/plugins/cache/thedotmack/claude-mem" -name "worker-service.cjs" 2>/dev/null | sort -V | tail -n 1)
if [ -n "${SCRIPT}" ] && [ -x "${BUN_BIN}" ]; then
  exec "${BUN_BIN}" "${SCRIPT}" "$@"
else
  echo "Error: bun or claude-mem worker-service.cjs not found" >&2
  exit 1
fi
EOF
chmod +x "${HOME}/.local/bin/claude-mem"

# 3. Ensure scripts and hooks are executable
echo "[+] Setting executable permissions on hooks and statuslines..."
chmod +x "${CLAUDE_DIR}/hooks/"* "${CLAUDE_DIR}/statusline.py" "${GEMINI_DIR}/statusline.py" 2>/dev/null || true

# 4. Ensure global ~/.gemini and ~/.claude directories exist
echo "[+] Ensuring global directory structures..."
mkdir -p "${GEMINI_HOME}" "${CLAUDE_HOME}" "${HOME}/.local/bin"

# 5. Create symlinks pointing to shared configuration
echo "[+] Creating symlinks for AI agents, shell, git, and terminal..."

link_path() {
  local src="$1" dst="$2" bak
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    if [ -d "$dst" ] && rmdir "$dst" 2>/dev/null; then
      :
    else
      bak="${dst}.bak"
      [ -e "$bak" ] && bak="${dst}.bak.$(date +%Y%m%d%H%M%S)"
      mv "$dst" "$bak"
      echo "  - Backed up existing ${dst} -> ${bak}"
    fi
  fi
  ln -sfn "$src" "$dst"
}

# Shared AI agent assets (Claude Code & Antigravity)
for name in skills agents rules; do
  src="${DOTFILES_DIR}/${name}"
  link_path "${src}" "${GEMINI_HOME}/${name}"
  link_path "${src}" "${CLAUDE_HOME}/${name}"
  echo "  - Linked ${name} -> ${src}"
done

# Hooks & Claude Code settings
link_path "${CLAUDE_DIR}/hooks" "${GEMINI_HOME}/hooks"
link_path "${CLAUDE_DIR}/hooks" "${CLAUDE_HOME}/hooks"
link_path "${CLAUDE_DIR}/settings.json" "${CLAUDE_HOME}/settings.json"
echo "  - Linked hooks & settings.json -> ${CLAUDE_DIR}"

# Core Prompt / Instructions (Universal AGENTS.md standard)
link_path "${DOTFILES_DIR}/AGENTS.md" "${GEMINI_HOME}/AGENTS.md"
link_path "${DOTFILES_DIR}/AGENTS.md" "${CLAUDE_HOME}/AGENTS.md"
# Clean up redundant legacy files (CLAUDE.md, GEMINI.md, AGENT.md)
rm -f "${CLAUDE_HOME}/CLAUDE.md" "${DOTFILES_DIR}/CLAUDE.md" "${CLAUDE_DIR}/CLAUDE.md"
rm -f "${GEMINI_HOME}/GEMINI.md" "${DOTFILES_DIR}/GEMINI.md" "${GEMINI_HOME}/AGENT.md" "${DOTFILES_DIR}/GEMINI_USAGE.md"
echo "  - Linked universal AGENTS.md and removed legacy CLAUDE.md / GEMINI.md"

# Statuslines (Claude Code uses original statusline, Antigravity uses agy statusline)
link_path "${CLAUDE_DIR}/statusline.py" "${CLAUDE_HOME}/statusline.py"
link_path "${GEMINI_DIR}/statusline.py" "${GEMINI_HOME}/statusline.py"
link_path "${GEMINI_DIR}/statusline.py" "${HOME}/.local/bin/agy-statusline.py"
echo "  - Configured separate statusline scripts for Claude Code and Antigravity"

# Antigravity CLI defaults (merge tracked defaults without clobbering local trustedWorkspaces/permissions)
AGY_CLI_DIR="${GEMINI_HOME}/antigravity-cli"
AGY_CLI_SETTINGS="${AGY_CLI_DIR}/settings.json"
if [ -f "${GEMINI_DIR}/settings.json" ] && command -v python3 &>/dev/null; then
  mkdir -p "${AGY_CLI_DIR}"
  python3 - "${GEMINI_DIR}/settings.json" "${AGY_CLI_SETTINGS}" "${HOME}" <<'PY'
import json
import os
import sys

src_path, dst_path, home_dir = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src_path, "r", encoding="utf-8") as f:
    defaults = json.load(f)

if isinstance(defaults.get("statusLine"), dict):
    cmd = defaults["statusLine"].get("command")
    if isinstance(cmd, str) and cmd.startswith("~/"):
        defaults["statusLine"]["command"] = os.path.join(home_dir, cmd[2:])

existing = {}
if os.path.exists(dst_path):
    with open(dst_path, "r", encoding="utf-8") as f:
        existing = json.load(f)

merged = {**existing, **defaults}
tmp_path = f"{dst_path}.tmp"
with open(tmp_path, "w", encoding="utf-8") as f:
    json.dump(merged, f, indent=2)
    f.write("\n")
os.chmod(tmp_path, 0o600)
os.replace(tmp_path, dst_path)
PY
  chmod 600 "${AGY_CLI_SETTINGS}"
  echo "  - Merged Antigravity CLI defaults -> ${AGY_CLI_SETTINGS}"
fi

# Revu (local browser review CLI + Claude/AGY hooks + MCP)
if [ -f "${DOTFILES_DIR}/tools/revu/bin/revu" ]; then
  chmod +x "${DOTFILES_DIR}/tools/revu/bin/revu"
  link_path "${DOTFILES_DIR}/tools/revu/bin/revu" "${HOME}/.local/bin/revu"
  BUN_BIN="${HOME}/.bun/bin/bun"
  [ ! -x "${BUN_BIN}" ] && BUN_BIN="$(command -v bun || true)"
  if [ -n "${BUN_BIN}" ] && [ -x "${BUN_BIN}" ]; then
    "${BUN_BIN}" run "${DOTFILES_DIR}/tools/revu/scripts/merge-configs.ts" --revu-bin "${HOME}/.local/bin/revu" || true
  fi
  if command -v claude &>/dev/null; then
    claude mcp add -s user revu -- "${HOME}/.local/bin/revu" mcp 2>/dev/null || true
  fi
  echo "  - Configured revu CLI, hooks, and MCP server"
fi

# Shell, Git, Starship, and Kitty terminal configs
link_path "${DOTFILES_DIR}/.zshrc" "${HOME}/.zshrc"
link_path "${DOTFILES_DIR}/.gitconfig" "${HOME}/.gitconfig"
link_path "${DOTFILES_DIR}/starship.toml" "${HOME}/.config/starship.toml"
link_path "${DOTFILES_DIR}/kitty" "${HOME}/.config/kitty"
echo "  - Linked .zshrc, .gitconfig, starship.toml, and kitty"

# Herdr app personal config, layout, and custom/cloned mods
HERDR_SRC="${DOTFILES_DIR}/herdr-app"
HERDR_HOME="${HOME}/.config/herdr-app"
if [ -d "${HERDR_SRC}" ]; then
  link_herdr() {
    local src="$1" dst="$2" rel bak
    mkdir -p "$(dirname "$dst")"
    if [ -e "$dst" ] && [ ! -L "$dst" ]; then
      rel="${dst#${HERDR_HOME}/}"
      bak="${HERDR_HOME}/.backups/${rel}.$(date +%Y%m%d%H%M%S)"
      mkdir -p "$(dirname "$bak")"
      mv "$dst" "$bak"
      echo "  - Backed up existing ${dst} -> ${bak}"
    fi
    ln -sfn "$src" "$dst"
  }
  for f in keys.json settings.json; do
    [ -f "${HERDR_SRC}/${f}" ] && link_herdr "${HERDR_SRC}/${f}" "${HERDR_HOME}/${f}"
  done
  for layout in "${HERDR_SRC}/layouts/"*.json; do
    [ -f "$layout" ] && link_herdr "$layout" "${HERDR_HOME}/layouts/$(basename "$layout")"
  done
  for mod in "${HERDR_SRC}/mods/"*/; do
    [ -d "$mod" ] && link_herdr "${mod%/}" "${HERDR_HOME}/mods/$(basename "${mod%/}")"
  done
  if [ -f "${HERDR_SRC}/data/herdr-chat/keys.json" ]; then
    link_herdr "${HERDR_SRC}/data/herdr-chat/keys.json" "${HERDR_HOME}/data/herdr-chat/keys.json"
  fi
  echo "  - Linked Herdr config, layouts, and mods -> ${HERDR_SRC}"

  # herdr-chat fork (Antigravity ACP provider + unified Ctrl+T launcher)
  HERDR_CHAT_REPO="https://github.com/dobraga/herdr-chat.git"
  HERDR_CHAT_DIR="${HOME}/src/herdr-chat"
  if command -v herdr-app &>/dev/null && command -v hc &>/dev/null && command -v node &>/dev/null; then
    if [ ! -d "${HERDR_CHAT_DIR}/.git" ]; then
      echo "  - Cloning dobraga/herdr-chat -> ${HERDR_CHAT_DIR}..."
      mkdir -p "$(dirname "${HERDR_CHAT_DIR}")"
      git clone "${HERDR_CHAT_REPO}" "${HERDR_CHAT_DIR}" || true
    else
      echo "  [✓] herdr-chat repo present at ${HERDR_CHAT_DIR}"
    fi
    if [ -x "${HERDR_CHAT_DIR}/install.sh" ] && [ -d "${HERDR_HOME}" ]; then
      "${HERDR_CHAT_DIR}/install.sh" --only-chat --no-subagents || true
    fi
  fi
fi

# 6. Clean up any redundant project-level symlinks in dotfiles
rm -f "${DOTFILES_DIR}/.claude/skills" "${DOTFILES_DIR}/.claude/agents" "${DOTFILES_DIR}/.claude/rules"
rm -f "${DOTFILES_DIR}/.gemini/skills" "${DOTFILES_DIR}/.gemini/agents" "${DOTFILES_DIR}/.gemini/rules"

# 7. Check and display dependency status
echo "[+] Checking environment dependencies..."
for cmd in uv jq rtk graphify agy claude bun; do
  if command -v "$cmd" &>/dev/null; then
    echo "  [✓] $cmd is installed"
  else
    echo "  [!] $cmd is NOT installed (recommended)"
  fi
done

echo "=== AI Agents setup completed successfully! ==="
