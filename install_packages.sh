#!/usr/bin/env bash
# Install font
curl -OL https://github.com/ryanoasis/nerd-fonts/releases/download/v3.1.1/FiraCode.zip
unzip FiraCode.zip -d ~/.fonts
rm FiraCode.zip
fc-cache -f -v

# Install kitty terminal (config is linked by install_dotfiles.sh)
sudo apt install -y kitty

# Install Herdr (config is linked by install_dotfiles.sh)
curl -fsSL https://releases.herdr.dev/app/install.sh | sh

# Install herdr-automations, the scheduler behind the Automations panel (herdr-app/mods/automations).
# Prebuilt release binary, checksum verified; skipped when already installed or on any failure.
install_herdr_automations() {
  command -v herdr-automations >/dev/null 2>&1 && return 0
  local os arch tag asset base tmp expected actual
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) return 0 ;; esac
  case "$(uname -m)" in arm64 | aarch64) arch=arm64 ;; x86_64 | amd64) arch=amd64 ;; *) return 0 ;; esac
  tag=$(curl -fsSL https://api.github.com/repos/DnzzL/herdr-automations/releases/latest |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1) || return 0
  [ -n "$tag" ] || return 0
  asset="herdr-automations_${os}_${arch}"
  base="https://github.com/DnzzL/herdr-automations/releases/download/${tag}"
  tmp=$(mktemp -d)
  if curl -fsSL "${base}/${asset}" -o "${tmp}/${asset}" && curl -fsSL "${base}/checksums.txt" -o "${tmp}/checksums.txt"; then
    expected=$(grep " ${asset}\$" "${tmp}/checksums.txt" | cut -d' ' -f1)
    actual=$( (sha256sum "${tmp}/${asset}" 2>/dev/null || shasum -a 256 "${tmp}/${asset}") | cut -d' ' -f1)
    if [ -n "$expected" ] && [ "$expected" = "$actual" ]; then
      # The service writes its log under the state dir and fails to start (209/STDOUT) if it is missing;
      # `backend: hc` makes runs open in the Herdr app.
      mkdir -p "$HOME/.local/bin" "$HOME/.local/state/herdr/plugins/dnzzl.automations" "$HOME/.config/herdr/plugins/config/dnzzl.automations"
      [ -e "$HOME/.config/herdr/plugins/config/dnzzl.automations/automations.yaml" ] ||
        printf 'backend: hc\nautomations: []\n' > "$HOME/.config/herdr/plugins/config/dnzzl.automations/automations.yaml"
      install -m 755 "${tmp}/${asset}" "$HOME/.local/bin/herdr-automations" &&
        "$HOME/.local/bin/herdr-automations" service install || echo "herdr-automations: install step failed, skipping" >&2
    else
      echo "herdr-automations: checksum mismatch, not installing" >&2
    fi
  else
    echo "herdr-automations: download failed, skipping" >&2
  fi
  rm -rf "$tmp"
  return 0
}
install_herdr_automations

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
cargo install bat exa ytop ripgrep

# Install neovim
# curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-linux64.tar.gz
# sudo rm -rf /opt/nvim
# sudo tar -C /opt -xzf nvim-linux64.tar.gz
# rm nvim-linux64.tar.gz

# Install lazygit
# LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
# curl -Lo lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/latest/download/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
# tar xf lazygit.tar.gz lazygit
# sudo install lazygit /usr/local/bin

# Install lunarvim
# LV_BRANCH='release-1.3/neovim-0.9' bash <(curl -s https://raw.githubusercontent.com/LunarVim/LunarVim/release-1.3/neovim-0.9/utils/installer/install.sh)

# Install Docker
sudo apt install ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg   
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

## Docker sem sudo
sudo usermod -aG docker ${USER}
su - ${USER}

# Install zsh
sudo apt install -y zsh
sh -c "$(curl -fsSL https://starship.rs/install.sh)"
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions --depth=1
git clone https://github.com/zsh-users/zsh-syntax-highlighting ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting --depth=1

# Install uv, starship, docker
sh -c "$(curl -fsSL https://astral.sh/uv/install.sh)"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# Update and clean packages
sudo apt upgrade -y
sudo apt dist-upgrade -y
sudo apt autoremove -y
sudo apt autoclean -y

# ZSH default
chsh -s "$(which zsh)"
uv python install --default --preview-features python-install-default

# uses F keys
echo "options hid_apple fnmode=2" | sudo tee /etc/modprobe.d/hid_apple.conf
