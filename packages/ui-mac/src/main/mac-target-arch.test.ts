// #1496 判据:mac 包里的架构相关原生依赖必须按**目标**架构选,而不是打包机自己的架构。
//
// 已知的坏(本票要拦的形状):在 arm64 Mac 上 `bun run build` 之后加 `--x64` 打包 —— out/main 里编进去的是
// `@lydell/node-pty-darwin-arm64`,装出来的 Intel 包终端打不开。下面每一条都对准它的一个侧面:
//   ① 生产 vite 配置在「目标 ≠ 宿主」时选的是目标那个 node-pty 包(子进程真加载 electron.vite.config.ts);
//   ② 生产 electron-builder 配置的 beforePack 真的会拒绝「打的架构 ≠ 目标架构」;
//   ③ beforePack 用的核对函数:产物引用了宿主架构包 / 原生包缺席 / 二进制片不对 ⇒ 一律拒绝,全对才放行。
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Arch } from "electron-builder"

import {
  TARGET_ARCH_ENV,
  assertMacTargetArch,
  machOArchs,
  macNativePackages,
  nodePtyPackage,
  resolveTargetArch,
  type TargetArch,
} from "../../scripts/target-arch"
import { mergeMacFeeds, parse, serialize } from "../../scripts/latest-yml"

const packageDir = path.resolve(import.meta.dir, "../..")
const host = process.arch
// 与宿主不同的那个受支持架构 —— 「跨架构打包」的最小复现。宿主若不是 arm64/x64,就取 x64。
const crossArch: TargetArch = host === "x64" ? "arm64" : "x64"
const otherArch = (a: TargetArch): TargetArch => (a === "x64" ? "arm64" : "x64")

// ── Mach-O 夹具 ──────────────────────────────────────────────────────────────────────
const CPU = { x64: 0x01000007, arm64: 0x0100000c } as const
function thin(arch: TargetArch): Buffer {
  const b = Buffer.alloc(32)
  b.writeUInt32LE(0xfeedfacf, 0)
  b.writeUInt32LE(CPU[arch], 4)
  return b
}
function fat(archs: TargetArch[]): Buffer {
  const b = Buffer.alloc(8 + archs.length * 20)
  b.writeUInt32BE(0xcafebabe, 0)
  b.writeUInt32BE(archs.length, 4)
  archs.forEach((a, i) => b.writeUInt32BE(CPU[a], 8 + i * 20))
  return b
}

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** 造一个最小的 packages/ui-mac:out/main 产物 + node_modules 里的原生包。 */
function fixture(opts: {
  bundled: string[] // out/main 里引用的 node-pty 包名
  packages: { name: string; cpu: TargetArch; binaries: Record<string, Buffer> }[]
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-target-arch-"))
  tmpDirs.push(dir)
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "ui-mac-fixture" }))
  fs.mkdirSync(path.join(dir, "out", "main", "chunks"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, "out", "main", "chunks", "index.js"),
    opts.bundled.map((n) => `import * as pty from "${n}";`).join("\n") + "\nexport {}\n",
  )
  for (const p of opts.packages) {
    const pdir = path.join(dir, "node_modules", ...p.name.split("/"))
    fs.mkdirSync(pdir, { recursive: true })
    fs.writeFileSync(path.join(pdir, "package.json"), JSON.stringify({ name: p.name, os: ["darwin"], cpu: [p.cpu] }))
    for (const [rel, bytes] of Object.entries(p.binaries)) {
      fs.mkdirSync(path.dirname(path.join(pdir, rel)), { recursive: true })
      fs.writeFileSync(path.join(pdir, rel), bytes)
    }
  }
  return dir
}

type FixturePackage = { name: string; cpu: TargetArch; binaries: Record<string, Buffer> }

function goodPackages(arch: TargetArch): FixturePackage[] {
  return [
    {
      name: nodePtyPackage("darwin", arch),
      cpu: arch,
      binaries: { [`prebuilds/darwin-${arch}/pty.node`]: thin(arch), [`prebuilds/darwin-${arch}/spawn-helper`]: thin(arch) },
    },
    { name: `@parcel/watcher-darwin-${arch}`, cpu: arch, binaries: { "watcher.node": thin(arch) } },
  ]
}

describe("resolveTargetArch", () => {
  test("显式 ALPHA_TARGET_ARCH 压过宿主架构", () => {
    expect(resolveTargetArch({ [TARGET_ARCH_ENV]: "x64" }, "arm64")).toBe("x64")
    expect(resolveTargetArch({ [TARGET_ARCH_ENV]: "arm64" }, "x64")).toBe("arm64")
  })
  test("缺省 = 宿主架构(不改今天 arm64 机器的默认行为)", () => {
    expect(resolveTargetArch({}, "arm64")).toBe("arm64")
    expect(resolveTargetArch({ [TARGET_ARCH_ENV]: "" }, "x64")).toBe("x64")
  })
  test("非法值抛错,不静默回落宿主", () => {
    expect(() => resolveTargetArch({ [TARGET_ARCH_ENV]: "universal" }, "arm64")).toThrow(/不受支持/)
    expect(() => resolveTargetArch({ [TARGET_ARCH_ENV]: "x86_64" }, "arm64")).toThrow(/不受支持/)
    expect(() => resolveTargetArch({}, "ia32")).toThrow(/不受支持/)
  })
})

