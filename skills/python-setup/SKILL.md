---
name: python-setup
description: >
  ALWAYS invoke when: user creates a Python project, runs `uv init`, sets up
  `pyproject.toml`, adds/removes packages, installs dependencies, configures
  linting/formatting/testing, writes a standalone Python script with deps, or
  migrates from pip/Poetry/requirements.txt/mypy/black/pre-commit/prek.
  Apply code standards (typing, logging, pathlib, Pydantic) to ALL Python work.
---

# Python Project Setup

Code standards are in `.claude/rules/python.md` — apply them to every file.

## Project Setup — Run in Order

### Step 1: Initialize

**Project (multi-file):**
```bash
uv init --package myproject   # distributable library
uv init myproject             # internal/app (no build)
```

### Step 2: Add Dependencies

```bash
uv add requests
uv add --group dev ruff ty pip-audit taskipy
uv add --group test pytest pytest-cov hypothesis
```

Never edit `pyproject.toml` manually for deps. Never use `uv pip install`.

### Step 3: Configure pyproject.toml

Use the template in `../templates/pyproject.toml`. If the project needs git hooks, use `references/prek.md`.

### Step 4: Install

```bash
uv sync --all-groups
```

### Step 5: Configure tests and task runner

Invoke the `/python-tests` skill to set up pytest, Hypothesis, and taskipy — it owns all test configuration including:
- `[tool.pytest.ini_options]` and `[tool.coverage.*]` in `pyproject.toml`
- `[tool.taskipy.tasks]` with `lint`, `format`, `test` (with `pre_test` / `post_test`)
- `tests/conftest.py` with Hypothesis profile wired to `PROFILE` env var
- Docker Compose + LocalStack if AWS services are needed

### Step 6: Add Makefile

Use the template in `../templates/Makefile`. Key targets:

| Target | Command |
|--------|---------|
| `make dev` | `uv sync --all-groups` and `uv run prek install` |
| `make lint` | `uv run task lint` |
| `make format` | `uv run task format` |
| `make test` | `uv run task test` |
| `make build` | `uv build` |
| `make hooks` | `uv run prek run --all-files` |
| `make audit` | `uv run pip-audit` |

---

## Anti-Patterns

| Never | Always |
|-------|--------|
| `uv pip install` | `uv add` / `uv sync` |
| `source .venv/bin/activate` | `uv run <cmd>` |
| `[project.optional-dependencies]` for dev | `[dependency-groups]` (PEP 735) |
| `requirements.txt` | `pyproject.toml` + `uv.lock` |
| `mypy` / `pyright` | `ty` |
| `black` / `isort` / `flake8` | `ruff` |
| `pre-commit` | `prek` |
| `Poetry` | `uv` |
| `[tool.ty]` python-version | `[tool.ty.environment]` python-version |

---

## Checklist Before Finishing

- [ ] `src/` layout used
- [ ] `requires-python = ">=3.11"`
- [ ] `ruff` + `ty` configured
- [ ] `taskipy` tasks configured (`lint`, `format`, `test`) — delegate to `/python-tests`
- [ ] Coverage minimum set (80%+)
- [ ] `uv.lock` committed
- [ ] `prek install` run (git hooks active)
- [ ] Code standards from `.claude/rules/python.md` applied
