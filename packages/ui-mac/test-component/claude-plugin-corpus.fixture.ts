// REQ-128 Phase 3 `[T1-intake]`(#780):把仓内语料夹具**摊成一棵真的目录树**。
//
// 为什么必须摊成真目录而不是喂一个内存对象:被测的是 `collectImportSkillPayload`
// (realpath 圈禁 / O_NOFOLLOW / fstat 帽)与**独立 lstat 扫描**——两者读的都是文件系统。
// 喂内存对象等于把生产代码换成一条自己拼的等价链,那正是本仓「假闸形态⑧」。
//
// 占位文件按记录的 `size` 与 `mode` 还原:判定用到的是**存在性 / 名字 / 可执行位 / 体积**。
// 会被解析的 SKILL.md / plugin.json / .mcp.json / plugin-level agents/**/*.md 与再分发依据
// marketplace 根 LICENSE* 全部逐字保留;`#848` 的 agent 解析闸读的就是这里摊开的真字节。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

type CorpusEntry = { path: string; mode: number } & ({ text: string } | { size: number })
type CorpusFixture = { schema: string; source: string; note: string; roots: string[]; entries: CorpusEntry[] }

const FIXTURE_PATH = path.join(import.meta.dir, "..", "test-fixtures", "claude-plugin-corpus.json")

export function loadCorpusFixture(): CorpusFixture {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as CorpusFixture
}

/** 摊开语料到一个临时目录,返回根路径与清理句柄。调用方 finally 必须 cleanup()。 */
export function materializeCorpus(): { root: string; roots: string[]; cleanup: () => void } {
  const fixture = loadCorpusFixture()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-claude-corpus-"))
  for (const entry of fixture.entries) {
    const abs = path.join(root, entry.path)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if ("text" in entry) fs.writeFileSync(abs, entry.text, "utf8")
    else fs.writeFileSync(abs, Buffer.alloc(entry.size, 0x61)) // 0x61 = 'a';只有体积是判据
    fs.chmodSync(abs, entry.mode)
  }
  return { root, roots: fixture.roots, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** 语料里全部 `<...>/.claude-plugin/plugin.json` 所在目录(= 62 个插件根),排序返回。 */
export function pluginRootsIn(corpusRoot: string): string[] {
  const out: string[] = []
  const walk = (abs: string, depth: number): void => {
    if (depth > 8) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    if (fs.existsSync(path.join(abs, ".claude-plugin", "plugin.json"))) out.push(abs)
    for (const e of entries) if (e.isDirectory()) walk(path.join(abs, e.name), depth + 1)
  }
  walk(corpusRoot, 0)
  return out.sort()
}

/** 语料里全部 SKILL.md 的绝对路径(任意深度),排序返回。 */
export function skillMdFilesIn(corpusRoot: string): string[] {
  const out: string[] = []
  const walk = (abs: string, depth: number): void => {
    if (depth > 10) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(abs, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && e.name === "SKILL.md") out.push(p)
    }
  }
  walk(corpusRoot, 0)
  return out.sort()
}

/** 整棵树的指纹:路径 + mode + 大小 + 内容 sha256 + **mtime + inode**。
 *
 *  为什么必须带 mtime 与 inode(这是绕过实验挖出来的洞,不是洁癖):
 *  只比内容的指纹**看不见幂等重写** —— 往 `installs.json` 反复写同一串 `{}`,内容哈希逐次相同,
 *  「磁盘逐字节不变」照样成立,而生产其实每次都在写盘。实测:C2 绕过实验里这条闸没变红,
 *  变红的是别的用例(靠账本被覆盖间接暴露)—— 那就是这道闸自己的盲区。
 *  inode 另外管住「写临时文件 + rename」这种内容相同但确实换过文件的写法。 */
export function treeFingerprint(root: string): string {
  const crypto = require("node:crypto") as typeof import("node:crypto")
  const lines: string[] = []
  const walk = (abs: string, rel: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childAbs = path.join(abs, e.name)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const st = fs.lstatSync(childAbs)
      if (e.isSymbolicLink()) {
        lines.push(`L ${childRel} ${fs.readlinkSync(childAbs)}`)
        continue
      }
      const stamp = `${(st.mode & 0o777).toString(8)} ${st.mtimeMs} ${st.ino}`
      if (e.isDirectory()) {
        lines.push(`D ${childRel} ${stamp}`)
        walk(childAbs, childRel)
        continue
      }
      lines.push(`F ${childRel} ${stamp} ${st.size} ${crypto.createHash("sha256").update(fs.readFileSync(childAbs)).digest("hex")}`)
    }
  }
  walk(root, "")
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex")
}
