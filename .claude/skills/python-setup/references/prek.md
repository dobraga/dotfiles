# prek: Fast Pre-commit Hooks

[prek](https://github.com/j178/prek) is a fast, Rust-native drop-in replacement for pre-commit. It uses the same `.pre-commit-config.yaml` format and is fully compatible with existing configurations.

## Installation

```
uv add --dev prek
```

## Quick Start

### For Existing pre-commit Users

prek is fully compatible with `.pre-commit-config.yaml`. Just replace commands:

```bash
# Instead of: pre-commit install
uv run prek install

# Instead of: pre-commit run --all-files
uv run prek run --all-files

# Instead of: pre-commit autoupdate
uv run prek auto-update
```

### New Setup

1. Create `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: <latest>  # https://github.com/astral-sh/ruff-pre-commit/releases
    hooks:
      # Run the linter.
      - id: ruff-check
        args: [--fix, --exit-non-zero-on-fix]
      # Run the formatter.
      - id: ruff-format
```

For a complete, copy-paste-ready configuration, see `../templates/pre-commit-config.yaml`.

2. Install and run:

```bash
# Install git hooks
uv run prek install

# Run manually on all files
uv run prek run --all-files

# Run specific hook
uv run prek run ruff
```

### Using Built-in Hooks

prek includes Rust-native implementations of common hooks for extra speed:

```yaml
repos:
  - repo: builtin
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-json
      - id: check-toml
```

## Commands

| Command | Description |
|---------|-------------|
| `uv add prek --group dev` | Install prek on repo |
| `uv run prek install` | Install git hooks |
| `uv run prek uninstall` | Remove git hooks |
| `uv run prek run` | Run hooks on staged files |
| `uv run prek run --all-files` | Run on all files |
| `uv run prek run --last-commit` | Run on last commit's files |
| `uv run prek run HOOK [HOOK...]` | Run specific hook(s) |
| `uv run prek run -d src/` | Run on files in directory |
| `uv run prek auto-update` | Update hook versions |
| `uv run prek list` | List configured hooks |
| `uv run prek clean` | Remove cached environments |

## Makefile Integration

```makefile
.PHONY: hooks hooks-install

hooks:
	uv run prek run --all-files

hooks-install:
	uv run prek install
```

## Migration from pre-commit

1. Install prek: `uv tool install prek`
2. Remove pre-commit: `pip uninstall pre-commit` or `uv tool uninstall pre-commit`
3. Re-install hooks: `prek install`
4. (Optional) Clean old environments: `rm -rf ~/.cache/pre-commit`

Your existing `.pre-commit-config.yaml` works unchanged.

## Best Practices

1. **Use `prek run --all-files` in CI** - Ensures all files are checked, not just changed ones
2. **Pin hook versions** - Use specific `rev` values, not branches
3. **Use `--cooldown-days` for auto-update** - Mitigates supply chain attacks: `prek auto-update --cooldown-days 7`
4. **Prefer built-in hooks** - Use `repo: builtin` for common checks (faster, offline)
5. **Run hooks before commit** - `prek install` sets this up automatically
6. **Initialize detect-secrets baseline** - Run `detect-secrets scan > .secrets.baseline` before first commit
