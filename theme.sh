cd /tmp/

# Instala fontes
wget https://github.com/ryanoasis/nerd-fonts/releases/download/v2.1.0/DroidSansMono.zip
unzip DroidSansMono.zip -d ~/.fonts
fc-cache -fv

# Instala temas
mkdir -p ~/.themes/
git clone https://github.com/dracula/gtk.git ~/.themes/dracula/
git clone https://github.com/EliverLara/Ant-Dracula --branch slim  ~/.themes/Ant-Dracula/
git clone https://github.com/archbyte/Adwaita-Slim --branch dark ~/.themes/Adwaita-Slim-Dark/gtk-3.0/


# Instala icones
mkdir -p ~/.icons/
git clone https://github.com/vinceliuice/Tela-icon-theme
./Tela-icon-theme/install.sh



# Configura GNOME
# https://askubuntu.com/questions/26056/where-are-gnome-keyboard-shortcuts-stored
# dconf dump '/' > configs/custom-dconf.toml
sudo apt install gnome-tweaks dconf-editor -y
dconf load '/' < configs/custom-dconf.toml

# Extensões utilizadas
# Dash to Dock, User Themes, Caffeine, Soft brightness, WindowOverlay Icons, Dynamic Panel Transparency, Freon, Pixel Saver, Hide Top Bar, ShellTile, Unite
