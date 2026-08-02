// REQ-128 Phase 3 `[T3-channel]`(#782):预算取值的**关系**与「两次读之间源目录变了」这条臂。
//
// 两段式通道的行为闸在 `local-package-channel.test.ts`(生产 handler)。本文件只钉两件
// 那里到不了的事:
//   ① 预算数字与它上下两个已有界限的**关系**(散文写在注释里不算判据);
//   ② 签发期两次读之间源目录被改动 —— 生产 handler 里这两次读发生在同一次 IPC 调用内部,
//      测试挂不进去,而这条臂真到得了(编辑器自动保存、git checkout 都在同一毫秒级窗口里)。

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import { previewLocalClaudePlugin, LOCAL_PACKAGE_MAX_COMPONENTS } from "./claude-plugin-intake"
import { IMPORT_MAX_ENTRIES, IMPORT_MAX_TOTAL } from "./ext-fs-installer"
import {
  collectRetainedPayloads,
  LOCAL_PACKAGE_PREVIEW_MAX_BYTES,
  LOCAL_PACKAGE_PREVIEW_MAX_FILES,
} from "./local-package-preview"

describe("包级预算的取值关系(G19)", () => {
  test("下界:必须 ≥ 单技能帽 —— 低于它就是拿闸门制造回归", () => {
    expect(LOCAL_PACKAGE_PREVIEW_MAX_BYTES).toBeGreaterThanOrEqual(IMPORT_MAX_TOTAL)
    expect(LOCAL_PACKAGE_PREVIEW_MAX_FILES).toBeGreaterThanOrEqual(IMPORT_MAX_ENTRIES)
  })

  test("上界:必须**远低于**结构性最坏值(64 × 单技能帽),否则这道帽不减少任何风险", () => {
    const worstBytes = LOCAL_PACKAGE_MAX_COMPONENTS * IMPORT_MAX_TOTAL // = 640MB
    const worstFiles = LOCAL_PACKAGE_MAX_COMPONENTS * IMPORT_MAX_ENTRIES // = 32000
    expect(LOCAL_PACKAGE_PREVIEW_MAX_BYTES).toBeLessThan(worstBytes / 4)
    expect(LOCAL_PACKAGE_PREVIEW_MAX_FILES).toBeLessThan(worstFiles / 4)
  })

  test("既有 agent 形状的条数帽**不是**这道帽:256KB / 16 条都套不到包字节上", () => {
    // 基线 G19 绕过配方③:照抄 `ext-ipc` agent 导入的 `>16` 与 256KB ⇒ 超预算夹具通过。
    expect(LOCAL_PACKAGE_PREVIEW_MAX_BYTES).not.toBe(256 * 1024)
    expect(LOCAL_PACKAGE_PREVIEW_MAX_FILES).not.toBe(16)
  })
})

test("签发期两次读之间源目录被改动 ⇒ 整次拒绝,不静默取后一次", () => {
  const root = mkdtempSync(join(tmpdir(), "local-package-source-changed-"))
  try {
    const pluginRoot = join(root, "plugin")
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true })
    writeFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "drift", description: "d" }), "utf8")
    const skillDir = join(pluginRoot, "skills", "one")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: one\ndescription: fixture\n---\n\nbefore\n", "utf8")

    const real = realpathSync(pluginRoot)
    const preview = previewLocalClaudePlugin(real)
    expect(preview.installableCount).toBe(1)
    // 未改动 ⇒ 收得上来,且摘要与预览判过的逐字相同。
    const clean = collectRetainedPayloads(real, preview)
    expect(clean.ok).toBe(true)

    // 改动一个字节(用户确认的是 A、装进去的会是 B)⇒ 具名拒绝。
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: one\ndescription: fixture\n---\n\nAFTER\n", "utf8")
    const drifted = collectRetainedPayloads(real, preview)
    expect(drifted.ok).toBe(false)
    if (drifted.ok) throw new Error("unreachable")
    expect(drifted.reasonCode).toBe("preview-source-changed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
