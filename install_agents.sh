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
  claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp --scope user 2>/dev/null || true
  claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp 2>/dev/null || true

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

# 5. Create global symlinks pointing to shared configuration
echo "[+] Creating global symlinks in ~/.gemini and ~/.claude..."

# Shared Skills
rm -rf "${GEMINI_HOME}/skills" "${CLAUDE_HOME}/skills"
ln -sf "${SKILLS_DIR}" "${GEMINI_HOME}/skills"
ln -sf "${SKILLS_DIR}" "${CLAUDE_HOME}/skills"
echo "  - Linked skills -> ${SKILLS_DIR}"

# Shared Agents
rm -rf "${GEMINI_HOME}/agents" "${CLAUDE_HOME}/agents"
ln -sf "${AGENTS_DIR}" "${GEMINI_HOME}/agents"
ln -sf "${AGENTS_DIR}" "${CLAUDE_HOME}/agents"
echo "  - Linked agents -> ${AGENTS_DIR}"

# Shared Rules
rm -rf "${GEMINI_HOME}/rules" "${CLAUDE_HOME}/rules"
ln -sf "${RULES_DIR}" "${GEMINI_HOME}/rules"
ln -sf "${RULES_DIR}" "${CLAUDE_HOME}/rules"
echo "  - Linked rules -> ${RULES_DIR}"

# Hooks
rm -rf "${GEMINI_HOME}/hooks"
ln -sf "${CLAUDE_DIR}/hooks" "${GEMINI_HOME}/hooks"
echo "  - Linked ~/.gemini/hooks -> ${CLAUDE_DIR}/hooks"

# Core Prompt / Instructions (Universal AGENTS.md standard)
ln -sf "${CLAUDE_DIR}/AGENTS.md" "${GEMINI_HOME}/AGENTS.md"
ln -sf "${CLAUDE_DIR}/AGENTS.md" "${CLAUDE_HOME}/AGENTS.md"
# Clean up redundant legacy files (CLAUDE.md, GEMINI.md, AGENT.md)
rm -f "${CLAUDE_HOME}/CLAUDE.md" "${DOTFILES_DIR}/CLAUDE.md" "${CLAUDE_DIR}/CLAUDE.md"
rm -f "${GEMINI_HOME}/GEMINI.md" "${DOTFILES_DIR}/GEMINI.md" "${GEMINI_HOME}/AGENT.md" "${DOTFILES_DIR}/GEMINI_USAGE.md"
echo "  - Linked universal AGENTS.md and removed legacy CLAUDE.md / GEMINI.md"

# Statuslines (Claude Code uses original statusline, Antigravity uses agy statusline)
ln -sf "${CLAUDE_DIR}/statusline.py" "${CLAUDE_HOME}/statusline.py"
ln -sf "${GEMINI_DIR}/statusline.py" "${GEMINI_HOME}/statusline.py"
ln -sf "${GEMINI_DIR}/statusline.py" "${HOME}/.local/bin/agy-statusline.py"
echo "  - Configured separate statusline scripts for Claude Code and Antigravity"

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
