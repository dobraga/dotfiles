wget -qO- https://cloud.r-project.org/bin/linux/ubuntu/marutter_pubkey.asc | sudo tee -a /etc/apt/trusted.gpg.d/cran_ubuntu_key.asc
sudo add-apt-repository "deb https://cloud.r-project.org/bin/linux/ubuntu $(lsb_release -cs)-cran40/"

sudo apt install -y zsh locales-all r-base libcurl4-openssl-dev libsodium-dev

sh -c "$(curl -fsSL https://pyenv.run)"
sh -c "$(curl -fsSL https://starship.rs/install.sh)"
curl -sSL https://raw.githubusercontent.com/python-poetry/poetry/master/get-poetry.py | python3 -
git clone https://github.com/zsh-users/zsh-autosuggestions "$ZSH/plugins/zsh-autosuggestions"
sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
