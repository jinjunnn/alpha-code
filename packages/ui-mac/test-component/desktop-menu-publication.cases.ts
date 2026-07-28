// REQ-126 AC7(#658)桌面菜单发布面闸门。
//
// 保证(删掉本文件会失去什么):原生应用菜单里**又出现一个点了没反应的项**这件事将不再有任何东西
// 能发现。菜单项由 `main/menu.ts` 逐条发布,点一下经 `sendMenuCommand` 送到渲染进程
// `command.trigger(id)`,而上游 `run()` 对未注册 id **静默返回** —— 于是 REQ-085/086/125 顶替掉
// 上游三片叶之后,一串菜单项(终端/文件树/上下一个会话/上下一个项目…)按下去什么都不发生,也不报错。
//
// 判据不看源码文本,看**真建出来的原生菜单**:mock 掉 electron 跑真 `createMenu`,拿到真模板,
// 逐条**点**命令项,记录它究竟发出了哪些 id。于是:
//   · 退休项:模板里根本没有它,点不出来;
//   · 保留项:点得出来,且 id 与发布面一致 —— 这些 id 由渲染侧闸门(shell-commands.test.ts)
//     进一步要求「在真实壳里确实注册且触发有可观察结果」。
// 上游日后新增菜单命令会默认落进发布面,直接被那道闸门抓住,而不是悄悄多出一个死入口。

import { afterEach, describe, expect, mock, test } from "bun:test"
import { DESKTOP_MENU, desktopMenuVisible, type DesktopMenuPlatform } from "@opencode-ai/app/desktop-menu"
import { RETIRED_MENU_COMMANDS, alphaDesktopMenu, publishedMenuCommands } from "../src/shared/desktop-menu-policy"

type NativeItem = {
  label?: string
  role?: string
  type?: string
  submenu?: NativeItem[]
  click?: () => void
}

let built: NativeItem[] = []

mock.module("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getAppPath: () => "/tmp", getPath: () => "/tmp" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  Menu: {
    buildFromTemplate: (template: NativeItem[]) => {
      built = template
      return { popup: () => {} }
    },
    setApplicationMenu: () => {},
  },
  shell: { openExternal: () => {}, openPath: () => {} },
}))
// `action` 项(重载/缩放/新窗口…)不在本闸门射程内,而真模块会把整棵窗口/日志子系统拖进来;
// 只有 `command` 项是本票的命题,所以把这条边掐掉。本文件从不点 action 项。
mock.module("../src/main/desktop-menu-actions", () => ({ runDesktopMenuAction: () => {} }))

const { createMenu } = await import("../src/main/menu")

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!
afterEach(() => Object.defineProperty(process, "platform", platformDescriptor))

/** 真跑 createMenu:回传真原生模板 + 一个「点某一条,取回这一次发出的 id」的探针。 */
function buildFor(platform: DesktopMenuPlatform) {
  Object.defineProperty(process, "platform", { configurable: true, value: platform === "macos" ? "darwin" : "win32" })
  built = []
  const emitted: string[] = []
  createMenu({ trigger: (id) => emitted.push(id), checkForUpdates: () => {}, relaunch: () => {} })
  const template = built
  const clickAndCollect = (item: NativeItem) => {
    const from = emitted.length
    item.click!()
    return emitted.slice(from)
  }
  return { template, clickAndCollect }
}

/** 模型侧命令项(所属菜单 + label + command),用来在原生模板里按 label 找到同一条并真的点它。 */
function modelCommands(platform: DesktopMenuPlatform) {
  const out: { menu: string; label: string; command: string }[] = []
  for (const menu of alphaDesktopMenu(platform)) {
    for (const entry of menu.items ?? []) {
      if (entry.type === "item" && entry.command)
        out.push({ menu: menu.label, label: entry.label ?? "", command: entry.command })
    }
  }
  return out
}

