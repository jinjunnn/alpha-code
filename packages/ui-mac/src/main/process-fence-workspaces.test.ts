// `#1394` —— 围栏工作区清单的真源:位置、严格读、原子写、播种(AC3 / AC4④)、检疫(伪造条目经 renderer 写回也进不了真源)。
// 全平台、electron-free、真文件系统(临时目录)。期望值手写字面量;每条「不会写」的断言都先证明手段测得出「会写」。

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  bootFenceWorkspaceTruth,
  fenceWorkspaceTruthPath,
  readWorkspaceTruth,
  readWorkspaceTruthOrThrow,
  workspacesFromRendererTabs,
  writeWorkspaceTruth,
} from "./process-fence-workspaces"
import { environmentMutableRoot } from "./alpha-environment"
import { GLOBAL_RENDERER_STORE, TABS_INFO_KEY, TABS_KEY, TABS_RECENT_KEY } from "./tabs-preclean"

const STATE_ROOT = "/Users/alpha/Library/Application Support/alpha-code-state"

function withTemp<T>(run: (dir: string) => T): T {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fence-ws-")))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const draft = (id: string, directory: string, server = "sidecar") => ({ type: "draft", draftID: id, server, directory })

describe("真源文件:位置、严格读、原子写", () => {
  test("路径 = <casBaseRoot>/fence-workspaces/<env>.json,与三个 env 根、cas/ 同级 —— 不在 W2(env/<env>)之下", () => {
    expect(fenceWorkspaceTruthPath(STATE_ROOT, "prod")).toBe("/Users/alpha/Library/Application Support/alpha-code-state/fence-workspaces/prod.json")
    expect(fenceWorkspaceTruthPath(STATE_ROOT, "dev")).toBe("/Users/alpha/Library/Application Support/alpha-code-state/fence-workspaces/dev.json")
    for (const env of ["prod", "beta", "dev"] as const) {
      const rel = relative(environmentMutableRoot(env, STATE_ROOT), fenceWorkspaceTruthPath(STATE_ROOT, env))
      expect(rel.startsWith(".."), `${env}: ${rel}`).toBe(true)
      expect(relative(join(STATE_ROOT, "cas"), fenceWorkspaceTruthPath(STATE_ROOT, env)).startsWith("..")).toBe(true)
    }
  })

  test("写 → 读往返;落盘文本是固定字面量;写完目录里没有临时文件残留", () => {
    withTemp((dir) => {
      const path = join(dir, "fence-workspaces", "prod.json")
      writeWorkspaceTruth(path, ["/Users/alpha/proj-a", "/Users/alpha/proj-b"], fs)
      expect(readFileSync(path, "utf8")).toBe('{"v":1,"workspaces":["/Users/alpha/proj-a","/Users/alpha/proj-b"]}\n')
      expect(readdirSync(join(dir, "fence-workspaces"))).toEqual(["prod.json"])
      expect(readWorkspaceTruth(path, fs)).toEqual({ ok: true, workspaces: ["/Users/alpha/proj-a", "/Users/alpha/proj-b"] })
      expect(readWorkspaceTruthOrThrow(path, fs)).toEqual(["/Users/alpha/proj-a", "/Users/alpha/proj-b"])
      // 覆盖写也是原子的:内容整份换,不残留
      writeWorkspaceTruth(path, [], fs)
      expect(readFileSync(path, "utf8")).toBe('{"v":1,"workspaces":[]}\n')
      expect(readdirSync(join(dir, "fence-workspaces"))).toEqual(["prod.json"])
    })
  })

  test("缺失单独标出(absent:true,播种只认这一档);读错 / 不是 JSON / 形状不对 ⇒ 整份拒,原因点名文件与哪一项", () => {
    withTemp((dir) => {
      const path = join(dir, "dev.json")
      expect(readWorkspaceTruth(path, fs)).toEqual({ ok: false, absent: true, reason: `absent: ${path}` })
      expect(() => readWorkspaceTruthOrThrow(path, fs)).toThrow(`workspace truth absent: ${path}`)

      const bad: Array<[string, string]> = [
        ["{not json", "not JSON"],
        ["[]", "not a JSON object"],
        ['{"v":2,"workspaces":[]}', "unsupported version 2 (expected 1)"],
        ['{"v":1,"workspaces":"/x"}', "`workspaces` is not an array"],
        ['{"v":1,"workspaces":["/ok","relative/path"]}', 'workspaces[1] is not an absolute path: "relative/path"'],
        ['{"v":1,"workspaces":[42]}', "workspaces[0] is not an absolute path: 42"],
        ['{"v":1,"workspaces":[null]}', "workspaces[0] is not an absolute path: null"],
      ]
      for (const [text, reason] of bad) {
        writeFileSync(path, text)
        const read = readWorkspaceTruth(path, fs)
        expect(read.ok, text).toBe(false)
        if (read.ok) continue
        expect(read.absent, text).toBe(false)
        expect(read.reason, text).toContain(`${path}: ${reason}`)
        expect(() => readWorkspaceTruthOrThrow(path, fs), text).toThrow(reason)
      }
      // 正样本:空清单是合法的(用户没开过任何项目)
      writeFileSync(path, '{"v":1,"workspaces":[]}')
      expect(readWorkspaceTruth(path, fs)).toEqual({ ok: true, workspaces: [] })
    })
  })

  test("写失败:临时文件被收走、错误原样抛出(调用方决定怎么出声)", () => {
    withTemp((dir) => {
      const path = join(dir, "x", "prod.json")
      const failing = {
        ...fs,
        renameSync: () => {
          throw new Error("EROFS: read-only file system")
        },
      }
      expect(() => writeWorkspaceTruth(path, ["/a"], failing)).toThrow("EROFS")
      expect(readdirSync(join(dir, "x"))).toEqual([])
    })
  })
})

describe("workspacesFromRendererTabs —— renderer tab 状态 → 清单(与 planner 此前直接吃 store 时同序)", () => {
  test("顺序 recent → tab 栏 draft → info session;只认本地 sidecar;相对路径丢;resolve 后去重", () => {
    const list = workspacesFromRendererTabs({
      tabs: JSON.stringify([
        draft("a", "/Users/alpha/proj-a"),
        draft("r", "/home/u/remote", "wsl:ubuntu"),
        draft("b", "/Users/alpha/proj-b/"),
        draft("rel", "relative/path"),
        { type: "session", server: "sidecar", sessionID: "s1" },
      ]),
      recent: { key: "draft:b" },
      info: { "sidecar\n/session/s1": { directory: "/Users/alpha/proj-c" }, "sidecar\n/session/s2": { directory: "/Users/alpha/proj-a" } },
    })
    expect(list).toEqual(["/Users/alpha/proj-b", "/Users/alpha/proj-a", "/Users/alpha/proj-c"])
    expect(workspacesFromRendererTabs({ tabs: undefined, recent: undefined, info: undefined })).toEqual([])
    expect(workspacesFromRendererTabs({ tabs: "{not json", recent: 42, info: null })).toEqual([])
  })
})

describe("bootFenceWorkspaceTruth —— 播种 / 装载 + 检疫 / 坏文件不动", () => {
  const seedStore = {
    tabs: JSON.stringify([draft("a", "/Users/alpha/proj-a"), draft("b", "/Users/alpha/proj-b")]),
    recent: JSON.stringify({ key: "draft:b" }),
    info: { "sidecar\n/session/s1": { directory: "/Users/alpha/proj-c" } },
  }

  test("AC4④ 播种:真源缺失 ⇒ 从 store 的 3 条写出等价的 3 条(同序),日志一行点名条数与路径;没有检疫", () => {
    withTemp((dir) => {
      const truthPath = join(dir, "fence-workspaces", "prod.json")
      const logs: string[] = []
      const tracker = bootFenceWorkspaceTruth({ truthPath, store: seedStore, fs, log: (l) => void logs.push(l) })
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":["/Users/alpha/proj-b","/Users/alpha/proj-a","/Users/alpha/proj-c"]}\n')
      expect(tracker.quarantined).toEqual([])
      expect(logs).toEqual([
        `process fence: workspace truth seeded from the renderer tab store (first launch with #1394) — 3 workspace(s) written to ${truthPath}: /Users/alpha/proj-b, /Users/alpha/proj-a, /Users/alpha/proj-c`,
      ])
    })
  })

  test("播种:store 空 / 不可读 ⇒ 写出空清单(不是不写 —— 下次启动不再算「首次」)", () => {
    withTemp((dir) => {
      const truthPath = join(dir, "prod.json")
      const logs: string[] = []
      bootFenceWorkspaceTruth({ truthPath, store: { tabs: undefined, recent: undefined, info: undefined }, fs, log: (l) => void logs.push(l) })
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":[]}\n')
      expect(logs[0]).toBe(`process fence: workspace truth seeded from the renderer tab store (first launch with #1394) — 0 workspace(s) written to ${truthPath}`)
    })
  })

  test("装载 + 检疫:真源在 ⇒ 一个字节不动;store 里多出来的那条(伪造)进检疫名单并写进日志", () => {
    withTemp((dir) => {
      const truthPath = join(dir, "prod.json")
      writeWorkspaceTruth(truthPath, ["/Users/alpha/proj-a"], fs)
      const before = statSync(truthPath).mtimeMs
      const logs: string[] = []
      const tracker = bootFenceWorkspaceTruth({
        truthPath,
        store: { tabs: [draft("a", "/Users/alpha/proj-a"), draft("forged", "/Users/alpha/Library/LaunchAgents")], recent: { key: "draft:forged" }, info: {} },
        fs,
        log: (l) => void logs.push(l),
      })
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":["/Users/alpha/proj-a"]}\n')
      expect(statSync(truthPath).mtimeMs).toBe(before)
      expect(tracker.quarantined).toEqual(["/Users/alpha/Library/LaunchAgents"])
      expect(logs).toEqual([
        `process fence: workspace truth loaded — 1 workspace(s) from ${truthPath}`,
        "process fence: 1 workspace(s) are in the renderer tab store but not in the workspace truth — quarantined for this session, they never enter the truth even if the renderer persists them back (#1394): /Users/alpha/Library/LaunchAgents",
      ])
    })
  })

  test("检疫真的挡得住 renderer 写回:tabs 整份经 IPC 写回(含伪造条 + 一条这一会话新开的目录)⇒ 真源只多新开的那条;伪造条永不进", () => {
    withTemp((dir) => {
      const truthPath = join(dir, "prod.json")
      writeWorkspaceTruth(truthPath, ["/Users/alpha/proj-a"], fs)
      const logs: string[] = []
      const forgedTabs = [draft("a", "/Users/alpha/proj-a"), draft("forged", "/Users/alpha/Library/LaunchAgents")]
      const tracker = bootFenceWorkspaceTruth({ truthPath, store: { tabs: JSON.stringify(forgedTabs), recent: undefined, info: undefined }, fs, log: (l) => void logs.push(l) })
      // 对照臂:先证明「IPC 写回会改真源」—— 用户新开一个目录
      tracker.noteRendererStoreSet(GLOBAL_RENDERER_STORE, TABS_KEY, JSON.stringify([...forgedTabs, draft("n", "/Users/alpha/proj-new")]))
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":["/Users/alpha/proj-a","/Users/alpha/proj-new"]}\n')
      expect(logs.at(-1)).toBe(
        `process fence: workspace truth updated from the renderer tab store — 2 workspace(s); added: /Users/alpha/proj-new (takes effect at the next engine generation)`,
      )
      // recent 指向伪造条也没用:它不在候选里,排序只在真源成员之间
      tracker.noteRendererStoreSet(GLOBAL_RENDERER_STORE, TABS_RECENT_KEY, JSON.stringify({ key: "draft:forged" }))
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":["/Users/alpha/proj-a","/Users/alpha/proj-new"]}\n')
      // recent 指向新开的那条 ⇒ 它排到最前(裁剪从尾丢,最近的最后丢)
      tracker.noteRendererStoreSet(GLOBAL_RENDERER_STORE, TABS_RECENT_KEY, JSON.stringify({ key: "draft:n" }))
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":["/Users/alpha/proj-new","/Users/alpha/proj-a"]}\n')
      // 关掉 proj-a 的 tab ⇒ 真源跟着减(与今天「关掉的项目下次不可写」同语义)
      tracker.noteRendererStoreSet(GLOBAL_RENDERER_STORE, TABS_KEY, JSON.stringify([draft("forged", "/Users/alpha/Library/LaunchAgents"), draft("n", "/Users/alpha/proj-new")]))
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":["/Users/alpha/proj-new"]}\n')
      expect(logs.at(-1)).toContain("removed: /Users/alpha/proj-a")
      // session tab 的目录经 tabs.info 进来,同样受检疫
      tracker.noteRendererStoreSet(
        GLOBAL_RENDERER_STORE,
        TABS_INFO_KEY,
        JSON.stringify({ "sidecar\n/session/s1": { directory: "/Users/alpha/proj-s" }, "sidecar\n/session/s2": { directory: "/Users/alpha/Library/LaunchAgents" } }),
      )
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":["/Users/alpha/proj-new","/Users/alpha/proj-s"]}\n')
      expect(tracker.quarantined).toEqual(["/Users/alpha/Library/LaunchAgents"])
    })
  })

  test("只认 opencode.global.dat 的三个 tab 键:别的 store / 别的键 / 内容没变 ⇒ 一个字节不写", () => {
    withTemp((dir) => {
      const truthPath = join(dir, "prod.json")
      const logs: string[] = []
      const tracker = bootFenceWorkspaceTruth({ truthPath, store: seedStore, fs, log: (l) => void logs.push(l) })
      const before = statSync(truthPath).mtimeMs
      const seededLogs = logs.length
      tracker.noteRendererStoreSet("default.dat", TABS_KEY, JSON.stringify([draft("x", "/Users/alpha/elsewhere")]))
      tracker.noteRendererStoreSet(GLOBAL_RENDERER_STORE, "language", "zh")
      tracker.noteRendererStoreSet(GLOBAL_RENDERER_STORE, TABS_KEY, seedStore.tabs) // 内容相同
      tracker.noteRendererStoreDelete("default.dat", TABS_KEY)
      tracker.noteRendererStoreClear("default.dat")
      expect(statSync(truthPath).mtimeMs).toBe(before)
      expect(logs.length).toBe(seededLogs)
      // 对照臂:同一个 tracker、正确的 store + 键 ⇒ 会写
      tracker.noteRendererStoreDelete(GLOBAL_RENDERER_STORE, TABS_KEY)
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":["/Users/alpha/proj-c"]}\n')
      tracker.noteRendererStoreClear(GLOBAL_RENDERER_STORE)
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":[]}\n')
    })
  })

  test("真源坏了(不是缺失):不改写、不重新播种、出声;下一次 renderer 写回按当时状态重建(检疫为空)", () => {
    withTemp((dir) => {
      const truthPath = join(dir, "prod.json")
      writeFileSync(truthPath, '{"v":1,"workspaces":"oops"}')
      const logs: string[] = []
      const tracker = bootFenceWorkspaceTruth({ truthPath, store: seedStore, fs, log: (l) => void logs.push(l) })
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":"oops"}')
      expect(tracker.quarantined).toEqual([])
      expect(logs).toEqual([
        `process fence: workspace truth is unreadable — ${truthPath}: \`workspaces\` is not an array; leaving it untouched, the planner falls back to the default workspace only until the renderer's next tab change rewrites it`,
      ])
      expect(() => readWorkspaceTruthOrThrow(truthPath, fs)).toThrow("`workspaces` is not an array")
      tracker.noteRendererStoreSet(GLOBAL_RENDERER_STORE, TABS_RECENT_KEY, JSON.stringify({ key: "draft:a" }))
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":["/Users/alpha/proj-a","/Users/alpha/proj-b","/Users/alpha/proj-c"]}\n')
    })
  })

  test("写不出去:播种失败 / 更新失败都不抛,日志说清后果;下一次写回再试", () => {
    withTemp((dir) => {
      const truthPath = join(dir, "prod.json")
      let fail = true
      const flaky = {
        ...fs,
        renameSync: (from: string, to: string) => {
          if (fail) throw new Error("ENOSPC: no space left on device")
          fs.renameSync(from, to)
        },
      }
      const logs: string[] = []
      const tracker = bootFenceWorkspaceTruth({ truthPath, store: seedStore, fs: flaky, log: (l) => void logs.push(l) })
      expect(fs.existsSync(truthPath)).toBe(false)
      expect(logs[0]).toBe(
        `process fence: FAILED to seed the workspace truth at ${truthPath} — the planner falls back to the default workspace only until the renderer's next tab change writes it: ENOSPC: no space left on device`,
      )
      tracker.noteRendererStoreSet(GLOBAL_RENDERER_STORE, TABS_KEY, JSON.stringify([draft("a", "/Users/alpha/proj-a")]))
      expect(fs.existsSync(truthPath)).toBe(false)
      expect(logs[1]).toBe(
        `process fence: FAILED to write the workspace truth at ${truthPath} — the next engine generation keeps the previous list: ENOSPC: no space left on device`,
      )
      fail = false
      tracker.noteRendererStoreSet(GLOBAL_RENDERER_STORE, TABS_KEY, JSON.stringify([draft("a", "/Users/alpha/proj-a"), draft("b", "/Users/alpha/proj-b")]))
      expect(readFileSync(truthPath, "utf8")).toBe('{"v":1,"workspaces":["/Users/alpha/proj-b","/Users/alpha/proj-a","/Users/alpha/proj-c"]}\n')
    })
  })
})
