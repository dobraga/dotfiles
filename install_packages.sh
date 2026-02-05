# Instala fonte
curl -OL https://github.com/ryanoasis/nerd-fonts/releases/download/v3.1.1/FiraCode.zip
unzip FiraCode.zip -d ~/.fonts
rm FiraCode.zip
fc-cache -f -v

# Docker sem sudo
sudo usermod -aG docker ${USER}
su - ${USER}

ASDF
git clone https://github.com/asdf-vm/asdf.git ~/.asdf --branch master --depth 1
source $HOME/.asdf/asdf.sh
# asdf plugin add golang https://github.com/asdf-community/asdf-golang.git
asdf plugin add rust https://github.com/code-lever/asdf-rust.git

## GO and Rust
# GO_VERSION=$(asdf latest golang)
# RUST_VERSION=$(asdf latest rust)
# PYTHON_VERSION=$(asdf latest python)

# asdf install golang $GO_VERSION
asdf install rust $RUST_VERSION

# asdf global golang $GO_VERSION
asdf global rust $RUST_VERSION

# Instala libs em rust
curl https://sh.rustup.rs -sSf | sh
. "$HOME/.cargo/env"
cargo install bat exa ytop ripgrep

# Instala neovim
# curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-linux64.tar.gz
# sudo rm -rf /opt/nvim
# sudo tar -C /opt -xzf nvim-linux64.tar.gz
# rm nvim-linux64.tar.gz

# Instala lazygit
# LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
# curl -Lo lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/latest/download/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
# tar xf lazygit.tar.gz lazygit
# sudo install lazygit /usr/local/bin

# Instala lunarvim
# LV_BRANCH='release-1.3/neovim-0.9' bash <(curl -s https://raw.githubusercontent.com/LunarVim/LunarVim/release-1.3/neovim-0.9/utils/installer/install.sh)

# Atualiza
sudo apt upgrade -y
sudo apt dist-upgrade -y
sudo apt autoremove -y
sudo apt autoclean -y

# Instala uv, starship, docker
sh -c "$(curl -fsSL https://astral.sh/uv/install.sh)"
sh -c "$(curl -fsSL https://starship.rs/install.sh)"
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"

git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions --depth=1
git clone https://github.com/zsh-users/zsh-syntax-highlighting ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting --depth=1


# ZSH default
chsh -s $(which zsh)
uv python install --default --preview-features python-install-default
