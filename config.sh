git clone https://github.com/zsh-users/zsh-autosuggestions $ZSH/plugins/zsh-autosuggestions

rm -f ~/.zshrc
ln -s ~/dotfiles/configs/.zshrc ~/.zshrc

rm -f ~/.gitconfig
ln -s ~/dotfiles/configs/.gitconfig ~/.gitconfig

rm -f ~/.config/lvim/config.lua
ln -s ~/dotfiles/configs/config.lua ~/.config/lvim/config.lua

rm -rf ~/.config/terminator
mkdir ~/.config/terminator
ln -s ~/dotfiles/configs/config.terminator ~/.config/terminator/config

rm -rf ~/.config/lvim/lsp-settings
mkdir ~/.config/lvim/lsp-settings

echo "
Para configuração do linter do python no lunarvim, execute:

:NlspConfig pyright

{
  'python.analysis.typeCheckingMode': 'off'
}
"

