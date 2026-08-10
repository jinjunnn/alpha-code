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

// #857: Default's in-process app and Server.listen normally build different route layers
// and memo maps. Pin only the fixed Electron listener to the singleton pair so its
// authenticated location prewarm reaches the exact socket listener production graph.
await $`bun ./scripts/patch-sidecar-shared-routes.ts`

// #857: publish the complete governed models.dev base before the remaining internal
// plugins finish their outer State.batch. This patches only the generated embedded
// server output and fails closed if upstream's compiled shape drifts.
await $`bun ./scripts/patch-plugin-internal-models.ts`
