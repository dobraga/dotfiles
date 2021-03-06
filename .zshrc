export ZSH=$HOME/.oh-my-zsh
export PATH="$HOME/.pyenv/bin:/$HOME/.poetry/bin:$HOME/.cargo/bin:$HOME/go/bin:$PATH"
export STARSHIP_CONFIG="$HOME/dotfiles/starship.toml"

plugins=(
    git
    zsh-autosuggestions
)

source $ZSH/oh-my-zsh.sh

eval "$(pyenv init -)"
eval "$(pyenv init --path)"
eval "$(pyenv virtualenv-init -)"
eval "$(starship init zsh)"

alias top=ytop
alias ll="exa --icons --git -l -h --time-style=long-iso"
alias ls="exa --icons --git -l -h --time-style=long-iso"
alias cat="bat --style=auto"
alias diff="fd"
alias p="poetry"
alias pshell="poetry shell"
alias padd="poetry add"
alias pinstall="poetry install"
alias penv="poetry env"
alias m=make
alias d=docker
alias dc=docker-compose

alias cls="clear"
alias ..="cd .."
alias ...="cd ../.."
alias cd..="cd .."

fd() {
  preview="git diff $@ --color=always -- {-1}"
  git diff $@ --name-only | fzf -m --ansi --preview $preview
}

jl() {
  poetry run jupyter-lab
}
