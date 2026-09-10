#!/usr/bin/env bun
// `#1300` —— 墙钟上界断言登记簿的 CLI:`--check`(默认)比对,`--write` 重生签名(保留已填的处置与理由,
// 新行处置 TODO),`--list` 只打印扫描结果(带 file:line 与命中轴)。
// 判据本体与扫描器在 src/main/wall-clock-assertions.ts;这里只做 I/O。
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  diffLedger,
  gateRegisteredFiles,
  parseLedger,
  renderLedgerRows,
  scanRepository,
  signatureOf,
  type LedgerContext,
} from "../src/main/wall-clock-assertions"

const repoRoot = resolve(import.meta.dir, "../../..")
export const LEDGER_PATH = resolve(repoRoot, "scripts", "wall-clock-assertions.tsv")
const GATE_FILES_PATH = resolve(repoRoot, "scripts", "gate-files.tsv")

const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--list") ? "list" : "check"
const hits = scanRepository(repoRoot)

if (mode === "list") {
  for (const h of hits) console.log(`${h.file}:${h.line}\t[${h.axes.join("+")}]\t${h.test}\t${h.assertion}`)
  console.log(`— ${hits.length} 处命中`)
  process.exit(0)
}

const previousText = existsSync(LEDGER_PATH) ? readFileSync(LEDGER_PATH, "utf8") : ""
const previous = previousText ? parseLedger(previousText) : []
const ctx: LedgerContext = {
  gateRegistered: gateRegisteredFiles(readFileSync(GATE_FILES_PATH, "utf8")),
  read: (file) => (existsSync(join(repoRoot, file)) ? readFileSync(join(repoRoot, file), "utf8") : undefined),
}

if (mode === "write") {
  const header = previousText
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .join("\n")
  writeFileSync(LEDGER_PATH, `${header}\n${renderLedgerRows(hits, previous)}\n`)
  const todo = parseLedger(readFileSync(LEDGER_PATH, "utf8")).filter((r) => r.disposition === "TODO")
  console.log(`✓ wrote ${LEDGER_PATH}(${hits.length} 处命中)${todo.length ? ` —— ${todo.length} 行处置为 TODO,评审必须填成真处置:\n  ${todo.map(signatureOf).join("\n  ")}` : ""}`)
  process.exit(todo.length ? 1 : 0)
}

const diff = diffLedger(hits, previous, ctx)
const bad = diff.unregistered.length + diff.stale.length + diff.invalid.length + diff.duplicates.length
if (!bad) {
  console.log(`✓ wall-clock assertions: ${previous.length} 条登记与扫描一致(${hits.length} 处命中)`)
  process.exit(0)
}
if (diff.unregistered.length)
  console.log(`✗ 未登记的墙钟上界断言(默认动作是改写成不依赖机器闲忙的判据;实在要留,登记并写明处置):\n  ${diff.unregistered.map((h) => `${h.file}:${h.line}  [${h.axes.join("+")}]  ${h.assertion}`).join("\n  ")}`)
if (diff.stale.length) console.log(`✗ 登记簿里有、代码里没有的行(删掉登记):\n  ${diff.stale.map(signatureOf).join("\n  ")}`)
if (diff.invalid.length) console.log(`✗ 处置不合法:\n  ${diff.invalid.map(({ row, error }) => `${signatureOf(row)}\n    → ${error}`).join("\n  ")}`)
if (diff.duplicates.length) console.log(`✗ 登记簿重复行:\n  ${diff.duplicates.join("\n  ")}`)
process.exit(1)
