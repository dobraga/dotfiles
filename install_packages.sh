# Adiciona repository do R e neovim
wget -qO- https://cloud.r-project.org/bin/linux/ubuntu/marutter_pubkey.asc | sudo tee -a /etc/apt/trusted.gpg.d/cran_ubuntu_key.asc
sudo add-apt-repository "deb https://cloud.r-project.org/bin/linux/ubuntu $(lsb_release -cs)-cran40/"
sudo add-apt-repository ppa:neovim-ppa/unstable
sudo add-apt-repository ppa:gnome-terminator
curl -fsSL https://deb.nodesource.com/setup_17.x | sudo -E bash -
curl -fsSL https://dl.yarnpkg.com/debian/pubkey.gpg | sudo apt-key add -

sudo apt-get update

sudo apt install -y zsh locales-all r-base libcurl4-openssl-dev libsodium-dev cargo ripgrep neovim fzf nodejs terminator yarn

# Instala fontes
wget https://github.com/ryanoasis/nerd-fonts/releases/download/v2.1.0/DroidSansMono.zip
unzip DroidSansMono.zip -d ~/.fonts
fc-cache -fv

# Instala libs em rust
cargo install bat exa ytop

# Instala pyenv, poetry, starship
sh -c "$(curl -fsSL https://pyenv.run)"
sh -c "$(curl -fsSL https://starship.rs/install.sh)"
curl -sSL https://raw.githubusercontent.com/python-poetry/poetry/master/get-poetry.py | python3 -
bash <(curl -s https://raw.githubusercontent.com/lunarvim/lunarvim/master/utils/installer/install.sh)
sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
