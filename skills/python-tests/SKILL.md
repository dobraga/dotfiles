---
name: python-tests
description: >
  Write gold-standard Python tests using pytest, Hypothesis property-based testing,
  and AWS service mocking via Docker Compose + LocalStack 3.8.
  TRIGGER when: user asks to write tests, add test coverage, test AWS integrations,
  or use property-based testing / Hypothesis.
  DO NOT TRIGGER when: user is setting up a project from scratch (use /python-setup instead).
---

## Step 1 — Discover context

Run in parallel:
- Read `pyproject.toml` to know the project name, test config, and existing deps
- `ls tests/` (or `test/`) to understand current test structure
- Identify what the user wants tested (unit, integration, AWS)

## Step 2 — Install dependencies

Add only what is missing (check `pyproject.toml` first):

```bash
# Core test stack + task runner
uv add --group dev taskipy
uv add --group test pytest pytest-cov

# Property-based testing
uv add --group test hypothesis

# Async support (add only if project is async)
uv add --group test pytest-asyncio anyio

# AWS integration tests
uv add --group test pytest-docker boto3
```

LocalStack itself runs via Docker Compose — no Python package needed.

## Step 3 — Configure pytest and taskipy

Ensure `pyproject.toml` has the correct config (see references: `references/pytest-config.md`, `references/taskipy-config.md`).

Standard taskipy tasks to add:

```toml
[tool.taskipy.tasks]
pre_test  = "task lint"
test      = "PROFILE=local pytest --cov --cov-config=pyproject.toml --cov-report=term-missing --cov-report=html -vv"
post_test = 'echo "Coverage report generated in htmlcov/index.html"'
lint      = "ruff check . && ruff check . --diff"
format    = "ruff check . --fix && ruff format ."
```

Key rules:
- `--strict-markers` always on
- Coverage threshold ≥ 80%
- Mark slow/integration tests so they can be skipped in fast CI runs
- `PROFILE` env var controls Hypothesis example count (local=50, ci=500)

## Step 4 — Write tests using gold patterns

Choose the right pattern for the scope:

| Scope | Pattern |
|---|---|
| Pure functions / data transforms | Hypothesis `@given` |
| Business logic with fixed cases | `@pytest.mark.parametrize` |
| AWS S3 / SQS / DynamoDB / etc. | LocalStack via Docker Compose |
| External HTTP APIs | `pytest-httpx` or `responses` |
| Async code | `pytest-asyncio` with `anyio` backend |

See detailed patterns in:
- `references/hypothesis-patterns.md` — property-based testing
- `references/localstack-patterns.md` — AWS mocking with LocalStack 3.8

## Step 5 — Validate

```bash
# Full run: lint → pytest with coverage (standard)
uv run task test

# Integration tests only (requires LocalStack running)
docker compose up -d localstack
uv run pytest -m integration -v

# Property tests only
uv run pytest -m property

# Fast iteration (skip lint and coverage)
uv run pytest -x -q --no-cov
```

Gate: all tests pass and coverage is ≥ 80% before declaring done.

## Step 6 — Report

Tell the user:
- How many tests were added and what they cover
- Which Hypothesis strategies were used and why
- Whether LocalStack was needed and how to start it (`docker compose up -d localstack`)
- Any coverage gaps that remain
