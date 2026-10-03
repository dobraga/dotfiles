# Dotfiles

Personal configuration files for a productive development environment on Linux (WSL2).

## Features

- **Shell**: Zsh with Oh My Zsh, autosuggestions, and syntax highlighting
- **Prompt**: Starship for a fast, customizable prompt
- **Tools**: Modern CLI replacements (bat, exa, ripgrep, ytop)
- **Version Management**: asdf for Rust
- **Python**: uv for fast Python package management

## Installation

### 1. Clone the repository

```sh
git clone https://github.com/dobraga/dotfiles.git ~/src/dotfiles
cd ~/src/dotfiles
```

### 2. Run the installation script

```sh
bash install_packages.sh
bash install_nvdia.sh
bash install_agents.sh
```

This will install:
- FiraCode Nerd Font
- asdf version manager
- Rust and cargo tools (bat, exa, ytop, ripgrep)
- uv (Python package installer)
- Starship prompt
- Oh My Zsh with plugins
- Claude Code CLI, RTK, Graphify, and user MCP servers
- Shared AI Agents, Skills, Rules, and statusline symlinks for Claude Code & Antigravity

### 3. Symlink configuration files

```sh
rm -f ~/.zshrc
ln -s ~/src/dotfiles/.zshrc ~/.zshrc
ln -s ~/src/dotfiles/.env ~/.env

rm -f ~/.gitconfig
ln -s ~/src/dotfiles/.gitconfig ~/.gitconfig

# Claude Code & Antigravity Setup
bash install_agents.sh
```

## Configuration

### Zsh Aliases

| Alias | Command |
|-------|---------|
| `py` | `clear && python` |
| `g` | `git` |
| `gp` | `git push` |
| `gc` | `git commit -m` |
| `gst` | `git status` |
| `m` | `make` |
| `d` | `docker` |
| `dc` | `docker-compose` |
| `top` | `ytop` |
| `cat` | `bat` |
| `ls` | `exa --icons --git` |
| `ll` | `exa -l --icons --git` |

### Starship Prompt

Minimal configuration with package module enabled. Custom error symbol (`x`) for failed commands.

### Git

Default branch set to `main`.

## Claude Code & Antigravity Integration

Shared configuration (`agents/`, `skills/`, `rules/`, and universal `AGENTS.md`) across Claude Code and Antigravity CLI:
- `agents/`: Shared subagent personas (e.g. data-analyst, ds-ml, mlops, qa-roaster)
- `skills/`: Shared workflows and runbooks (e.g. graphify, grill-me, impeccable, python-setup)
- `rules/`: Shared coding guidelines (e.g. python.md)
- `AGENTS.md`: Universal agent instructions natively supported by both Claude Code and Antigravity
- Statuslines: Dedicated statusline scripts tailored for Claude Code (`.claude/statusline.py`) and Antigravity (`.gemini/statusline.py`)

## Requirements

- Linux (tested on WSL2)
- Zsh
- Git
