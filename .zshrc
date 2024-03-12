export ZSH="$HOME/.oh-my-zsh"
export PATH="$HOME/.local/bin:$PATH:/opt/nvim-linux64/bin"
export STARSHIP_CONFIG="$HOME/dotfiles/starship.toml"

HISTSIZE=1000
SAVEHIST=1000
HISTFILE=~/.zsh_history

plugins=(
  git
  docker
  zsh-autosuggestions
  zsh-syntax-highlighting
)

source $ZSH/oh-my-zsh.sh
source $HOME/.asdf/asdf.sh
eval "$(starship init zsh)"

alias py="clear && python"
alias g="git"
alias gp="git push"
alias gc="git commit -m"
alias gst="git status"
alias p="poetry"
alias pshell="poetry shell"
alias padd="poetry add"
alias prm="poetry remove"
alias prun="poetry run"
alias pinstall="poetry install"
alias penv="poetry env"
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

jl() {
  poetry run jupyter-lab
}

# # The next line updates PATH for the Google Cloud SDK.
# if [ -f '~/google-cloud-sdk/path.zsh.inc' ]; then . '~/google-cloud-sdk/path.zsh.inc'; fi

# # The next line enables shell command completion for gcloud.
# if [ -f '~/google-cloud-sdk/completion.zsh.inc' ]; then . '~/google-cloud-sdk/completion.zsh.inc'; fi

# # autoload -Uz compinit && compinit
# asdf reshim
