#!/usr/bin/env bun
// #1496:把 arm64 与 x64 两轮打包各自留下的 feed 合成一份 dist/latest-mac.yml(两种架构都列出)。
//
// 用法(在 packages/ui-mac 下,两轮 package:mac 之后;每轮结束先把 dist/latest-mac.yml 改名留底):
//   bun scripts/merge-latest-mac-yml.ts [--dist dist]
// 读 <dist>/latest-mac-arm64.yml + <dist>/latest-mac-x64.yml,写 <dist>/latest-mac.yml。
// 完整步骤见 docs/runbooks/distribution.md §2。
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

import { mergeMacFeeds, parse, serialize } from "./latest-yml"

const { values } = parseArgs({ options: { dist: { type: "string", default: "dist" } } })
const dist = path.resolve(values.dist!)
const read = (arch: string) => {
  const p = path.join(dist, `latest-mac-${arch}.yml`)
  if (!fs.existsSync(p)) {
    console.error(`[merge-latest-mac-yml] 缺 ${p}(该架构那一轮 package:mac 之后要先 cp dist/latest-mac.yml 到这里)`)
    process.exit(1)
  }
  return parse(fs.readFileSync(p, "utf8"))
}

const merged = mergeMacFeeds(read("arm64"), read("x64"))
const out = path.join(dist, "latest-mac.yml")
fs.writeFileSync(out, serialize(merged))
console.log(`[merge-latest-mac-yml] OK: ${out}(${merged.files.map((f) => f.url).join(", ")})`)
