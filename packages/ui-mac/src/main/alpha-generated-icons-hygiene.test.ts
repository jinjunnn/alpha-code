// `#1115` —— 频道图标是**生成物**,不进版本控制。
//
// 缺陷(2026-08-25 在 `ac#1108` 的 packaged 验证里撞到,本文件落地时逐条复测):
// `packages/ui-mac` 是 `packages/desktop` 的 fork(`842c6f0b1`),fork 时**漏掉了**
// `packages/desktop/.gitignore` 里那行 `resources/icons` —— 于是 53 个由
// `packages/ui-mac/scripts/copy-icons.ts`(`rm -rf resources/icons && cp -R icons/<channel>`)
// 生成的文件被提交进了版本控制,而**没有任何地方记着它们是哪个频道的**。
// 实测(`git rev-parse HEAD:<path>` 逐文件比对):仓里那份与 `icons/dev` 53/53 逐字相同,
// 与 `icons/beta`、`icons/prod` 各差 **43** 个。两个方向都咬人:
//   ① 任何一次非 dev 的 packaged 构建当场把 43 个**被追踪**文件改脏 ⇒ 脏树诱发
//      `git checkout -- <path>`,而那个动作会把同路径下未提交的真实改动一起抹掉;
//   ② 一次不经意的 `git add -A` 就把整仓图标翻成另一个频道,**没有任何闸会红**
//      (落地前两条检索轴查过 `copy-icons` 与 `resources/icons`:test/scripts/workflows 零命中)。
//
// 修法取的是「移出版本控制」而不是「保留追踪 + 加一道字节相等闸」,理由只有一条:
// 后者**结构上**满足不了「到达 `resources/icons` 的唯一通路是 `copy-icons.ts`」——
// 只要那些字节还在版本控制里,`git checkout` / `git merge` / `git clone` 就都是通路,
// 而闸只能在事后比对,拦不住通路本身。仓内已有同形先例:`packages/desktop/.gitignore`
// 一直忽略它,`packages/ui-mac/.gitignore` 也已经忽略了另一个生成资源
// (`resources/db-expected-migrations.json`,prebuild 产)。
//
// 删掉本文件会失去什么(三条,一条一个 test):
//   ① `resources/icons` 重新进版本控制**不会红** —— 无论是有人删掉 .gitignore 那一行、
//      `git add -f` 强加、还是一次合并把它带回来;
//   ② `.gitignore` 那一行被删掉**不会红** —— 于是下一次 `git add -A` 又把整仓图标翻频道;
//   ③ `copy-icons.ts` 改成从别处取字节(合并频道、指错目录、忽略实参只认环境变量)
//      **不会红** —— 而「内容与某个具名频道逐字节相等」这条保证就是它一个人在扛。
//
// 判据刻意不断言任何源码文本:③ 起真 tmp 树、跑**生产脚本本体**、逐文件比 sha256。
// 每条断言都配了反证(同一把尺子对**已知该红**的输入必须给出相反答案),因为
// 「零命中」与「路径拼错」在 `git ls-files` 上长得一模一样。

import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")

/** 生成物落点 —— 本闸的主语。 */
const GENERATED = "packages/ui-mac/resources/icons"
/** 频道字节的真源(被追踪,是 `copy-icons.ts` 的输入)。 */
const CHANNEL_SRC = "packages/ui-mac/icons"
/**
 * 2026-08-26 实测:每个频道 53 个文件。这里是**地板**,防的是「两边都空 ⇒ 集合相等 ⇒ 恒绿」
 * 那一类退化,不是钉住资产清单(加图标不该让本闸红)。
 */
const CHANNEL_FILE_FLOOR = 53

function git(args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) }
}

function tracked(pathspec: string): string[] {
  const r = git(["ls-files", "--", pathspec])
  expect(r.code, `git ls-files -- ${pathspec} 自己失败了 —— 本次测量作废,不是「没有命中」`).toBe(0)
  return r.out.split("\n").filter((line) => line.length > 0)
}

