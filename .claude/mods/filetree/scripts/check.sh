#!/usr/bin/env bash
# Everything to run before a commit: unit tests, the plugin validator and the type check.
set -euo pipefail

mod="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$mod"

echo "== bun test"
bun test hooks
echo "== claude plugin validate"
claude plugin validate .
echo "== typecheck"
./scripts/typecheck.sh