describe("alpha 桌面菜单只发布接得住的命令", () => {
  for (const platform of ["macos", "windows"] as const) {
    test(`${platform}:把真菜单**整个**点一遍,发出来的 id 集恰好等于发布面`, () => {
      const { template, clickAndCollect } = buildFor(platform)

      // 关键:枚举方向是**从真模板出发**,不是从策略出发。反过来做会漏掉「模板里多出来的那些」——
      // 而「多出来一条没人接的」正是本闸门要抓的东西(实测:按策略逐条查找的写法,把 menu.ts 改回
      // 直接铺 DESKTOP_MENU 也照样全绿,是个假闸门)。
      const emitted: string[] = []
      for (const menu of template) {
        for (const item of menu.submenu ?? []) {
          if (!item.click) continue
          // action / href 项的依赖已被 mock 成 no-op,点了不会发 id;只有 command 项会。
          emitted.push(...clickAndCollect(item))
        }
      }

      expect([...new Set(emitted)].sort()).toEqual(publishedMenuCommands(platform))
      expect(emitted.length).toBeGreaterThan(0)
      for (const id of emitted) expect(RETIRED_MENU_COMMANDS.has(id)).toBe(false)
    })

    test(`${platform}:每一条发布项在真菜单里都点得着,且点出来的正是它自己`, () => {
      const { template, clickAndCollect } = buildFor(platform)
      for (const { menu, label, command } of modelCommands(platform)) {
        const native = template.find((entry) => entry.label === menu)
        expect(native, `菜单「${menu}」没有被发布`).toBeDefined()
        const item = native!.submenu?.find((entry) => entry.label === label)
        expect(item?.click, `「${menu} → ${label}」不可点`).toBeDefined()
        expect(clickAndCollect(item!), `「${menu} → ${label}」点出来的不是 ${command}`).toEqual([command])
      }
    })

    test(`${platform}:真菜单的条目结构与发布面逐项对齐(多一条少一条都红)`, () => {
      const { template } = buildFor(platform)
      const model = alphaDesktopMenu(platform)
      // 模板 = 发布面**前缀** + alpha 自建菜单(「数据」/ Windows 的「帮助」,都不发命令 ——
      // 「整个点一遍」那条已经保证了模板里不存在发布面之外的命令 id)。
      expect(template.length).toBeGreaterThanOrEqual(model.length)
      for (const [index, menu] of model.entries()) {
        const native = template[index]!
        if (menu.role) continue
        expect(native.label, `第 ${index} 个菜单标题不一致`).toBe(menu.label)
        expect(native.submenu ?? [], `菜单「${menu.label}」条目数不一致`).toHaveLength((menu.items ?? []).length)
      }
    })

    test(`${platform}:退休后不留悬空分隔符、不留空菜单`, () => {
      for (const menu of alphaDesktopMenu(platform)) {
        if (menu.role) continue
        const items = menu.items ?? []
        expect(items.length, `菜单「${menu.label}」被掏空还留在菜单栏上`).toBeGreaterThan(0)
        expect(items[0]!.type, `菜单「${menu.label}」以分隔符开头`).not.toBe("separator")
        expect(items[items.length - 1]!.type, `菜单「${menu.label}」以分隔符结尾`).not.toBe("separator")
        for (let i = 1; i < items.length; i++) {
          const consecutive = items[i]!.type === "separator" && items[i - 1]!.type === "separator"
          expect(consecutive, `菜单「${menu.label}」有连续分隔符`).toBe(false)
        }
      }
    })

    test(`${platform}:上游每条菜单命令都被显式分类,退休清单里没有过期条目`, () => {
      const upstream = new Set<string>()
      for (const menu of DESKTOP_MENU) {
        if (!desktopMenuVisible(menu, platform)) continue
        for (const entry of menu.items ?? []) {
          if (entry.type === "item" && entry.command && desktopMenuVisible(entry, platform)) upstream.add(entry.command)
        }
      }
      // 上游改名/删项后,退休条目会变成死字面量,而**改名后的那条会自动进发布面** ——
      // 那正是本 REQ 要防的「悄悄多出一个入口」。所以退休清单必须与上游同步。
      expect([...RETIRED_MENU_COMMANDS].filter((id) => !upstream.has(id))).toEqual([])
      // 分类穷尽:上游每一条要么被发布(→ 渲染侧闸门要求它可触发),要么被显式退休。
      expect([...upstream].filter((id) => !RETIRED_MENU_COMMANDS.has(id)).sort()).toEqual(
        publishedMenuCommands(platform),
      )
    })
  }

  test("owner 可见的具体后果:终端/文件树/上下一个会话·项目已从菜单消失,其余照旧可用", () => {
    const published = publishedMenuCommands("macos")
    for (const gone of [
      "terminal.toggle",
      "fileTree.toggle",
      "session.previous",
      "session.next",
      "project.previous",
      "project.next",
      // 后退/前进:上游 Titlebar 抢注同名 id 且走只有 ["/"] 的私有 history,菜单项在首页/新对话页
      // 静默 no-op、在会话页才落到别人手上 —— 同一项两种行为。入口改由侧栏左上角那对直连按钮承担。
      "common.goBack",
      "common.goForward",
    ])
      expect(published).not.toContain(gone)
    for (const kept of ["settings.open", "session.new", "project.open", "sidebar.toggle", "logs.export"])
      expect(published).toContain(kept)
  })
})
