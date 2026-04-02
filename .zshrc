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

  local -x ANTHROPIC_DEFAULT_OPUS_MODEL="google/gemini-3.1-pro-preview"
  local -x ANTHROPIC_DEFAULT_SONNET_MODEL="minimax/minimax-m2.7"
  local -x ANTHROPIC_DEFAULT_HAIKU_MODEL="z-ai/glm-4.7-flash"
  local -x CLAUDE_CODE_SUBAGENT_MODEL="google/gemini-3.1-pro-preview"
  
  claude "$@"
}

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
# [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion


alias claude-mem='~/.bun/bin/bun ~/.claude/plugins/cache/thedotmack/claude-mem/10.6.2/scripts/worker-service.cjs'
pgrep -f "worker-service.cjs" > /dev/null 2>&1 || claude-mem
