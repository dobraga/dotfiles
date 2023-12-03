sudo apt install -y ca-certificates curl gnupg lsb-release apt-transport-https
sudo add-apt-repository universe -y

# Adiciona repository do neovim
sudo add-apt-repository ppa:neovim-ppa/unstable

# Instala
sudo apt update && sudo apt install -y git zsh locales-all ripgrep neovim fzf

# ZSH default
chsh -s $(which zsh)

# Docker sem sudo
sudo usermod -aG docker ${USER}
su - ${USER}

# ASDF
git clone https://github.com/asdf-vm/asdf.git ~/.asdf --branch master
. "$HOME/.asdf/asdf.sh"
asdf plugin add golang https://github.com/asdf-community/asdf-golang.git
asdf plugin add rust https://github.com/code-lever/asdf-rust.git
asdf plugin-add python

## GO and Rust
GO_VERSION=$(asdf latest golang)
RUST_VERSION=$(asdf latest rust)
PYTHON_VERSION=$(asdf latest python)

asdf install golang $GO_VERSION
asdf install rust $RUST_VERSION
asdf install python $PYTHON_VERSION

asdf global golang $GO_VERSION
asdf global rust $RUST_VERSION
asdf global python $PYTHON_VERSION

# Instala libs em rust
cargo install bat exa ytop

# Atualiza
sudo apt upgrade -y
sudo apt dist-upgrade -y
sudo apt autoremove -y
sudo apt autoclean -y

# Instala pyenv, poetry, starship, docker
sh -c "$(curl -fsSL https://get.docker.com)"
sh -c "$(curl -fsSL https://starship.rs/install.sh)"

python3 -m pip install --user -U pipx
pipx install poetry