/** `git check-ignore` 只有 0(被忽略)/ 1(未被忽略)两个合法结局;其余当场作废。 */
function ignored(path: string): boolean {
  const r = git(["check-ignore", "-q", "--", path])
  expect([0, 1], `git check-ignore -- ${path} 给出 ${r.code} —— 本次测量作废`).toContain(r.code)
  return r.code === 0
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort()
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

describe("#1115 频道图标是生成物,不进版本控制", () => {
  test("resources/icons 在版本控制里一个字节都没有", () => {
    expect(tracked(GENERATED)).toEqual([])

    // 反证:同一条命令、同一把尺子,对**确实被追踪**的频道源必须数得出来。
    // 少了这一条,把 pathspec 拼错(或 `--` 用法改掉)也会给出空数组 ⇒ 上面那条恒绿。
    for (const channel of ["dev", "beta", "prod"]) {
      expect(tracked(`${CHANNEL_SRC}/${channel}`).length).toBeGreaterThanOrEqual(CHANNEL_FILE_FLOOR)
    }
  })

  test("resources/icons 被 .gitignore 罩着 —— 下一次 git add -A 加不回来", () => {
    for (const leaf of ["icon.icns", "icon.ico", "StoreLogo.png", "android/values/ic_launcher_background.xml"]) {
      expect(ignored(`${GENERATED}/${leaf}`), `${leaf} 没有被忽略`).toBe(true)
    }
    // 目录本身也要被罩住(`git add resources/icons` 走的是目录这条路径)。
    expect(ignored(GENERATED)).toBe(true)

    // 反证:同一把尺子对**不该被忽略**的兄弟资源必须答 false,否则一个「恒答 true」的
    // 实现(比如仓根多了一条 `*`)也能让上面全绿。
    expect(ignored("packages/ui-mac/resources/NOTICE.txt")).toBe(false)
    expect(ignored(`${CHANNEL_SRC}/prod/icon.icns`)).toBe(false)
  })

  test("copy-icons.ts 产出的就是那个具名频道的字节,逐文件 sha256 相等", () => {
    const work = mkdtempSync(join(tmpdir(), "alpha-1115-"))
    try {
      // 只搬 prod 一个频道 + 两个脚本:`copy-icons.ts` 的 `cp -R ./icons/<channel>` 与
      // `import { resolveChannel } from "./utils"` 都按 cwd / 脚本自身位置解析。
      cpSync(join(REPO_ROOT, CHANNEL_SRC, "prod"), join(work, "icons", "prod"), { recursive: true })
      cpSync(join(REPO_ROOT, "packages/ui-mac/scripts"), join(work, "scripts"), { recursive: true })
      // `cp -R src dest` 要求 dest 的**父目录**在场。生产里 `packages/ui-mac/resources/`
      // 恒在场(NOTICE.txt / entitlements.plist / skills/ 都被追踪),tmp 树要自己补上。
      mkdirSync(join(work, "resources"), { recursive: true })

      // `OPENCODE_CHANNEL=dev` 刻意与实参 `prod` 相反:一个「忽略实参、只认环境变量」的
      // 实现会当场把 dev 字节铺出来,下面的 sha256 逐条不等。
      const run = Bun.spawnSync([process.execPath, join("scripts", "copy-icons.ts"), "prod"], {
        cwd: work,
        env: { ...process.env, OPENCODE_CHANNEL: "dev" },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)

      const produced = filesUnder(join(work, "resources", "icons"))
      const expectedProd = filesUnder(join(REPO_ROOT, CHANNEL_SRC, "prod"))

      // 集合双向相等 —— 只比「产出的每个文件都对得上」的话,产出 1 个文件也绿。
      expect(produced).toEqual(expectedProd)
      expect(produced.length).toBeGreaterThanOrEqual(CHANNEL_FILE_FLOOR)

      const devDir = join(REPO_ROOT, CHANNEL_SRC, "dev")
      let differsFromDev = 0
      for (const rel of produced) {
        const got = sha256(join(work, "resources", "icons", rel))
        expect(got, `${rel} 与 icons/prod 不是同一份字节`).toBe(sha256(join(REPO_ROOT, CHANNEL_SRC, "prod", rel)))
        if (got !== sha256(join(devDir, rel))) differsFromDev += 1
      }

      // 反证:上面那条比较只有在**频道之间真的不同**时才有判别力。若三个频道逐字相同,
      // 一个恒copy dev 的实现照样全绿。2026-08-26 实测 prod 与 dev 差 43 个文件。
      expect(differsFromDev).toBeGreaterThan(0)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
