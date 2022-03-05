git clone https://github.com/zsh-users/zsh-autosuggestions $ZSH/plugins/zsh-autosuggestions

rm -f ~/.zshrc
ln -s ~/dotfiles/.zshrc ~/.zshrc

rm -f ~/.gitconfig
ln -s ~/dotfiles/.gitconfig ~/.gitconfig

rm -f ~/.config/lvim/config.lua
ln -s ~/dotfiles/config.lua ~/.config/lvim/config.lua

rm -f ~/.config/terminator/config
ln -s ~/dotfiles/config.terminator ~/.config/terminator/config

poetry config virtualenvs.in-project true

