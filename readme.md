``` sh
rm -f ~/.zshrc
ln -s ~/dotfiles/.zshrc ~/.zshrc

rm -f ~/.gitconfig
ln -s ~/dotfiles/.gitconfig ~/.gitconfig

rm -rf ~/.config/terminator
mkdir ~/.config/terminator
ln -s ~/dotfiles/config.terminator ~/.config/terminator/config

dconf load '/' < ~/dotfiles/custom-dconf.toml
```
