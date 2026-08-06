#!/usr/bin/env bun
/**
 * REQ-128 Phase 3 `[T1-intake]`(#780):把本机真实 Claude 插件语料**导出成仓内夹具**。
 *
 * 为什么要有这一步:AC 要求「对本机真实语料全量跑并断言具体数字」,同时要求
 * **夹具复制进仓、不依赖本机路径** —— 否则那道闸只在写它的人的机器上是真的。
 *
 * 导出规则(每一条都为了让判定面**逐字保真**,同时不把第三方内容整个搬进仓):
 *   · `SKILL.md`、`.claude-plugin/plugin.json` 与 `.mcp.json` —— **逐字保留**。它们是解析器、
 *     引用扫描与**规模测量**真正读的输入;换成手写复刻就是「替别人写文法」,判定面立刻变成自证。
 *   · 其余文件 —— **占位**,只保留 `size` 与 `mode`。判定只用到它们的**存在性、名字、
 *     可执行位与体积**(引用 resolve / exec 位 / 10MB 帽),用不到内容。
 *
 * `#826`:`.mcp.json` 原先落在**占位**那一档,于是这份语料在结构上**表示不了**「一份
 * `.mcp.json` 声明了几个 server」—— 而 ADR-040 下每个 server 是 Bundle 里的一个独立组件。
 * 拿这份语料算出来的组件规模因此只能是下界,再拿那个下界去定信封上限,定出来的界本身就是错的。
 * 这是本仓记录在案的「观测手段自己有盲区」,只是这次盲区在**语料生成器**里。
 * 实读收获(只有留下字节才看得见):22 份 `.mcp.json` = 9 份带 `mcpServers` 包裹层
 * + **12 份没有包裹层**(server 直接摆在顶层)+ **1 份根本不是合法 JSON**;
 * 9 份带包裹层的里还有 2 份是空的 `{"mcpServers":{}}`。合计声明 19 个 server。
 *   · `.git` / `node_modules` / `__pycache__` —— 不导出(collector 与独立扫描都跳过;
 *     真实语料里这三者在技能目录内 0 命中,R2-a 的夹具是合成的)。
 *
 * `#848`:**plugin-level `agents/**\/*.md` 与 marketplace 根级 `LICENSE*` 也逐字保留**。
 * agent 那一格与 `#826` 的 `.mcp.json` 同病:43 份 plugin-level agent 全在占位档,于是
 * 「agent profile 接得住 Claude 的 agent」没有字节可对 —— 而方案审计实测 34/43 被生产
 * `agentMdToEntry` 拒(admission 期即拒装)。逐字段冻结表(基线 §3.5)只能对着真字节写。
 * 口径与规模普查一致(census G3):只算 `<插件根>/agents/**`,插件根 = 带
 * `.claude-plugin/plugin.json` 的目录;技能内层的 agents(如 skill-creator 里那 3 份)
 * 不在口径内,维持占位。根级 `LICENSE*` 让夹具自带第三方内容的再分发授权依据
 * (owner 2026-08-04 拍板;根下不存在就不猜,插件级/技能级 LICENSE 不在此列)。
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

const VERBATIM = new Set(["SKILL.md", "plugin.json", ".mcp.json"])
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

  // `#848`:plugin-level agent 判定。rel 里某个 `agents` 段的**前缀目录**带
  // `.claude-plugin/plugin.json` 即命中(覆盖 tide-plugin 这种「marketplace 根本身就是
  // 插件根」的形态,也覆盖 `agents/` 下任意深度嵌套)。技能内层 agents 的前缀是
  // `skills/<name>`,没有插件清单,自然落回占位档 —— 不靠点名排除。
  const isPluginLevelAgentMd = (rel: string): boolean => {
    if (!rel.endsWith(".md")) return false
    const seg = rel.split("/")
    for (let i = 1; i < seg.length - 1; i++) {
      if (seg[i] !== "agents") continue
      if (fs.existsSync(path.join(corpusRoot, ...seg.slice(0, i), ".claude-plugin", "plugin.json"))) return true
    }
    return false
  }
  // `#848`:marketplace 根一级的 `LICENSE*`(rel 恰两段)。只看根一级 —— owner 拍板的
  // 再分发依据挂在 marketplace 根上;插件级/技能级 LICENSE 维持占位。
  const isMarketplaceRootLicense = (rel: string): boolean => {
    const seg = rel.split("/")
    return seg.length === 2 && seg[1].startsWith("LICENSE")
  }

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
      if (VERBATIM.has(dirent.name) || isPluginLevelAgentMd(rel) || isMarketplaceRootLicense(rel)) {
        // 「逐字保留」必须是**真的**,不是名义上的:`readFileSync(..., "utf8")` 对非法 UTF-8
        // 会静默塞 U+FFFD,于是夹具里躺着一份**看起来像原文**的赝品。往返比一次字节,
        // 不等就当场停 —— 让这份语料悄悄失真,正是本文件要修的那类缺陷。
        const raw = fs.readFileSync(abs)
        const text = raw.toString("utf8")
        if (!Buffer.from(text, "utf8").equals(raw)) {
          console.error(`逐字保留失真(非 UTF-8 字节):${rel}`)
          process.exit(1)
        }
        entries.push({ path: rel, mode, text })
      } else entries.push({ path: rel, mode, size: st.size })
    }
  }
  for (const root of roots) walk(path.join(corpusRoot, root), root)

  const out = {
    schema: "claude-plugin-corpus-fixture/v1",
    source: "~/.claude/plugins/marketplaces (excluding *.bak)",
    note:
      "SKILL.md、plugin.json、.mcp.json、plugin-level agents/**/*.md 与 marketplace 根级 LICENSE* 逐字保留(#848);" +
      "其余文件只留 size/mode 占位(判定只用到存在性/名字/可执行位/体积)。" +
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
