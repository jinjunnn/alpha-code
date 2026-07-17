// REQ-103 AC4(#195,slice 2a)—— 扩展硬边界钉测:逐条取证 + 把**现状结构性保证**钉进测试,
// 防未来无声回归。取证档:docs/audits/2026-07-13-s50-req103-slice2a-governance-ipc-ac3-ac4.md。
//
//  ① 第三方不可注册顶级路由 —— 路由组合真源 = 上游冻结 app/src/app.tsx 路由树(ADR-020 冻结面)
//     + shared/legacy-route-abi.ts(版本化 ABI,唯一消费口)。结构性免疫:路由静态组合于打包产物,
//     扩展内容(skill/agent/mcp/plugin/cloud)零 renderer 代码通道;renderer 无动态路由注册 API。
//     钉:parseRoute 的封闭路由宇宙 + renderer 源无路由注册面。
//  ② 扩展不可读其它命名空间设置 —— ext-config 写面只触 `mcp[<name>]` 单叶(SAFE_NAME 先验);
//     renderer/扩展可达的读面(configHealth)只回健康摘要,零配置内容。钉:跨叶字节不变 + 敌意名
//     先验拒绝 + configHealth 不泄值。
//  ③ 扩展拿不到主 renderer preload bridge、不可注入 renderer JS —— preload 静态打包、只 import
//     electron/类型;主窗 contextIsolation+sandbox+nodeIntegration:false;隔离预览 host 刻意零
//     preload;安装管线(ext-config/ext-fs-installer)零窗口/preload 触点;CSP script-src 'self'
//     (renderer-security.test 已钉)。钉:上述装载路径的源级锚点。
//  ④ Electron <webview> 全仓禁用 —— Electron ≥5 默认禁,主窗与预览 host 显式 webviewTag:false。
//     钉:每个 BrowserWindow 创建点都显式 false;全仓无 true、无 <webview> 标签。

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { parseRoute } from "../shared/legacy-route-abi"

const mainDir = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(mainDir, "..")
const read = (rel: string): string => fs.readFileSync(path.join(srcDir, rel), "utf8")

function walkSources(dir: string, exts = [".ts", ".tsx"]): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkSources(abs, exts))
    else if (exts.some((x) => e.name.endsWith(x))) out.push(abs)
  }
  return out
}

// ── ① 顶级路由封闭宇宙 ─────────────────────────────────────────────────────────────────────────

