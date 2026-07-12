// REQ-092 AC#7(A 侧)代码扫描门 —— 防止向 cloud artifact 契约面重新引入内联内容字段。
// 规则(镜像平台 test/artifact-guard.test.ts 的纪律):
//   · preload 契约面(types.ts / index.ts)零豁免:内联内容词元(编码内联/data URL)一律不得出现,
//     包括注释 —— renderer 面前的 IPC 形状里不允许这个概念存在;
//   · main 传输面 + 契约镜像:词元行必须携带 "REQ-092" 标注(compat 窗口 / Digest 头解码的审计痕迹),
//     标注允许落在本行或紧邻上一行(契约镜像是平台文件的逐字拷贝,其注释块标注在块首);
//     无标注即失败 —— 新增裸词元 = 门禁挡下。
// 词元按 AC#7 范围:base64 / b64 / dataUrl / data_url(此测试文件自身不在扫描集内)。

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const SRC = path.resolve(import.meta.dir, "..")

// 词元:大小写不敏感,词边界(标识符/字段名命中;"DATA_URL_RE" 之类复合标识符不误伤)。
const TOKEN_RE = new RegExp(String.raw`\b(base64|b64|data_?url)\b`, "i")

/** preload 契约面:零豁免(含注释)。 */
const ZERO_TOLERANCE = ["preload/types.ts", "preload/index.ts"]

/** main 传输面 + 契约镜像:词元行必须带 REQ-092 标注。 */
const ANNOTATED = [
  "main/alpha-cloud-jobs.ts",
  "main/cloud-ipc.ts",
  "main/alpha-workdir.ts",
  "main/alpha-artifact-download.ts",
  "shared/cloud-artifact-descriptor.ts",
]

function offendingLines(rel: string, requireAnnotation: boolean): string[] {
  const lines = fs.readFileSync(path.join(SRC, rel), "utf8").split("\n")
  const bad: string[] = []
  lines.forEach((line, i) => {
    if (!TOKEN_RE.test(line)) return
    if (requireAnnotation && (line.includes("REQ-092") || (i > 0 && lines[i - 1].includes("REQ-092")))) return
    bad.push(`${rel}:${i + 1}: ${line.trim()}`)
  })
  return bad
}

describe("REQ-092 AC#7 guard: no inline-content fields on the cloud artifact surface", () => {
  test("preload surface is token-free (zero exemptions, comments included)", () => {
    const bad = ZERO_TOLERANCE.flatMap((f) => offendingLines(f, false))
    expect(bad).toEqual([])
  })

  test("main transport surface: any token line carries a REQ-092 annotation", () => {
    const bad = ANNOTATED.flatMap((f) => offendingLines(f, true))
    expect(bad).toEqual([])
  })

  test("scanned files actually exist (guard cannot rot silently)", () => {
    for (const f of [...ZERO_TOLERANCE, ...ANNOTATED]) {
      expect(fs.existsSync(path.join(SRC, f))).toBe(true)
    }
  })
})
