#!/bin/bash

# 1. Update system packages
echo "Updating system..."
sudo apt update && sudo apt upgrade -y

# 2. Install NVIDIA Drivers
# 'ubuntu-drivers autoinstall' picks the best proprietary driver for your card
echo "Installing NVIDIA drivers..."
sudo apt install -y ubuntu-drivers-common
sudo ubuntu-drivers autoinstall

# 3. Install CUDA Toolkit
echo "Installing CUDA toolkit..."
sudo apt install -y nvidia-cuda-toolkit

echo "Installation complete. PLEASE REBOOT YOUR SYSTEM."