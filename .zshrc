export ZSH=$HOME/.oh-my-zsh
export DENO_INSTALL="$HOME/.deno"
export PATH="$HOME/.local/bin:$DENO_INSTALL/bin:$PATH"
export STARSHIP_CONFIG="$HOME/dotfiles/starship.toml"

plugins=(
    git
    zsh-autosuggestions
)

source $ZSH/oh-my-zsh.sh

eval "$(starship init zsh)"

. "$HOME/.asdf/asdf.sh"

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

# The next line updates PATH for the Google Cloud SDK.
if [ -f '~/google-cloud-sdk/path.zsh.inc' ]; then . '~/google-cloud-sdk/path.zsh.inc'; fi

# The next line enables shell command completion for gcloud.
if [ -f '~/google-cloud-sdk/completion.zsh.inc' ]; then . '~/google-cloud-sdk/completion.zsh.inc'; fi

export NVM_DIR="/home/dobraga/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"  # This loads nvm

# autoload -Uz compinit && compinit
asdf reshim
