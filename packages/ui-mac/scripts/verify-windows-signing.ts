#!/usr/bin/env bun
// verify-windows-signing(#175)—— alpha-windows-build.yml 的 Authenticode 硬门。
//
//   bun scripts/verify-windows-signing.ts --channel <dev|beta|prod> --facts <windows-signing-facts.json>
//
// facts JSON 由同 workflow 的 pwsh 步骤从最终 .exe 采集(Get-AuthenticodeSignature + Get-FileHash)。
// 裁决 = src/main/release-manifest.ts#evaluateWindowsSigning(出厂策略):
// beta/prod 上未签名 / status 非 Valid / publisher 不在白名单(今天白名单为空 = 全拒)⇒ exit 1。
// dev 只要求事实完整如实,不要求签名 —— dev 包不发布。

import fs from "node:fs"
import { parseArgs } from "node:util"

import {
  APPLE_TEAM_ID,
  WINDOWS_PUBLISHER_ALLOWLIST,
  evaluateWindowsSigning,
  validateWindowsFactsDoc,
  type ReleaseChannel,
} from "../src/main/release-manifest"

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { channel: { type: "string" }, facts: { type: "string" } },
})

const channel = values.channel as ReleaseChannel
if (channel !== "dev" && channel !== "beta" && channel !== "prod") {
  console.error("[verify-windows-signing] --channel must be dev | beta | prod")
  process.exit(1)
}
if (!values.facts || !fs.existsSync(values.facts)) {
  console.error(`[verify-windows-signing] facts file not found: ${String(values.facts)}`)
  process.exit(1)
}

const parsed = validateWindowsFactsDoc(JSON.parse(fs.readFileSync(values.facts, "utf8")))
if (!parsed.ok) {
  console.error(`[verify-windows-signing] ${parsed.error}`)
  process.exit(1)
}

const verdict = evaluateWindowsSigning(parsed.doc, channel, {
  appleTeamId: APPLE_TEAM_ID,
  windowsPublisherAllowlist: WINDOWS_PUBLISHER_ALLOWLIST,
})

if (!verdict.ok) {
  console.error(`[verify-windows-signing] RED — unsigned/unverified Windows build must not ship on ${channel}:`)
  for (const e of verdict.errors) console.error(`  - ${e}`)
  process.exit(1)
}

for (const a of parsed.doc.artifacts)
  console.log(
    `[verify-windows-signing] ${a.filename}: signed=${a.signed} status=${a.status} publisher=${a.publisher ?? "-"}`,
  )
console.log(`[verify-windows-signing] OK for channel=${channel}`)
