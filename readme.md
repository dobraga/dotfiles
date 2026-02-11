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
```

This will install:
- FiraCode Nerd Font
- asdf version manager
- Rust and cargo tools (bat, exa, ytop, ripgrep)
- uv (Python package installer)
- Starship prompt
- Oh My Zsh with plugins

### 3. Symlink configuration files

```sh
rm -f ~/.zshrc
ln -s ~/src/dotfiles/.zshrc ~/.zshrc

rm -f ~/.gitconfig
ln -s ~/src/dotfiles/.gitconfig ~/.gitconfig

ln -s ~/src/dotfiles/.claude/skills/ ~/.claude/skills
ln -s ~/src/dotfiles/.claude/CLAUDE.md ~/.claude/
ln -s ~/src/dotfiles/.claude/settings.json ~/.claude/
ln -s ~/src/dotfiles/.claude/statusline.py ~/.claude/
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

## Claude Code Integration

Includes custom skills and rules for Claude Code:
- `modern-python`: Configures Python projects with uv, ruff, and type hints
- `pr-writter`: Generates pull request summaries
- `readme`: Creates comprehensive READMEs for Python projects
- `code-style`: Enforces modern Python 3.10+ standards

## Requirements

- Linux (tested on WSL2)
- Zsh
- Git