describe("machOArchs", () => {
  test("瘦文件 / fat 文件 / 非 Mach-O", () => {
    expect(machOArchs(thin("x64"))).toEqual(["x64"])
    expect(machOArchs(thin("arm64"))).toEqual(["arm64"])
    expect(machOArchs(fat(["arm64", "x64"]))).toEqual(["arm64", "x64"])
    expect(machOArchs(Buffer.from("\x7fELF\x02\x01\x01\x00"))).toBeNull()
    expect(machOArchs(Buffer.from("// js"))).toBeNull()
  })

})

describe("生产 electron.vite.config.ts 按目标架构选 node-pty 包", () => {
  // 子进程加载**生产**配置(env 在模块求值时读),断言 narrower 插件与 externalize 名单给出的包名。
  function loadNodePtyChoice(env: Record<string, string | undefined>) {
    const script = `
      const c = (await import(${JSON.stringify(path.join(packageDir, "electron.vite.config.ts"))})).default
      const p = c.main.plugins.find((x) => x && x.name === "opencode:node-pty-narrower")
      console.log(JSON.stringify({ narrowed: p.resolveId("@lydell/node-pty"), include: c.main.build.externalizeDeps.include }))
    `
    const childEnv = { ...process.env, ...env }
    if (env[TARGET_ARCH_ENV] === undefined) delete childEnv[TARGET_ARCH_ENV]
    const r = spawnSync(process.execPath, ["-e", script], { cwd: packageDir, env: childEnv, encoding: "utf8", timeout: 120_000 })
    expect(r.status, r.stderr).toBe(0)
    return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { narrowed: string; include: string[] }
  }

  test(`目标 ${crossArch} ≠ 宿主 ${host} ⇒ 编进产物的是目标架构的包,不是宿主架构的包`, () => {
    const got = loadNodePtyChoice({ [TARGET_ARCH_ENV]: crossArch })
    const want = nodePtyPackage(process.platform, crossArch)
    expect(got.narrowed).toBe(want)
    expect(got.include).toEqual([want])
    expect(got.narrowed).not.toBe(`@lydell/node-pty-${process.platform}-${host}`)
  }, 150_000)

  test("未设目标 ⇒ 宿主架构(默认行为不变)", () => {
    const got = loadNodePtyChoice({ [TARGET_ARCH_ENV]: undefined })
    expect(got.narrowed).toBe(`@lydell/node-pty-${process.platform}-${host}`)
  }, 150_000)
})

describe("生产 electron-builder.config.ts 的 beforePack", () => {
  test(`打 ${crossArch} 包但目标架构未设(= 宿主 ${host})⇒ 拒绝打包`, async () => {
    const saved = process.env[TARGET_ARCH_ENV]
    delete process.env[TARGET_ARCH_ENV]
    try {
      const { getConfig } = await import("../../electron-builder.config")
      const beforePack = getConfig("prod").beforePack as (ctx: unknown) => Promise<void>
      expect(typeof beforePack).toBe("function")
      await expect(beforePack({ electronPlatformName: "darwin", arch: Arch[crossArch] })).rejects.toThrow(
        new RegExp(`拒绝打 mac-${crossArch} 包[\\s\\S]*正在打 ${crossArch} 包`),
      )
      // 非 mac 平台不受影响(win/linux 打包照旧)。
      await expect(beforePack({ electronPlatformName: "win32", arch: Arch.x64 })).resolves.toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env[TARGET_ARCH_ENV]
      else process.env[TARGET_ARCH_ENV] = saved
    }
  })
})

