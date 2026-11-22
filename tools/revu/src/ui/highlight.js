const KEYWORDS = {
  ts: new Set([
    "import", "from", "export", "default", "const", "let", "var", "function",
    "async", "await", "return", "if", "else", "for", "while", "switch", "case",
    "break", "continue", "try", "catch", "finally", "throw", "new", "class",
    "extends", "implements", "interface", "type", "enum", "true", "false",
    "null", "undefined", "typeof", "instanceof", "in", "of", "as",
  ]),
  py: new Set([
    "import", "from", "as", "def", "async", "await", "return", "if", "elif",
    "else", "for", "while", "break", "continue", "try", "except", "finally",
    "raise", "with", "class", "pass", "yield", "lambda", "True", "False",
    "None", "and", "or", "not", "in", "is",
  ]),
  sh: new Set([
    "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case",
    "esac", "in", "function", "return", "exit", "export", "local", "set",
    "unset", "true", "false", "echo", "printf",
  ]),
  go: new Set([
    "package", "import", "func", "return", "var", "const", "type", "struct",
    "interface", "if", "else", "for", "range", "switch", "case", "default",
    "break", "continue", "go", "defer", "select", "chan", "map", "true",
    "false", "nil",
  ]),
};

export function langFromPath(path) {
  const ext = String(path || "").split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "ts";
  if (["py", "pyi"].includes(ext)) return "py";
  if (["json", "jsonc"].includes(ext)) return "json";
  if (["sh", "bash", "zsh"].includes(ext)) return "sh";
  if (ext === "go") return "go";
  return "";
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TOKEN_RE =
  /(\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/gm;

export function highlightLine(line, lang) {
  if (!line) return "";
  if (!lang) return escapeHtml(line);

  const kw = KEYWORDS[lang];
  const isHashComment = lang === "py" || lang === "sh";
  const isSlashComment = lang === "ts" || lang === "go";

  let out = "";
  let last = 0;
  TOKEN_RE.lastIndex = 0;

  let m;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    if (m.index > last) {
      out += escapeHtml(line.slice(last, m.index));
    }
    const tok = m[0];
    if ((isSlashComment && tok.startsWith("//")) || (isHashComment && tok.startsWith("#"))) {
      out += `<span class="hl-cmt">${escapeHtml(tok)}</span>`;
    } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith("`")) {
      const isJsonKey = lang === "json" && line.slice(m.index + tok.length).trimStart().startsWith(":");
      out += `<span class="${isJsonKey ? "hl-key" : "hl-str"}">${escapeHtml(tok)}</span>`;
    } else if (/^\d/.test(tok)) {
      out += `<span class="hl-num">${escapeHtml(tok)}</span>`;
    } else if (lang === "json" && (tok === "true" || tok === "false" || tok === "null")) {
      out += `<span class="hl-kw">${escapeHtml(tok)}</span>`;
    } else if (kw && kw.has(tok)) {
      out += `<span class="hl-kw">${escapeHtml(tok)}</span>`;
    } else {
      out += escapeHtml(tok);
    }
    last = m.index + tok.length;
  }

  if (last < line.length) {
    out += escapeHtml(line.slice(last));
  }
  return out;
}

export function highlightBlock(code, lang) {
  return String(code ?? "")
    .split("\n")
    .map((line) => highlightLine(line, lang))
    .join("\n");
}
