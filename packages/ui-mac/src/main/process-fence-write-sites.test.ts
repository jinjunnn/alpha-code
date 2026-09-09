// REQ-159 (`#1321`) · AC3 —— 可写集单一权威:alpha 在 sidecar 进程里的每一处写盘调用点都登记在
// scripts/process-fence-write-sites.tsv,并点名它落在 process-fence-profile.ts 的哪一行之下。
// 新增一处写盘不登记 ⇒ 红;登记了源码里没有的 ⇒ 红;根写歪 ⇒ 红。
//
// 手段先自证(四条控制臂,合成源码):未登记的 appendFileSync 必抓;`writeFileSync as sneaky` 改名必抓;
// `import * as fs` + `fs.promises.writeFile` 必抓;多行 import 必抓(勘破 §7.3 正则扫描漏掉的那一形);
// 不是 fs 的同名方法(`store.write(...)`)不算。集合本身也自证:闭包里必须有 sidecar 真 import 的模块,
// 不得有 index.ts(main 进程)或任何测试文件。

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  FS_WRITE_APIS,
  diffLedger,
  isValidRoot,
  parseLedger,
  scanRepository,
  scanWriteSites,
  sidecarSourceFiles,
  signatureOf,
} from "./process-fence-write-sites"

const repoRoot = resolve(import.meta.dir, "../../../..")
const ledgerPath = resolve(repoRoot, "scripts", "process-fence-write-sites.tsv")

describe("AC3 登记簿 == 扫描(生产源码)", () => {
  const sites = scanRepository(repoRoot)
  const ledger = parseLedger(readFileSync(ledgerPath, "utf8"))
  const diff = diffLedger(sites, ledger)

  test("扫描到的写盘调用点数与登记簿都非空(扫到 0 个 = 扫描器瞎了,不是「没有写盘」)", () => {
    expect(sites.length).toBeGreaterThan(40)
    expect(ledger.length).toBeGreaterThan(40)
  })

  test("未登记的写盘调用点 = 0(新增一处写盘必须登记并点名可写集的行)", () => {
    expect(
      diff.unregistered.map((s) => `${signatureOf(s)}  (line ${s.line})`),
      "有写盘调用点没登记 —— 跑 `bun packages/ui-mac/scripts/process-fence-write-sites.ts --write` 生成签名,再把 TODO 改成它落在可写集的哪一行(W-id)。点不出根 = 新的写入根 = 要么给可写集加行(带实测),要么改代码。",
    ).toEqual([])
  })

  test("登记簿里没有源码里已不存在的行,没有重复行", () => {
    expect(diff.stale.map(signatureOf), "登记了源码里没有的写盘点 —— 删掉那一行").toEqual([])
    expect(diff.duplicates).toEqual([])
  })

  test("每一行的根都合法,且没有 TODO", () => {
    expect(diff.invalidRoot.map((r) => `${signatureOf(r)}\t${r.root}`)).toEqual([])
    expect(ledger.filter((r) => r.root === "TODO").map(signatureOf)).toEqual([])
    // `main-only` 只许给 alpha-environment.ts(见 isValidRoot 的说明);别处用它就是给真写入点开豁免。
    expect(ledger.filter((r) => r.root === "main-only" && !r.file.endsWith("alpha-environment.ts")).map(signatureOf)).toEqual([])
  })

  test("集合自证:闭包含 sidecar 真 import 的模块与 ext 全部源码;不含 main 进程入口与测试文件", () => {
    const files = sidecarSourceFiles(repoRoot)
    expect(files).toContain("packages/ui-mac/src/main/sidecar.ts")
    expect(files).toContain("packages/ui-mac/src/main/alpha-config-injection.ts")
    expect(files).toContain("packages/ui-mac/src/main/process-fence-apply.ts")
    expect(files).toContain("packages/ext/src/plugin.ts")
    expect(files).not.toContain("packages/ui-mac/src/main/index.ts")
    expect(files).not.toContain("packages/ui-mac/src/main/server.ts")
    expect(files.filter((f) => f.endsWith(".test.ts") || f.endsWith(".cases.ts"))).toEqual([])
  })
})

describe("控制臂:扫描器测得出已知的坏", () => {
  test("未登记的 appendFileSync 必抓,签名带归一化的第一个实参", () => {
    const src = `import { appendFileSync } from "node:fs"\nexport function f(root: string) {\n  appendFileSync(\n    join(root,   "x.log"), "hi")\n}\n`
    const sites = scanWriteSites("synthetic/a.ts", src)
    expect(sites.map(signatureOf)).toEqual(['synthetic/a.ts\tappendFileSync\tjoin(root, "x.log")'])
    expect(diffLedger(sites, []).unregistered.length).toBe(1)
  })

  test("改名 import(writeFileSync as sneaky)按真名登记 —— 朴素 grep 抓不到,这里抓得到", () => {
    const src = `import { writeFileSync as sneaky } from "fs"\nsneaky("/tmp/x", "y")\n`
    expect(scanWriteSites("synthetic/b.ts", src).map((s) => `${s.api}|${s.firstArg}`)).toEqual(['writeFileSync|"/tmp/x"'])
  })

  test("namespace import 与 promises:fs.promises.writeFile / fsp.mkdir / 默认导入 都抓", () => {
    const src = [
      `import * as fs from "node:fs"`,
      `import fsp from "node:fs/promises"`,
      `import { promises as P } from "node:fs"`,
      `await fs.promises.writeFile(a, "1")`,
      `await fsp.mkdir(b, { recursive: true })`,
      `await P.rm(c)`,
      `fs.readFileSync(d)`, // 读不算
    ].join("\n")
    expect(scanWriteSites("synthetic/c.ts", src).map((s) => `${s.api}|${s.firstArg}`)).toEqual(["writeFile|a", "mkdir|b", "rm|c"])
  })

  test("多行 import(勘破 §7.3 正则漏掉的那一形)照抓", () => {
    const src = `import {\n  existsSync,\n  writeFileSync,\n} from "node:fs"\nwriteFileSync(target, data)\n`
    expect(scanWriteSites("synthetic/d.ts", src).map(signatureOf)).toEqual(["synthetic/d.ts\twriteFileSync\ttarget"])
  })

  test("不是 fs 的同名方法不算(store.write / ws.mkdir);type-only import 不算", () => {
    const src = `import type { WriteStream } from "node:fs"\nconst store = { write: (p: string) => p }\nstore.write("/x")\nws.mkdir("/y")\n`
    expect(scanWriteSites("synthetic/e.ts", src)).toEqual([])
  })

  test("根列合法性:W-id / W-id+W-id / arg / main-only 合法;W9(不存在)/ TODO / 空 非法", () => {
    for (const ok of ["W1", "W2+W6+W1", "arg", "main-only", "W19"]) expect(isValidRoot(ok), ok).toBe(true)
    for (const bad of ["W9", "TODO", "", "W1+W9", "home"]) expect(isValidRoot(bad), bad).toBe(false)
  })

  test("写 API 集合含两套(sync / promises)的核心成员", () => {
    for (const api of ["writeFileSync", "writeFile", "mkdirSync", "mkdir", "renameSync", "rename", "rmSync", "rm", "symlinkSync", "copyFileSync", "createWriteStream"])
      expect(FS_WRITE_APIS.has(api), api).toBe(true)
    expect(FS_WRITE_APIS.has("readFileSync")).toBe(false)
  })
})
