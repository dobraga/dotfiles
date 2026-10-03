# Taskipy — Standard Task Runner Configuration

## Install

```bash
uv add --group dev taskipy
```

## pyproject.toml

```toml
[tool.taskipy.tasks]
pre_test  = "task lint"
test      = "pytest --cov --cov-config=pyproject.toml --cov-report=term-missing --cov-report=html -vv"
post_test = 'echo "Coverage report generated in htmlcov/index.html"'
lint      = "ruff check . && ruff check . --diff"
format    = "ruff check . --fix && ruff format ."
```

## Usage

```bash
uv run task test      # lint → pytest with coverage → echo report path
uv run task lint      # ruff check only (no fix)
uv run task format    # ruff auto-fix + format
```

## Notes

- `pre_test` runs lint automatically before any test run — no separate CI step needed.
- Coverage config lives in `pyproject.toml` under `[tool.coverage.*]`.
