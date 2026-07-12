// 轻量确定性代码着色 — REQ-095 code renderer(#187)。纯逻辑、零依赖(alpha 不 ship shiki:
// 上游冻结包里的高亮不可复用,ADR-020;引入完整高亮器超出本切片预算)。
// 输出 token 流由渲染端映射为 <span> 文本节点 —— 无 HTML 字符串,无执行面。
// 覆盖:行注释/块注释、字符串(' " `)、数字、常用关键字;不认识的语言退化为 plain(诚实,不乱标)。

export type CodeTokenKind = "plain" | "keyword" | "string" | "comment" | "number"
export type CodeToken = { kind: CodeTokenKind; text: string }

const KEYWORDS: Record<string, readonly string[]> = {
  js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "extends", "new", "import", "export", "from", "default", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "switch", "case", "break", "continue", "null", "undefined", "true", "false", "this", "yield", "delete", "void", "static", "get", "set"],
  ts: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "extends", "new", "import", "export", "from", "default", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "switch", "case", "break", "continue", "null", "undefined", "true", "false", "this", "yield", "type", "interface", "enum", "namespace", "readonly", "keyof", "as", "satisfies", "implements", "declare", "abstract", "public", "private", "protected", "static"],
  py: ["def", "return", "if", "elif", "else", "for", "while", "class", "import", "from", "as", "try", "except", "finally", "raise", "with", "lambda", "pass", "break", "continue", "and", "or", "not", "in", "is", "None", "True", "False", "global", "nonlocal", "yield", "async", "await", "assert", "del"],
  sh: ["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac", "function", "return", "local", "export", "echo", "exit", "set", "readonly"],
  sql: ["select", "from", "where", "insert", "into", "values", "update", "delete", "create", "table", "index", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit", "offset", "as", "and", "or", "not", "null", "primary", "key", "foreign", "references", "distinct", "union", "all"],
  css: ["import", "media", "supports", "keyframes", "font-face", "root", "hover", "focus", "active", "important"],
  go: ["func", "return", "if", "else", "for", "range", "switch", "case", "break", "continue", "type", "struct", "interface", "map", "chan", "go", "defer", "package", "import", "var", "const", "nil", "true", "false", "select", "default", "fallthrough", "goto"],
  rs: ["fn", "let", "mut", "return", "if", "else", "for", "while", "loop", "match", "struct", "enum", "impl", "trait", "pub", "use", "mod", "crate", "self", "Self", "true", "false", "None", "Some", "Ok", "Err", "async", "await", "move", "ref", "where", "dyn", "Box", "const", "static", "unsafe"],
}

const LANG_ALIASES: Record<string, keyof typeof KEYWORDS> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", javascript: "js",
  ts: "ts", tsx: "ts", typescript: "ts",
  py: "py", python: "py",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh",
  sql: "sql",
  css: "css", scss: "css", less: "css",
  go: "go", golang: "go",
  rs: "rs", rust: "rs",
  json: "js", // 关键字集合无害重叠(true/false/null)
}

type LangSpec = {
  keywords: Set<string>
  lineComment: string[] // 行注释前缀
  blockComment: [string, string] | null
  hashComment: boolean
}

function specFor(lang: string | null): LangSpec | null {
  if (!lang) return null
  const key = LANG_ALIASES[lang.trim().toLowerCase()]
  if (!key) return null
  const kw = new Set(KEYWORDS[key].map((k) => k))
  if (key === "py" || key === "sh") return { keywords: kw, lineComment: [], blockComment: null, hashComment: true }
  if (key === "sql") return { keywords: kw, lineComment: ["--"], blockComment: ["/*", "*/"], hashComment: false }
  if (key === "css") return { keywords: kw, lineComment: [], blockComment: ["/*", "*/"], hashComment: false }
  return { keywords: kw, lineComment: ["//"], blockComment: ["/*", "*/"], hashComment: false }
}

const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$-]*/y
const NUM_RE = /\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/y

/** 单遍高亮整段文本 → 每行 token 流(块注释/多行字符串跨行携带状态;整体确定性)。 */
export function highlightCode(text: string, lang: string | null): CodeToken[][] {
  const spec = specFor(lang)
  const lines = text.split("\n")
  if (!spec) return lines.map((line) => (line.length > 0 ? [{ kind: "plain" as const, text: line }] : []))

  const out: CodeToken[][] = []
  let inBlockComment = false
  for (const line of lines) {
    const tokens: CodeToken[] = []
    let i = 0
    let plainStart = 0
    const flushPlain = (end: number) => {
      if (end > plainStart) tokens.push({ kind: "plain", text: line.slice(plainStart, end) })
    }
    while (i < line.length) {
      if (inBlockComment) {
        const close = spec.blockComment ? line.indexOf(spec.blockComment[1], i) : -1
        if (close < 0) {
          tokens.push({ kind: "comment", text: line.slice(i) })
          i = line.length
          plainStart = i
          break
        }
        tokens.push({ kind: "comment", text: line.slice(i, close + spec.blockComment![1].length) })
        i = close + spec.blockComment![1].length
        plainStart = i
        inBlockComment = false
        continue
      }
      const ch = line[i]
      // 行注释
      const lineC = spec.lineComment.find((p) => line.startsWith(p, i))
      if (lineC || (spec.hashComment && ch === "#")) {
        flushPlain(i)
        tokens.push({ kind: "comment", text: line.slice(i) })
        i = line.length
        plainStart = i
        break
      }
      // 块注释开
      if (spec.blockComment && line.startsWith(spec.blockComment[0], i)) {
        flushPlain(i)
        inBlockComment = true
        continue
      }
      // 字符串(不跨行 —— 跨行字符串按 plain 降级,诚实简化)
      if (ch === '"' || ch === "'" || ch === "`") {
        flushPlain(i)
        let j = i + 1
        while (j < line.length) {
          if (line[j] === "\\") j += 2
          else if (line[j] === ch) {
            j += 1
            break
          } else j += 1
        }
        tokens.push({ kind: "string", text: line.slice(i, Math.min(j, line.length)) })
        i = Math.min(j, line.length)
        plainStart = i
        continue
      }
      // 数字
      if (ch >= "0" && ch <= "9") {
        NUM_RE.lastIndex = i
        const m = NUM_RE.exec(line)
        if (m && m.index === i) {
          flushPlain(i)
          tokens.push({ kind: "number", text: m[0] })
          i += m[0].length
          plainStart = i
          continue
        }
      }
      // 词(关键字判定;SQL 不区分大小写)
      WORD_RE.lastIndex = i
      const w = WORD_RE.exec(line)
      if (w && w.index === i) {
        const word = w[0]
        const hit = spec.keywords.has(word) || (spec.hashComment === false && spec.keywords.has(word.toLowerCase()))
        if (hit) {
          flushPlain(i)
          tokens.push({ kind: "keyword", text: word })
          i += word.length
          plainStart = i
          continue
        }
        i += word.length
        continue
      }
      i += 1
    }
    flushPlain(Math.min(i, line.length))
    out.push(tokens)
  }
  return out
}
