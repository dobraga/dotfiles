# Plan: syntax-colored diff in file-view

Repo: dotfiles, branch master. Scope: `herdr-app/mods/file-view/` only.

## Problem
`diffRow` (main.js:1837) draws each line as one plain `div().child(text)`. Only the row background (`ansi2`/`ansi1` + `18`) and the `+`/`-` marker are colored. The code itself has no syntax color.

## Reference
CodeyPacker/herdr-mods `git-good/mods/git-good/syntax.js`: dependency-free line lexer, about 200 lines. It colors each token as a `div` with `text_color` taken from theme tokens. Only part of its main.js was read, so the rendering notes are partly secondhand.

## Design
1. **New `syntax.js`** (pure, no imports, same folder, imported like `media-ui.js`).
   - `languageOf(path)`: by extension, then by filename.
   - `tokenize(text, lang, state)` returns `{tokens, open}`. Token kinds: keyword, string, comment, number, function, type, constant.
   - Language table written by us: JS/TS, py, sh, json, yaml/toml, md, css, go, rs, sql, html. Unknown languages return `null` and render plain.
2. **Wire into `diffRows(lines, path)`.**
   - Tokenize old (`-`) and new (`+`) sides separately, each with its own open-comment state.
   - Reset state at each `@@` hunk.
   - Tokenize context lines once and reuse the result.
   - Store `row.tokens`.
3. **Render in `diffRow`.**
   - If `tokens` exists, draw the text as an `h_flex` of token `div`s with `text_color` from `tone(kind)`.
   - Map: keyword→`ansi5`, string→`ansi2`, comment→`dim`, function→`ansi4`, type→`ansi3`, number/constant→`ansi6` (or `ansi3`; confirm it exists in the theme).
   - Otherwise fall back to the current single `div`.
4. **Guards.**
   - Keep `untab` and `MAX_DIFF_LINE_CHARS`.
   - Skip highlighting for lines over about 400 chars and for diffs over about 5000 rows.
   - Highlighting is purely visual; on any tokenizer exception, render the row plain.
5. **Perf check.** The diff list is virtualized (`range.start..end`). Tokenize in `diffRows` once per load, not per render.

## Open questions
- Does `h_flex` with many small children inside `truncate()` keep the one-line truncation? Test on a long line.
- Do `ansi5` and `ansi6` read well on the light and dark themes?
- Also color the plain file view? Out of scope here (TextView cannot color text).

## Todo
- [ ] `syntax.js` + a node test script run with plain node (`node --test`)
- [ ] Wire into `diffRows` / `diffRow`
- [ ] Large-diff and long-line guards
- [ ] Manual check in herdr (UI: build/tests only, NOT tested live until run)
