git clone https://github.com/zsh-users/zsh-autosuggestions $ZSH/plugins/zsh-autosuggestions

rm -f ~/.zshrc
ln -s ~/dotfiles/.zshrc ~/.zshrc

rm -f ~/.gitconfig
ln -s ~/dotfiles/.gitconfig ~/.gitconfig

rm -f ~/.config/lvim/config.lua
ln -s ~/dotfiles/config.lua ~/.config/lvim/config.lua

rm -rf ~/.config/terminator
mkdir ~/.config/terminator
ln -s ~/dotfiles/config.terminator ~/.config/terminator/config

rm -rf ~/.config/lvim/lsp-settings
mkdir ~/.config/lvim/lsp-settings

echo "
Para configuração do linter do python, execute:

:NlspConfig pyright

{
  'python.analysis.typeCheckingMode': 'off'
}
"