describe("assertMacTargetArch(beforePack 的核对)", () => {
  for (const target of ["x64", "arm64"] as const) {
    const wrong = otherArch(target)
    const env = { [TARGET_ARCH_ENV]: target }

    test(`${target}:产物与原生包全对 ⇒ 放行`, () => {
      const dir = fixture({ bundled: [nodePtyPackage("darwin", target)], packages: [...goodPackages(target), ...goodPackages(wrong)] })
      expect(() => assertMacTargetArch({ packingArch: target, packageDir: dir, env, hostArch: wrong })).not.toThrow()
    })

    test(`${target}:产物是按 ${wrong} build 的(编进了 ${wrong} 的 node-pty)⇒ 拒绝`, () => {
      const dir = fixture({ bundled: [nodePtyPackage("darwin", wrong)], packages: [...goodPackages(target), ...goodPackages(wrong)] })
      expect(() => assertMacTargetArch({ packingArch: target, packageDir: dir, env, hostArch: wrong })).toThrow(
        new RegExp(`out/main 引用了 @lydell/node-pty-darwin-${wrong}`),
      )
    })

    test(`${target}:目标未设、宿主是 ${wrong} ⇒ 拒绝(不许按宿主架构打跨架构包)`, () => {
      const dir = fixture({ bundled: [nodePtyPackage("darwin", target)], packages: goodPackages(target) })
      expect(() => assertMacTargetArch({ packingArch: target, packageDir: dir, env: {}, hostArch: wrong })).toThrow(
        /正在打 .* 包,但 ALPHA_TARGET_ARCH 解析为/,
      )
    })

    test(`${target}:node_modules 里只有宿主 ${wrong} 的原生包 ⇒ 拒绝并给出安装命令`, () => {
      const dir = fixture({ bundled: [nodePtyPackage("darwin", target)], packages: goodPackages(wrong) })
      let message = ""
      try {
        assertMacTargetArch({ packingArch: target, packageDir: dir, env, hostArch: wrong })
      } catch (e) {
        message = String(e)
      }
      for (const pkg of macNativePackages(target)) expect(message).toContain(`${pkg} 不在 node_modules 里`)
      expect(message).toContain("bun install --os=darwin --cpu='*'")
    })

    test(`${target}:包名对、但里面的二进制是 ${wrong} 片 ⇒ 拒绝`, () => {
      const pkgs = goodPackages(target)
      pkgs[0]!.binaries[`prebuilds/darwin-${target}/spawn-helper`] = thin(wrong)
      pkgs[1]!.binaries["watcher.node"] = fat([wrong])
      const dir = fixture({ bundled: [nodePtyPackage("darwin", target)], packages: pkgs })
      expect(() => assertMacTargetArch({ packingArch: target, packageDir: dir, env, hostArch: wrong })).toThrow(
        new RegExp(`spawn-helper 只含 \\[${wrong}\\],缺 ${target}[\\s\\S]*watcher\\.node 只含 \\[${wrong}\\],缺 ${target}`),
      )
    })
  }

  test("fat(arm64+x64)二进制对两种目标都算对", () => {
    for (const target of ["x64", "arm64"] as const) {
      const pkgs = goodPackages(target)
      pkgs[1]!.binaries["watcher.node"] = fat(["arm64", "x64"])
      const dir = fixture({ bundled: [nodePtyPackage("darwin", target)], packages: pkgs })
      expect(() =>
        assertMacTargetArch({ packingArch: target, packageDir: dir, env: { [TARGET_ARCH_ENV]: target }, hostArch: "arm64" }),
      ).not.toThrow()
    }
  })

  test("universal 不支持 ⇒ 拒绝", () => {
    const dir = fixture({ bundled: [nodePtyPackage("darwin", "arm64")], packages: goodPackages("arm64") })
    expect(() =>
      assertMacTargetArch({ packingArch: "universal", packageDir: dir, env: { [TARGET_ARCH_ENV]: "arm64" }, hostArch: "arm64" }),
    ).toThrow(/universal 不支持/)
  })
})

describe("mergeMacFeeds(latest-mac.yml 两架构合并)", () => {
  const feed = (arch: TargetArch, version = "0.1.19") =>
    parse(
      [
        `version: ${version}`,
        "files:",
        `  - url: alpha-code-mac-${arch}.zip`,
        `    sha512: ${arch}zip`,
        "    size: 10",
        `  - url: alpha-code-mac-${arch}.dmg`,
        `    sha512: ${arch}dmg`,
        "    size: 20",
        `path: alpha-code-mac-${arch}.zip`,
        `releaseDate: '2026-10-10T00:00:0${arch === "x64" ? 1 : 0}.000Z'`,
      ].join("\n"),
    )

  test("合并后两种架构的 dmg/zip 都在,且经序列化往返不丢", () => {
    const merged = parse(serialize(mergeMacFeeds(feed("arm64"), feed("x64"))))
    expect(merged.version).toBe("0.1.19")
    expect(merged.files.map((f) => f.url)).toEqual([
      "alpha-code-mac-arm64.zip",
      "alpha-code-mac-arm64.dmg",
      "alpha-code-mac-x64.zip",
      "alpha-code-mac-x64.dmg",
    ])
  })
  test("版本不一致 ⇒ 拒绝", () => {
    expect(() => mergeMacFeeds(feed("arm64", "0.1.19"), feed("x64", "0.1.18"))).toThrow(/版本/)
  })
  test("两份 feed 放反(arm64 槽里是 x64 文件)⇒ 拒绝", () => {
    expect(() => mergeMacFeeds(feed("x64"), feed("arm64"))).toThrow(/不属于 arm64/)
  })
})
