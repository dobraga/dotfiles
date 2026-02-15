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

alias py="clear && python"
alias g="git"
alias gp="git push"
alias gc="git commit -m"
alias gst="git status"
alias m=make
alias d=docker
alias dc=docker-compose
alias top=ytop
alias cat=bat
alias ls="exa --icons --git"
alias ll="exa -l --icons --git"

alias cls="clear"
alias ..="cd .."
alias ...="cd ../.."
alias cd..="cd .."
