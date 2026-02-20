#!/bin/bash

# 1. Update system packages
echo "Updating system..."
sudo apt update && sudo apt upgrade -y

# 2. Install NVIDIA Drivers
# 'ubuntu-drivers autoinstall' picks the best proprietary driver for your card
echo "Installing NVIDIA drivers..."
sudo apt install -y ubuntu-drivers-common
sudo ubuntu-drivers autoinstall

# 3. Install container Toolkit
echo "Installing container toolkit..."
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg \
  && curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit

echo "Installation complete. PLEASE REBOOT YOUR SYSTEM."