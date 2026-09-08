#!/usr/bin/env bun
// REQ-157 `#1284` AC3:把 alpha 注入模型上下文的库存打出来,并与仓内快照逐字节比对。
//
//   bun packages/ext/scripts/context-injection-inventory.ts --check   # alpha-check 第 [12/12] 步;不一致 exit 1
//   bun packages/ext/scripts/context-injection-inventory.ts --write   # 改了片段之后重生快照,让评审读 diff
//
// 两种「红」:① 登记簿在 import 时就抛(某条片段超过声明上限,ContextBudgetError,见 src/context-injection.ts)
// —— 本脚本连库存都打不出来,退出码非零,消息里有 id / 实测 / 上限;② 库存与快照不一致(有人改了
// 片段、加了片段、改了上限,却没重生快照)。两种都不是「跑过了都绿」能盖住的。
// 快照测试(src/context-injection.test.ts「AC3」)在 CI 的 `bun test (ext)` 里比对同一份文件。
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { renderInventory } from "../src/context-injection"

const here = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT = join(here, "..", "src", "context-injection-inventory.snapshot.txt")
const shown = relative(process.cwd(), SNAPSHOT)

const mode = process.argv[2] ?? "--check"
if (mode !== "--check" && mode !== "--write") {
  console.error("usage: bun packages/ext/scripts/context-injection-inventory.ts [--check|--write]")
  process.exit(2)
}

const rendered = renderInventory()
process.stdout.write(rendered)

if (mode === "--write") {
  writeFileSync(SNAPSHOT, rendered)
  console.log(`✓ wrote ${shown}`)
  process.exit(0)
}

if (!existsSync(SNAPSHOT)) {
  console.error(`✗ snapshot missing: ${shown} — run with --write and commit it`)
  process.exit(1)
}
const expected = readFileSync(SNAPSHOT, "utf8")
if (expected === rendered) {
  console.log(`✓ inventory matches ${shown}`)
  process.exit(0)
}
const a = expected.split("\n")
const b = rendered.split("\n")
console.error(`✗ inventory differs from ${shown} — an Alpha fragment / limit changed without regenerating the snapshot:`)
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] === b[i]) continue
  if (a[i] !== undefined) console.error(`  - ${a[i]}`)
  if (b[i] !== undefined) console.error(`  + ${b[i]}`)
}
console.error("  run: bun packages/ext/scripts/context-injection-inventory.ts --write   (then let review read the snapshot diff)")
process.exit(1)
