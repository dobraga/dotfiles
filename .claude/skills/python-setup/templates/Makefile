.PHONY: dev lint format test build hooks hooks-install audit

dev:
	uv sync --all-groups
	uv run prek install

lint:
	uv run ruff format --check && uv run ruff check && uv run ty check src/

format:
	uv run ruff format .

test:
	uv run pytest

build:
	uv build

hooks:
	uv run prek run --all-files

audit:
	uv run pip-audit
