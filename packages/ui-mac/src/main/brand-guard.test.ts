// [ac#1160] REQ-139 品牌守卫 —— 两半,判据都是**有限坐标清单**(不用「不再出现旧名」这种无界判据):
//
// ① AC5 身份面冻结:五组身份字面量与改名前逐字相同。display rename 不许碰它们 ——
//    APP_IDS 决定 userData 目录(动 = 存量数据"消失");setName 值(含 packaged 取的 APP_NAMES)
//    决定钥匙串项名 "alpha-code Safe Storage"(动 = 存量登录 + BYOK 密钥永久解不开);
//    bundle id 动 = TCC/公证身份重置;更新 feed 动 = 存量客户端断更新;
//    URL scheme + CLIENT_ID 是 OAuth wire 标识(动 = 登录回调断,且须 alpha-web 同刀)。
// ② AC1/AC3 展示面坐标:逐点断言显示 "Code Puppy" / "CODE PUPPY",漏一格红一格。
//
// 变异自证(2026-08-29,见 PR):把 index.ts 的 APP_IDS.prod 改一个字符 → 本文件当场红;还原后绿。
//
// [ac#1186] `alpha.brand.short` 补进 ②:改名那轮漏了它,工作区弹层的默认工作区因此仍显示「Alpha」。
// 取 `Code Puppy`(与 product 同口径 —— `code-puppy`/`codepuppy` 在本仓只做域名与标识符,不做展示名)。

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO = join(import.meta.dir, "../../../..") // packages/ui-mac/src/main → repo root
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8")

describe("AC5 身份面冻结 — 五组字面量逐字未变", () => {
  test("运行时 APP_IDS(userData 目录)+ APP_NAMES/setName(钥匙串项名)", () => {
    const src = read("packages/ui-mac/src/main/index.ts")
    expect(src).toContain(
      'const APP_NAMES: Record<string, string> = {\n  dev: "alpha-code",\n  beta: "alpha-code Beta",\n  prod: "alpha-code",\n}',
    )
    expect(src).toContain(
      'const APP_IDS: Record<string, string> = {\n  dev: "ai.opencode.desktop.dev",\n  beta: "ai.opencode.desktop.beta",\n  prod: "ai.opencode.desktop",\n}',
    )
    expect(src).toContain('app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "alpha-code")')
  })
  test("bundle id 三值(electron-builder APP_IDS)", () => {
    const src = read("packages/ui-mac/electron-builder.config.ts")
    expect(src).toContain('dev: "com.tide.alphacode.dev",')
    expect(src).toContain('beta: "com.tide.alphacode.beta",')
    expect(src).toContain('prod: "com.tide.alphacode",')
  })
  test("更新 feed owner/repo/channel 映射", () => {
    const src = read("packages/ui-mac/src/main/alpha-environment.ts")
    expect(src).toContain('export const UPDATE_FEED_OWNER = "jinjunnn"')
    expect(src).toContain('export const UPDATE_FEED_REPO = "alpha-code"')
    expect(src).toContain('if (env === "prod") return "latest"')
    expect(src).toContain('if (env === "beta") return "beta"')
  })
  test("URL schemes(opencode 深链 + alpha-code auth)", () => {
    const src = read("packages/ui-mac/src/shared/route-manifest.ts")
    expect(src).toContain('{ id: "application", value: "opencode" }')
    expect(src).toContain('{ id: "auth", value: "alpha-code" }')
  })
  test("OAuth CLIENT_ID(wire 标识,非展示名)", () => {
    expect(read("packages/ui-mac/src/main/alpha-auth.ts")).toContain('const CLIENT_ID = "alpha-code"')
  })
})

