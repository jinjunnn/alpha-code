#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

// S17 T3(C17):派生 DB 迁移支持面清单 → resources/db-expected-migrations.json(extraResources 进包;
// db-safety 预检据此判定「DB 超前 / 将前进迁移」。构建期生成 = 不运行时 import core,守 ARCHITECTURE 硬约束②)
await $`bun ./scripts/gen-db-expected.ts`

// Bundle @alpha-code/ext to self-contained ESM so the embedded Node server can load it
// without resolving raw TS at runtime (see .claude/rules/DECISIONS.md ADR-006).
await $`cd ../ext && bun run build`

await $`cd ../opencode && bun script/build-node.ts`

// A4: patch the freshly-built embedded server so InstallationVersion isn't "local"
// (else @opencode-ai/plugin@local install fails for any .opencode-plugin project). See the script.
await $`bun ./scripts/patch-server-version.ts`
