#!/usr/bin/env bun
// REQ-159 (`#1321`) · AC3 —— 写盘调用点登记簿的 CLI:`--check`(默认)比对,`--write` 重生签名(保留已填的根,新行 TODO)。
// 判据本体与扫描器在 src/main/process-fence-write-sites.ts;这里只做 I/O。
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { diffLedger, parseLedger, renderLedger, scanRepository, signatureOf } from "../src/main/process-fence-write-sites"

const repoRoot = resolve(import.meta.dir, "../../..")
export const LEDGER_PATH = resolve(repoRoot, "scripts", "process-fence-write-sites.tsv")

const write = process.argv.includes("--write")
const sites = scanRepository(repoRoot)
const previous = existsSync(LEDGER_PATH) ? parseLedger(readFileSync(LEDGER_PATH, "utf8")) : []

if (write) {
  writeFileSync(LEDGER_PATH, renderLedger(sites, previous))
  const todo = parseLedger(readFileSync(LEDGER_PATH, "utf8")).filter((r) => r.root === "TODO")
  console.log(`✓ wrote ${LEDGER_PATH}(${sites.length} 个调用点)${todo.length ? ` —— ${todo.length} 行根为 TODO,评审必须填成真根:\n  ${todo.map(signatureOf).join("\n  ")}` : ""}`)
  process.exit(todo.length ? 1 : 0)
}

const diff = diffLedger(sites, previous)
const bad = diff.unregistered.length + diff.stale.length + diff.invalidRoot.length + diff.duplicates.length
if (!bad) {
  console.log(`✓ process fence write sites: ${previous.length} 条登记与扫描一致(${sites.length} 个调用点)`)
  process.exit(0)
}
if (diff.unregistered.length) console.log(`✗ 未登记的写盘调用点(登记并点名它落在可写集的哪一行):\n  ${diff.unregistered.map((s) => `${signatureOf(s)}  (line ${s.line})`).join("\n  ")}`)
if (diff.stale.length) console.log(`✗ 登记簿里有、源码里没有的行(删掉登记):\n  ${diff.stale.map(signatureOf).join("\n  ")}`)
if (diff.invalidRoot.length) console.log(`✗ 根列不合法(只认 W-id / W-id+W-id / arg):\n  ${diff.invalidRoot.map((r) => `${signatureOf(r)}\t${r.root}`).join("\n  ")}`)
if (diff.duplicates.length) console.log(`✗ 登记簿重复行:\n  ${diff.duplicates.join("\n  ")}`)
process.exit(1)