describe("AC1 展示面坐标 — ui-mac 自有面显示 Code Puppy", () => {
  test("productName 三处(Info.plist 面:菜单栏 / Finder / 窗口)", () => {
    const src = read("packages/ui-mac/electron-builder.config.ts")
    expect(src.split('productName: "Code Puppy",').length - 1).toBe(2) // dev + prod
    expect(src).toContain('productName: "Code Puppy Beta",')
  })
  test("i18n 品牌键 en(product / short / wordmark)", () => {
    const src = read("packages/ui-mac/src/renderer/i18n/en.ts")
    expect(src).toContain('"alpha.brand.product": "Code Puppy",')
    expect(src).toContain('"alpha.brand.short": "Code Puppy",')
    expect(src).toContain('"alpha.brand.wordmark": "CODE PUPPY",')
  })
  test("i18n 品牌键 zh(product / short / wordmark)", () => {
    const src = read("packages/ui-mac/src/renderer/i18n/zh.ts")
    expect(src).toContain('"alpha.brand.product": "Code Puppy",')
    expect(src).toContain('"alpha.brand.short": "Code Puppy",')
    expect(src).toContain('"alpha.brand.wordmark": "CODE PUPPY",')
  })
  test("i18n en 其余品牌文案五处", () => {
    const src = read("packages/ui-mac/src/renderer/i18n/en.ts")
    expect(src).toContain("You are already using the latest version of Code Puppy")
    expect(src).toContain("Version {{version}} of Code Puppy has been downloaded")
    expect(src).toContain('"alpha.auto.loginItem": "Launch Code Puppy at login",')
    expect(src).toContain('"alpha.onboarding.title": "Welcome to Code Puppy",')
    expect(src).toContain("created by a newer Code Puppy version")
  })
  test("i18n zh 其余品牌文案五处", () => {
    const src = read("packages/ui-mac/src/renderer/i18n/zh.ts")
    expect(src).toContain("你已经在使用最新版本的 Code Puppy")
    expect(src).toContain("已下载 Code Puppy {{version}} 版本")
    expect(src).toContain('"alpha.auto.loginItem": "登录时启动 Code Puppy",')
    expect(src).toContain('"alpha.onboarding.title": "欢迎来到 Code Puppy",')
    expect(src).toContain("此数据由更新版本的 Code Puppy 创建")
  })
  test("i18n zht updater 两处([ac#1198] REQ-139 残留:zht 漏网,与 zh/en 同句同型)", () => {
    const src = read("packages/ui-mac/src/renderer/i18n/zht.ts")
    expect(src).toContain('"desktop.updater.none.message": "你已在使用最新版的 Code Puppy",')
    expect(src).toContain('"desktop.updater.downloaded.prompt": "已下載 Code Puppy {{version}} 版本，是否安裝並重新啟動？",')
  })
  test("主窗标题(index.html + windows.ts)", () => {
    expect(read("packages/ui-mac/src/renderer/index.html")).toContain("<title>Code Puppy</title>")
    expect(read("packages/ui-mac/src/main/windows.ts")).toContain('title: "Code Puppy",')
  })
  test("Recovery 窗标题(recovery.html + windows.ts)", () => {
    expect(read("packages/ui-mac/src/renderer/recovery.html")).toContain("<title>Code Puppy · Recovery</title>")
    expect(read("packages/ui-mac/src/main/windows.ts")).toContain('title: "Code Puppy · Recovery",')
  })
  test("About 面板(setAboutPanelOptions)", () => {
    const src = read("packages/ui-mac/src/main/index.ts")
    expect(src).toContain('applicationName: "Code Puppy",')
    expect(src).toContain('copyright: "© 2025 opencode (MIT). Code Puppy fork build.",')
  })
  test("Windows 帮助菜单 + About 对话框", () => {
    const src = read("packages/ui-mac/src/main/menu.ts")
    expect(src.split("关于 Code Puppy").length - 1).toBe(2)
    expect(src).toContain("message: `Code Puppy ${app.getVersion()}`,")
  })
  test("OAuth 浏览器落地页(core/src/oauth/page.ts,已收编)", () => {
    const src = read("packages/core/src/oauth/page.ts")
    expect(src).toContain('const PRODUCT = "Code Puppy"')
    expect(src).toContain(">Code Puppy</span>") // WORDMARK
    expect(src).toContain("Code Puppy is now connected to ")
    expect(src).toContain("Code Puppy couldn't finish connecting to ")
  })
  test("钥匙串清理指引仍指向真实项名 alpha-code(身份未改,文案改了反而失实)", () => {
    expect(read("packages/ui-mac/src/main/data-clear-boot.ts")).toContain("搜索 alpha-code 手动删除")
  })
})