describe("AC4① 第三方不可注册顶级路由(真源:上游冻结路由树 + legacy-route-abi)", () => {
  test("路由宇宙封闭:任意顶级段只会被解释为目录 slug / 非法目录 / unknown,永远不是新路由", () => {
    // 唯一的字面量顶级路由是 new-session;其余单段一律进目录 slug 解释(base64url 目录编码),
    // 一个「扩展想注册的路由名」没有任何通道成为顶级路由。
    for (const hostile of ["governance", "plugins", "extension-panel", "__ext", "admin", "settings2"]) {
      const route = parseRoute(`/${hostile}`)
      expect(["directory", "invalidDirectory"]).toContain(route.kind)
    }
    // 多段:第二段非 "session" 一律 unknown —— 不存在 /<ext>/<page> 命名空间。
    expect(parseRoute("/anything/panel").kind).toBe("unknown")
    expect(parseRoute("/anything/session/id/extra").kind).toBe("unknown")
    expect(parseRoute("/new-session/nested").kind).toBe("unknown")
    // 既有宇宙不变(锚点):
    expect(parseRoute("/").kind).toBe("home")
    expect(parseRoute("/new-session?draftId=d").kind).toBe("newSession")
  })

  test("renderer 源无动态路由注册面(扩展内容零 renderer 代码通道)", () => {
    const rendererFiles = walkSources(path.join(srcDir, "renderer"))
    const offenders: string[] = []
    for (const f of rendererFiles) {
      const text = fs.readFileSync(f, "utf8")
      if (/\baddRoute\b|\bregisterRoute\b|routes\.push|createBrowserRouter/.test(text)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})

// ── ② 设置命名空间隔离(运行时钉测,ext-config 真写盘) ────────────────────────────────────────

describe("AC4② 扩展不可读/不可触其它命名空间设置(ext-config 单叶纪律)", () => {
  test("persistMcp/removeMcp 只触 mcp[<name>] 单叶:其它叶与外部顶键逐字节保留;敌意名先验拒绝;configHealth 零内容泄漏", async () => {
    const os = await import("node:os")
    const { persistMcp, removeMcp, configHealth } = await import("./ext-config")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-gov-boundaries-"))
    const prev = {
      cfg: process.env.OPENCODE_CONFIG_DIR,
      home: process.env.ALPHA_OPENCODE_HOME,
      alpha: process.env.ALPHA_GLOBAL_DIR,
    }
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, "xdg")
    process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "home")
    process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha")
    try {
      // 预置「其它命名空间」:另一个 mcp 叶 + 一个携密顶键(合法 V1 键之外的内容不需要 —— 这里
      // 用 mcp.other 的 environment 值当「邻居的秘密」)。
      expect(persistMcp("other", { type: "local", command: ["npx", "other-mcp"], environment: { OTHER_SECRET: "s3cr3t-neighbor" } }).ok).toBe(true)
      const cfgPath = path.join(tmp, "alpha", "alpha.jsonc")
      const otherLeafBefore = (JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { mcp: Record<string, unknown> }).mcp.other

      // 安装/卸载另一个名字,邻居叶逐字节(结构)不变。
      expect(persistMcp("mine", { type: "local", command: ["npx", "my-mcp"] }).ok).toBe(true)
      expect(removeMcp("mine").ok).toBe(true)
      const after = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { mcp: Record<string, unknown> }
      expect(after.mcp.other).toEqual(otherLeafBefore)
      expect(after.mcp.mine).toBeUndefined()

      // 敌意名(遍历/原型链)在任何磁盘 I/O 之前拒绝 —— 名字不是路径通道。
      for (const evil of ["__proto__", "../escape", "a/b", "mcp[other]", ""]) {
        expect(persistMcp(evil, { type: "local", command: ["npx", "x"] }).ok).toBe(false)
      }

      // renderer/扩展可达的唯一「读设置」面 configHealth:只回健康摘要,绝不携带配置内容/邻居值。
      const health = configHealth()
      expect(JSON.stringify(health)).not.toContain("s3cr3t-neighbor")
      expect(Object.keys(health).every((k) => ["broken", "reason", "path"].includes(k))).toBe(true)
    } finally {
      if (prev.cfg === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = prev.cfg
      if (prev.home === undefined) delete process.env.ALPHA_OPENCODE_HOME
      else process.env.ALPHA_OPENCODE_HOME = prev.home
      if (prev.alpha === undefined) delete process.env.ALPHA_GLOBAL_DIR
      else process.env.ALPHA_GLOBAL_DIR = prev.alpha
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ── ③ preload bridge 装载路径(源级锚点) ──────────────────────────────────────────────────────

describe("AC4③ 扩展拿不到 preload bridge / 不可注入 renderer JS(装载路径钉)", () => {
  test("preload 只 import electron 与类型;单一 exposeInMainWorld;governance 面只透传 projectDir", () => {
    const preload = read("preload/index.ts")
    const specifiers = [...preload.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!)
    expect(specifiers.every((s) => s === "electron" || s === "./types" || s === "@opencode-ai/app/updater")).toBe(true)
    expect(preload.match(/exposeInMainWorld/g)).toHaveLength(1)
    expect(preload).toContain('contextBridge.exposeInMainWorld("api", api)')
    // 本切片新通道的只读面:一条 invoke、零 send、零写通道姊妹(源级)。
    expect(preload.match(/"ext-inventory-view"/g)).toHaveLength(1)
    expect(preload).toContain('inventoryView: (projectDir) => ipcRenderer.invoke("ext-inventory-view", projectDir)')
  })

  test("主窗硬化:contextIsolation+sandbox+nodeIntegration:false,preload 为静态打包产物单点", () => {
    const windows = read("main/windows.ts")
    expect(windows).toContain("contextIsolation: true")
    expect(windows).toContain("nodeIntegration: false")
    expect(windows).toContain("sandbox: true")
    expect(windows.match(/preload: join\(root, "\.\.\/preload\/index\.js"\)/g)).toHaveLength(1)
    expect(windows.match(/preload\s*:/g)).toHaveLength(1) // 唯一 preload 配置点
  })

  test("隔离预览 host 零 preload;安装管线(ext-config/ext-fs-installer)零窗口/preload 触点", () => {
    const host = read("main/html-preview-host.ts")
    expect(host).not.toMatch(/preload\s*:/) // REQ-096 AC#3/#7:预览上下文零 Alpha bridge
    for (const rel of ["main/ext-config.ts", "main/ext-fs-installer.ts"]) {
      const text = read(rel)
      expect(text).not.toMatch(/preload\s*:/) // 类型 import "../preload/types" 合法;配置 preload 无通道
      expect(text).not.toContain("BrowserWindow")
      expect(text).not.toContain("webContents")
    }
  })

  test("governance 只读通道在 main 侧单点注册(ext-ipc),无写通道同名姊妹", () => {
    const extIpc = read("main/ext-ipc.ts")
    expect(extIpc.match(/"ext-inventory-view"/g)).toHaveLength(1)
    expect(extIpc).toContain('ipcMain.handle("ext-inventory-view"')
    // 全 main 源里该通道字符串只出现在 ext-ipc 这一处(不存在第二个注册/广播点)。
    const mainFiles = walkSources(path.join(srcDir, "main"), [".ts"]).filter((f) => !f.endsWith(".test.ts"))
    const hits = mainFiles.filter((f) => fs.readFileSync(f, "utf8").includes("ext-inventory-view"))
    expect(hits.map((f) => path.basename(f))).toEqual(["ext-ipc.ts"])
  })
})

// ── ④ <webview> 全仓禁用 ───────────────────────────────────────────────────────────────────────

describe("AC4④ Electron <webview> 全仓禁用", () => {
  test("每个 BrowserWindow 创建点显式 webviewTag:false;全仓零 webviewTag:true、零 <webview> 标签", () => {
    const files = walkSources(srcDir).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
    const creators: string[] = []
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8")
      expect(text).not.toMatch(/webviewTag\s*:\s*true/)
      expect(text).not.toContain("<webview")
      if (/new (electronRef\.)?BrowserWindow\(/.test(text)) {
        creators.push(path.basename(f))
        expect(text).toMatch(/webviewTag\s*:\s*false/)
      }
    }
    // 锚点:当前仅两处窗口创建点(新增创建点必须带 webviewTag:false 并更新此清单)。
    expect(creators.sort()).toEqual(["html-preview-host.ts", "windows.ts"])
  })
})
