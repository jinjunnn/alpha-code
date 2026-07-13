#!/usr/bin/env bun
// S17 T3(C17):构建期从 core 迁移目录派生 app 支持面清单 → resources/db-expected-migrations.json
// (extraResources 进包;运行时 db-safety.loadExpectedIds 读取。)
// 为什么构建期生成而非运行时 import:ARCHITECTURE 硬约束② 禁止运行时 import @opencode-ai/core 内部模块;
// 文件名 ≡ migration.gen.ts 的 import 清单 ≡ 迁移 id。
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const migrationDir = join(here, "../../core/src/database/migration")
const ids = readdirSync(migrationDir)
  .filter((f) => /^\d{14}_.+\.ts$/.test(f))
  .map((f) => f.replace(/\.ts$/, ""))
  .sort()

if (ids.length === 0) throw new Error(`gen-db-expected: no migrations found at ${migrationDir}`)

const outDir = join(here, "../resources")
mkdirSync(outDir, { recursive: true })
const out = join(outDir, "db-expected-migrations.json")
writeFileSync(out, `${JSON.stringify({ v: 1, ids }, null, 2)}\n`)
console.log(`gen-db-expected: ${ids.length} ids → resources/db-expected-migrations.json (latest ${ids[ids.length - 1]})`)
