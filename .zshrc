export ZSH="$HOME/.oh-my-zsh"
export PATH="$HOME/.local/bin:$PATH:/opt/nvim-linux64/bin"
export STARSHIP_CONFIG="$HOME/src/dotfiles/starship.toml"

HISTSIZE=1000
SAVEHIST=1000
HISTFILE=~/.zsh_history

plugins=(
  git
  docker
  zsh-autosuggestions
  zsh-syntax-highlighting
)

source $HOME/.cargo/env
source $ZSH/oh-my-zsh.sh
eval "$(starship init zsh)"

alias g="git"
alias gp="git push"
alias gc="git commit -m"
alias gst="git status"
alias m=make
alias d=docker
alias dc="docker compose"
alias top=ytop
alias cat=bat
alias ls="exa --icons --git"
alias ll="exa -l --icons --git"

alias cls="clear"
alias ..="cd .."
alias ...="cd ../.."
alias cd..="cd .."

export $(grep -v '^#' ~/.env | xargs)

openrouter() {
  if [[ -z "$OPENROUTER_API_KEY" ]]; then
    echo "Error: OPENROUTER_API_KEY is not set." >&2
    echo "Please export it or add it to your .env file." >&2
    return 1
  fi

  local -x ANTHROPIC_BASE_URL="https://openrouter.ai/api"
  local -x ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
  local -x ANTHROPIC_API_KEY="" 

  local -x CLAUDE_CODE_SUBAGENT_MODEL="z-ai/glm-5.2"
  local -x ANTHROPIC_DEFAULT_OPUS_MODEL="z-ai/glm-5.2"
  local -x ANTHROPIC_DEFAULT_SONNET_MODEL="minimax/minimax-m3"
  local -x ANTHROPIC_DEFAULT_HAIKU_MODEL="minimax/minimax-m3"
  
  command claude "$@"
}

glm() {
  if [[ -z "$MINIMAX_API_KEY" ]]; then
    echo "Error: MINIMAX_API_KEY is not set." >&2
    echo "Please export it or add it to your .env file." >&2
    return 1
  fi

  local -x ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
  local -x ANTHROPIC_AUTH_TOKEN="$GLM_API_KEY"
  local -x ANTHROPIC_API_KEY=""
  local -x API_TIMEOUT_MS="3000000",
  local -x ANTHROPIC_MODEL="glm-5.2",
  local -x ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.2"
  local -x ANTHROPIC_DEFAULT_SONNET_MODEL="glm-4.7"
  local -x ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-4.7"
  
  command claude "$@"
}

minimax() {
  if [[ -z "$MINIMAX_API_KEY" ]]; then
    echo "Error: MINIMAX_API_KEY is not set." >&2
    echo "Please export it or add it to your .env file." >&2
    return 1
  fi

  local -x ANTHROPIC_BASE_URL="https://api.minimax.io/anthropic"
  local -x ANTHROPIC_AUTH_TOKEN="$MINIMAX_API_KEY"
  local -x ANTHROPIC_API_KEY=""
  local -x API_TIMEOUT_MS="3000000",
  local -x ANTHROPIC_MODEL="MiniMax-M2.7",
  local -x ANTHROPIC_DEFAULT_OPUS_MODEL="MiniMax-M2.7",
  local -x ANTHROPIC_DEFAULT_SONNET_MODEL="MiniMax-M2.7",
  local -x ANTHROPIC_DEFAULT_HAIKU_MODEL="MiniMax-M2.7"
  
  command claude "$@"
}

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm

# Open native herdr-chat tab when running bare `agy`/`claude`/`codex` inside a Herdr terminal
# Use `--tui` or `command <agent>` to force the terminal UI, or toggle in Herdr Settings > Herdr Chat.
_herdr_open_chat() {
  local provider="$1"
  shift
  local state_file="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/herdr-chat/state.json"
  local chat_enabled=1
  if [[ -f "$state_file" ]] && grep -Eq '"(enabled|cliIntercept)"[[:space:]]*:[[:space:]]*false' "$state_file" 2>/dev/null; then
    chat_enabled=0
  fi
  if [[ "$chat_enabled" -eq 1 && -n "$HC_TERMINAL_ID" && -t 0 && -t 1 && $# -eq 0 && -z "$ANTHROPIC_BASE_URL" ]] && command -v herdr-app >/dev/null 2>&1; then
    local id="c-$(openssl rand -hex 4)"
    local cwd="${PWD//\\/\\\\}"
    cwd="${cwd//\"/\\\"}"
    herdr-app do tab.new --name "$provider" --mod chat --props "{\"chat\":\"${id}\",\"provider\":\"${provider}\",\"cwd\":\"${cwd}\"}" >/dev/null 2>&1 && return 0
  fi
  if [[ "${1:-}" == "--tui" ]]; then
    shift
  fi
  command "$provider" "$@"
}
agy()    { _herdr_open_chat agy "$@"; }
claude() { _herdr_open_chat claude "$@"; }
codex()  { _herdr_open_chat codex "$@"; }
# [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

# Added by Antigravity CLI installer & user tools
export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${HOME}/bin:$PATH"

# claude-mem background daemon
pgrep -f "worker-service.cjs" > /dev/null 2>&1 || (claude-mem >/dev/null 2>&1 &)
