#!/usr/bin/env bash
# Loads hooks/register.tsx natively (as the engine does) against a stub of `claude-code` and calls `register`.
# Catches what tsc and `claude plugin validate` miss: a value import of a type, a missing export, a throw while registering.
set -euo pipefail

mod="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/stub.ts" <<'TS'
export const atom = (ref: unknown, init: unknown) => ({ ref, init })
export const read = async (_: unknown, a: { init: unknown }) => a.init
export const update = async () => undefined
export const memberOf = (a: unknown) => a
export const derive = (a: unknown) => a
TS
cat > "$work/tsconfig.json" <<JSON
{ "compilerOptions": { "verbatimModuleSyntax": true, "jsx": "react", "jsxFactory": "h", "paths": { "claude-code": ["$work/stub.ts"] } } }
JSON
cat > "$work/load.ts" <<TS
;(globalThis as { h?: unknown }).h = (t: unknown, p: unknown, ...c: unknown[]) => ({ t, p, c })
const m = await import('$mod/hooks/register.tsx')
let hooks = 0
m.register(() => { hooks += 1 }, {})
console.log('load-check: ok (' + hooks + ' hooks registered)')
TS
bun --tsconfig-override="$work/tsconfig.json" run "$work/load.ts"

# The engine links modules strictly: `import { Name }` of a type that the target only exports as a type is a SyntaxError at load.
cat > "$work/types.ts" <<'TS'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? ''
const files = readdirSync(dir).filter(f => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
const typeExports = new Map<string, Set<string>>()
for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8')
  typeExports.set(f.replace(/\.(ts|tsx)$/, ''), new Set([...src.matchAll(/^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1] ?? '')))
}
let bad = 0
for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8')
  for (const m of src.matchAll(/^import\s+\{([\s\S]*?)\}\s+from\s+'\.\/([\w-]+)'/gm)) {
    const types = typeExports.get(m[2] ?? '')
    if (!types) continue
    for (const raw of (m[1] ?? '').split(',')) {
      const spec = raw.trim()
      if (!spec || spec.startsWith('type ')) continue
      if (types.has(spec.split(' as ')[0]?.trim() ?? '')) {
        console.error(`load-check: ${f} imports the type ${spec} from ./${m[2]} without "type"`)
        bad += 1
      }
    }
  }
}
if (bad > 0) process.exit(1)
console.log('load-check: type-only imports ok')
TS
bun run "$work/types.ts" "$mod/hooks"
