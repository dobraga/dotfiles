// Tiny line-based syntax colorer for diff rows. A close guess, not a parser. No imports so plain node can load it.
// Inspired by CodeyPacker/herdr-mods git-good/syntax.js.

const set = (s) => new Set(s.split(" "));
const JS = set("break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as get set");
const PY = set("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case");
const SH = set("if then else elif fi for while until do done case esac in function return local export readonly set unset source alias exit break continue select");
const GO = set("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var");
const RS = set("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while");
const CLIKE = set("abstract break case catch class const continue default do else enum extends final finally for if implements import interface new package private protected public return static switch this throw throws try void while namespace using struct virtual override");
const CSS = set("important media import keyframes supports font-face");
const SQL = set("select from where and or not null insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset as distinct union case when then else end primary key foreign references default");
const NONE = new Set();

const C_LINE = ["//"], HASH = ["#"];
const mk = (words, o = {}) => ({ words, line: [], block: [], quotes: "\"'", regex: false, fold: false, ...o });

const LANGS = {
  js: mk(JS, { line: C_LINE, block: [["/*", "*/"]], quotes: "\"'`", regex: true }),
  clike: mk(CLIKE, { line: C_LINE, block: [["/*", "*/"]] }),
  go: mk(GO, { line: C_LINE, block: [["/*", "*/"]], quotes: "\"'`" }),
  rs: mk(RS, { line: C_LINE, block: [["/*", "*/"]] }),
  css: mk(CSS, { block: [["/*", "*/"]] }),
  json: mk(NONE, { quotes: "\"" }),
  py: mk(PY, { line: HASH }),
  sh: mk(SH, { line: HASH }),
  yaml: mk(NONE, { line: HASH }),
  sql: mk(SQL, { line: ["--"], block: [["/*", "*/"]], fold: true }),
  md: mk(NONE, { quotes: "`" }),
  html: mk(NONE, { block: [["<!--", "-->"]] }),
};

const BY_ENDING = {};
const add = (lang, exts) => exts.split(" ").forEach((e) => (BY_ENDING[e] = lang));
add("js", "js mjs cjs jsx ts tsx mts cts");
add("clike", "c h cpp cc hpp java kt swift php dart scala cs");
add("go", "go");
add("rs", "rs");
add("css", "css scss less");
add("json", "json jsonc");
add("py", "py");
add("sh", "sh bash zsh rb ps1");
add("yaml", "yml yaml toml ini conf env");
add("sql", "sql");
add("md", "md markdown");
add("html", "html htm xml svg vue");
const BY_NAME = { dockerfile: "sh", makefile: "sh", ".gitignore": "sh", ".gitattributes": "sh", ".env": "yaml", ".zshrc": "sh", ".bashrc": "sh" };

export function languageOf(path) {
  const name = String(path ?? "").split("/").pop()?.toLowerCase() ?? "";
  const key = BY_NAME[name] ?? (name.lastIndexOf(".") < 0 ? null : BY_ENDING[name.slice(name.lastIndexOf(".") + 1)]);
  return key ? LANGS[key] : null;
}

const WORD = /[A-Za-z_$][\w$-]*/y;
const NUMBER = /0[xX][\da-fA-F]+|\d+(?:\.\d+)?/y;
const SPACE = /\s+/y;
const CONSTANTS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "nil", "NaN"]);

function match(re, text, i) {
  re.lastIndex = i;
  const m = re.exec(text);
  return m ? m[0] : null;
}

// state: null | { close } carried across lines when a block comment is open.
// Returns { tokens: [{kind, text}], open }.
export function tokenize(text, lang, state) {
  const tokens = [];
  const push = (kind, s) => {
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += s;
    else tokens.push({ kind, text: s });
  };
  let i = 0;
  let open = state ?? null;
  while (i < text.length) {
    if (open) {
      const end = text.indexOf(open.close, i);
      if (end < 0) { push("comment", text.slice(i)); i = text.length; break; }
      push("comment", text.slice(i, end + open.close.length));
      i = end + open.close.length;
      open = null;
      continue;
    }
    const rest = text.slice(i);
    const line = lang.line.find((s) => rest.startsWith(s));
    if (line) { push("comment", rest); break; }
    const block = lang.block.find(([s]) => rest.startsWith(s));
    if (block) { open = { close: block[1] }; push("comment", block[0]); i += block[0].length; continue; }
    const ch = text[i];
    if (lang.quotes.includes(ch)) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      push("string", text.slice(i, Math.min(j + 1, text.length)));
      i = j + 1;
      continue;
    }
    const space = match(SPACE, text, i);
    if (space) { push("", space); i += space.length; continue; }
    const num = match(NUMBER, text, i);
    if (num) { push("number", num); i += num.length; continue; }
    const word = match(WORD, text, i);
    if (word) {
      if (lang.words.has(lang.fold ? word.toLowerCase() : word)) push("keyword", word);
      else if (CONSTANTS.has(word)) push("constant", word);
      else if (/^\s*\(/.test(text.slice(i + word.length, i + word.length + 8))) push("function", word);
      else if (/^[A-Z]/.test(word)) push("type", word);
      else push("", word);
      i += word.length;
      continue;
    }
    push("", ch);
    i++;
  }
  return { tokens, open };
}

// Attaches `tokens` to diff rows ({kind, text}). Old and new sides keep separate block-comment state;
// each hunk resets it. Never throws: on error rows stay plain.
export function colorRows(rows, path) {
  const lang = languageOf(path);
  if (!lang || rows.length > 5000) return rows;
  let old = null, next = null;
  try {
    for (const row of rows) {
      if (row.kind === "@") { old = null; next = null; continue; }
      if (row.kind !== "+" && row.kind !== "-" && row.kind !== " ") continue;
      if (row.text.length > 400) continue;
      const side = row.kind === "-" ? old : next;
      const r = tokenize(row.text, lang, side);
      row.tokens = r.tokens;
      if (row.kind === "-") old = r.open;
      else if (row.kind === "+") next = r.open;
      else { old = r.open; next = r.open; }
    }
  } catch {
    for (const row of rows) delete row.tokens;
  }
  return rows;
}
