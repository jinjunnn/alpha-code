#!/usr/bin/env bun
/**
 * REQ-128 Phase 3 `[T1-intake]`(#780):把本机真实 Claude 插件语料**导出成仓内夹具**。
 *
 * 为什么要有这一步:AC 要求「对本机真实语料全量跑并断言具体数字」,同时要求
 * **夹具复制进仓、不依赖本机路径** —— 否则那道闸只在写它的人的机器上是真的。
 *
 * 导出规则(每一条都为了让判定面**逐字保真**,同时不把第三方内容整个搬进仓):
 *   · `SKILL.md` 与 `.claude-plugin/plugin.json` —— **逐字保留**。它们是解析器与引用扫描
 *     真正读的输入;换成手写复刻就是「替别人写文法」,判定面立刻变成自证。
 *   · 其余文件 —— **占位**,只保留 `size` 与 `mode`。判定只用到它们的**存在性、名字、
 *     可执行位与体积**(引用 resolve / exec 位 / 10MB 帽),用不到内容。
 *   · `.git` / `node_modules` / `__pycache__` —— 不导出(collector 与独立扫描都跳过;
 *     真实语料里这三者在技能目录内 0 命中,R2-a 的夹具是合成的)。
 *
 * 为什么落成**一个 JSON**而不是把文件直接摊进仓:
 *   语料里有 5 个 `.png`/`.jpg` 带**字面 NUL 字节**。JSON 的 `\u0000` 转义写法在文件字节上
 *   不含 NUL —— 正是 `scripts/assert-no-nul-bytes.py` 指定的修法。摊开写会让那道闸变红,
 *   或者(更坏)诱使有人去给闸加豁免。
 *
 * 用法:bun packages/ui-mac/scripts/gen-claude-plugin-corpus-fixture.ts [语料根]
 *       默认语料根 = ~/.claude/plugins/marketplaces
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const VERBATIM = new Set(["SKILL.md", "plugin.json"])
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"])

type Entry = { path: string; mode: number } & ({ text: string } | { size: number })

function main(): void {
  const corpusRoot = process.argv[2] ?? path.join(os.homedir(), ".claude", "plugins", "marketplaces")
  if (!fs.existsSync(corpusRoot)) {
    console.error(`语料根不存在:${corpusRoot}`)
    process.exit(1)
  }
  // `.bak` 是一个**真实存在的普通目录**,对我们来说就是个可被用户选中的文件夹。
  // 判据语料按基线 §3.1 排除它 —— 但夹具不许依赖「排除 .bak」这个前提去做任何判定。
  const roots = fs.readdirSync(corpusRoot).filter((n) => !n.endsWith(".bak")).sort()
  const entries: Entry[] = []

  const walk = (absDir: string, relDir: string): void => {
    const dirents = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue // 真实语料 symlink 全域 0 例;symlink 那一臂只能靠合成夹具
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name
      const abs = path.join(absDir, dirent.name)
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue
        walk(abs, rel)
        continue
      }
      if (!dirent.isFile()) continue
      const st = fs.lstatSync(abs)
      const mode = st.mode & 0o777
      if (VERBATIM.has(dirent.name)) entries.push({ path: rel, mode, text: fs.readFileSync(abs, "utf8") })
      else entries.push({ path: rel, mode, size: st.size })
    }
  }
  for (const root of roots) walk(path.join(corpusRoot, root), root)

  const out = {
    schema: "claude-plugin-corpus-fixture/v1",
    source: "~/.claude/plugins/marketplaces (excluding *.bak)",
    note:
      "SKILL.md 与 plugin.json 逐字保留;其余文件只留 size/mode 占位(判定只用到存在性/名字/可执行位/体积)。" +
      "由 packages/ui-mac/scripts/gen-claude-plugin-corpus-fixture.ts 生成,不要手改。",
    roots,
    entries,
  }
  const dest = path.join(import.meta.dir, "..", "test-fixtures", "claude-plugin-corpus.json")
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(out))
  const verbatim = entries.filter((e) => "text" in e).length
  console.log(`✓ ${entries.length} 条(逐字 ${verbatim} / 占位 ${entries.length - verbatim})→ ${dest}`)
  console.log(`  ${(fs.statSync(dest).size / 1024 / 1024).toFixed(2)} MB`)
}

main()
