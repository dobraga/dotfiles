sudo apt install -y zsh locales-all

sh -c "$(curl -fsSL https://pyenv.run)"
sh -c "$(curl -fsSL https://starship.rs/install.sh)"
sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
curl -sSL https://install.python-poetry.org | python3 -

git clone https://github.com/zsh-users/zsh-autosuggestions "$ZSH/plugins/zsh-autosuggestions"
