sudo apt install -y ca-certificates curl gnupg lsb-release apt-transport-https

sudo add-apt-repository universe -y

# Adiciona repository do docker
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
    $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Adiciona repository do docker
sudo apt-get install wget gpg
wget -qO- https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > packages.microsoft.gpg
sudo install -o root -g root -m 644 packages.microsoft.gpg /etc/apt/trusted.gpg.d/
sudo sh -c 'echo "deb [arch=amd64,arm64,armhf signed-by=/etc/apt/trusted.gpg.d/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list'
rm -f packages.microsoft.gpg

# Adiciona repository do neovim, terminator, node e yarn
sudo add-apt-repository ppa:neovim-ppa/unstable
sudo add-apt-repository ppa:gnome-terminator
curl -fsSL https://deb.nodesource.com/setup_17.x | sudo -E bash -
curl -fsSL https://dl.yarnpkg.com/debian/pubkey.gpg | sudo apt-key add -

# Adiciona repository do chrome
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list'

sudo apt update && sudo apt install -y git zsh locales-all cargo ripgrep \
    neovim fzf nodejs terminator yarn google-chrome-stable code \
    docker-ce docker-ce-cli containerd.io

# ZSH default
chsh -s $(which zsh)

# Instala libs em rust
cargo install bat exa ytop

# Docker sem sudo
sudo usermod -aG docker ${USER}
su - ${USER}

# Atualiza
sudo apt upgrade -y
sudo apt dist-upgrade -y
sudo apt autoremove -y
sudo apt autoclean -y

# Instala pyenv, poetry, starship
sh -c "$(curl -fsSL https://pyenv.run)"
sh -c "$(curl -fsSL https://starship.rs/install.sh)"
curl -sSL https://raw.githubusercontent.com/python-poetry/poetry/master/get-poetry.py | python3 -
sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
