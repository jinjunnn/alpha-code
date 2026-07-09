// platform seam 单测(REQ-076 T2a):两平台行为在 mac 上皆可验证(纯函数注入 platform)。
// S35 gate 2 锚:darwin 分支的每个值 = 平台化收编前散落在消费方的既有 mac 行为,逐字锁定。

import { describe, expect, test } from "bun:test"
import { commandHeadBase, cspPlatformEligible, editorCliName, menuPlatform, posixModesEffective, safeStorageBackend, sqliteBinary, toolProbe } from "./index"

describe("toolProbe", () => {
  test("darwin:which + PATH 补 Homebrew/本地 bin(原 ext-ipc.PROBE_PATH 逐字等价)", () => {
    const p = toolProbe({ platform: "darwin", env: { PATH: "/usr/sbin" }, home: "/Users/u" })
    expect(p.cmd).toBe("which")
    expect(p.probePath).toBe("/usr/sbin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/Users/u/.local/bin")
  })
  test("darwin:PATH 缺省时首段为空串(原实现 ?? \"\" 语义保留)", () => {
    const p = toolProbe({ platform: "darwin", env: {}, home: "/Users/u" })
    expect(p.probePath.startsWith(":")).toBe(true)
  })
  test("win32:where + PATH 原样(; 分隔,不补目录)", () => {
    const p = toolProbe({ platform: "win32", env: { PATH: "C:\\Windows\\System32;C:\\nodejs" } })
    expect(p.cmd).toBe("where")
    expect(p.probePath).toBe("C:\\Windows\\System32;C:\\nodejs")
  })
})

describe("commandHeadBase", () => {
  test("darwin:行为一字不变(不剥后缀)", () => {
    expect(commandHeadBase("npx", "darwin")).toBe("npx")
    expect(commandHeadBase("/opt/homebrew/bin/uvx", "darwin")).toBe("uvx")
    expect(commandHeadBase("npx.cmd", "darwin")).toBe("npx.cmd")
  })
  test("win32:反斜杠 basename + 剥 .exe/.cmd/.bat(大小写不敏感)", () => {
    expect(commandHeadBase("npx.cmd", "win32")).toBe("npx")
    expect(commandHeadBase("C:\\Program Files\\nodejs\\node.exe", "win32")).toBe("node")
    expect(commandHeadBase("uvx.BAT", "win32")).toBe("uvx")
    expect(commandHeadBase("deno", "win32")).toBe("deno")
  })
  test("win32:仅剥一层可执行后缀,不误伤点分名", () => {
    expect(commandHeadBase("my.tool.exe", "win32")).toBe("my.tool")
  })
})

describe("sqliteBinary", () => {
  test("posix 固定 /usr/bin/sqlite3(原 db-safety.SQLITE3);win32 诚实 null", () => {
    expect(sqliteBinary("darwin")).toBe("/usr/bin/sqlite3")
    expect(sqliteBinary("linux")).toBe("/usr/bin/sqlite3")
    expect(sqliteBinary("win32")).toBeNull()
  })
})

describe("editorCliName", () => {
  test("已映射编辑器给 CLI 名;无 Windows 对应物给 null(回退 shell.openPath)", () => {
    expect(editorCliName("Visual Studio Code")).toBe("code")
    expect(editorCliName("Sublime Text")).toBe("subl")
    expect(editorCliName("TextEdit")).toBeNull()
    expect(editorCliName("Finder")).toBeNull()
    expect(editorCliName("Xcode")).toBeNull()
  })
})

describe("cspPlatformEligible / posixModesEffective / menuPlatform", () => {
  test("CSP:darwin 原状 + win32 纳入;linux 维持不注入", () => {
    expect(cspPlatformEligible("darwin")).toBe(true)
    expect(cspPlatformEligible("win32")).toBe(true)
    expect(cspPlatformEligible("linux")).toBe(false)
  })
  test("POSIX 权限位:win32 无效(loud 依据),其余有效", () => {
    expect(posixModesEffective("darwin")).toBe(true)
    expect(posixModesEffective("win32")).toBe(false)
  })
  test("菜单平台映射:darwin→macos,win32→windows,linux→null(不建)", () => {
    expect(menuPlatform("darwin")).toBe("macos")
    expect(menuPlatform("win32")).toBe("windows")
    expect(menuPlatform("linux")).toBeNull()
  })
  test("safeStorage 后端:darwin=keychain,win32=dpapi(数据清除文案分支依据)", () => {
    expect(safeStorageBackend("darwin")).toBe("keychain")
    expect(safeStorageBackend("win32")).toBe("dpapi")
    expect(safeStorageBackend("linux")).toBe("other")
  })
})