describe("AC2 上游 renderer 转写 — brand-i18n to 侧为 Code Puppy(覆盖面保持 en/zh/zht 不扩)", () => {
  test("en/zh/zht 各锚一对(from 侧上游原文不动)", () => {
    const src = read("packages/ui-mac/scripts/brand-i18n.ts")
    expect(src).toContain('["OpenCode Desktop", "Code Puppy"],')
    expect(src).toContain('["OpenCode 有新版本 ({{version}}) 可安装。", "Code Puppy 有新版本 ({{version}}) 可安装。"],')
    expect(src).toContain('["請將此錯誤回報給 OpenCode 團隊", "請將此錯誤回報給 Code Puppy 團隊"],')
  })
})

describe("AC3 提示词与技能文案 — 模型上下文里的品牌串", () => {
  test("身份注入(alpha-identity.ts)", () => {
    const src = read("packages/ui-mac/src/main/alpha-identity.ts")
    expect(src).toContain('"# Code Puppy",')
    expect(src).toContain("You are running inside **Code Puppy**, a macOS coding agent.")
    expect(src).toContain('refer to yourself as "Code Puppy"')
  })
  test("行为指引 + 自动化执行器 prompt", () => {
    expect(read("packages/ui-mac/src/main/alpha-behavior.ts")).toContain("# Code Puppy response guidance")
    const inj = read("packages/ui-mac/src/main/alpha-config-injection.ts")
    expect(inj.split("你是 Code Puppy 的自动化任务执行器").length - 1).toBe(2)
  })
  test("子代理提示词(ext/alpha-prompts.ts 四处)", () => {
    const src = read("packages/ext/src/alpha-prompts.ts")
    expect(src).toContain("coding-agent sessions in Code Puppy avoid mistakes")
    expect(src).toContain("(Code Puppy's per-project extensions:")
    expect(src).toContain("You are a general-purpose task agent inside Code Puppy.")
    expect(src).toContain("You are Code Puppy's codebase exploration agent")
  })
  test("拒答模板两处", () => {
    expect(read("packages/ui-mac/src/main/alpha-builtin-policy.ts")).toContain("定制 Code Puppy 请改用 /customize-alpha")
    expect(read("packages/ext/src/factory-deny.ts")).toContain("定制 Code Puppy 请改用 /customize-alpha")
  })
  test("出厂技能六份 + upstream-sync 文案", () => {
    for (const f of [
      "packages/ui-mac/resources/factory-skills/agent-creator/SKILL.md",
      "packages/ui-mac/resources/factory-skills/alpha-workspace/SKILL.md",
      "packages/ui-mac/resources/factory-skills/cloud-dispatch/SKILL.md",
      "packages/ui-mac/resources/factory-skills/integrate-project/SKILL.md",
      "packages/ui-mac/resources/factory-skills/customize-alpha/SKILL.md",
      "packages/ui-mac/resources/factory-skills/office-docs/SKILL.md",
      "packages/ui-mac/resources/skills/alpha-upstream-sync/SKILL.md",
    ]) {
      expect(read(f).includes("Code Puppy")).toBe(true)
    }
    expect(read("packages/ui-mac/resources/factory-skills/customize-alpha/SKILL.md")).toContain("# Customize Code Puppy")
    // repo 名是身份不是展示:sync 指令仍指向 jinjunnn/alpha-code
    expect(read("packages/ui-mac/resources/skills/alpha-upstream-sync/SKILL.md")).toContain("gh repo sync jinjunnn/alpha-code")
  })
  test("prompt-rebrand to 侧(REBRAND_TO + 自指首句)", () => {
    const src = read("packages/ext/src/prompt-rebrand.ts")
    expect(src).toContain('export const REBRAND_TO = "Code Puppy"')
    expect(src.split('to: "You are Code Puppy,').length - 1).toBe(6)
    expect(src).toContain('to: "Your name is Code Puppy",')
  })
})
