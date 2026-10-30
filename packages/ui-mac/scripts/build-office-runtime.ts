#!/usr/bin/env bun
// build-office-runtime — #1564:Word / Excel / PowerPoint / PDF 四个随包文档工具自带的 Python 运行环境。
//
// 为什么随包:正式版里这四个工具原先用 `uv run --with <库>` 启动 —— 要用户自己装 uv,第一次用还要联网
// 现下依赖,慢且常超时,安装入口也因为没装 uv 直接拒装(方案 docs/design/req236-engine-lifecycle.md §1.3 / §2.4)。
// 现在 main 模板的命令是 `<Resources>/office-runtime/bin/python3 -I -B <Resources>/office-mcp/server.py <格式> {workspace}`,
// 本脚本产出的就是那个 `office-runtime/`(每个目标架构一份,落 native/office-runtime/build/<arch>/,
// electron-builder 的 extraResources 把它装进包)。
//
// 步骤(任何一步失败都删掉半成品再抛 —— 半成品比没有更坏,会被当成「装好了」):
//   1. 下载 resources/office-runtime/office-runtime.lock 钉住的 python-build-standalone 包,sha256 不符即拒;
//   2. 用那个解释器 `pip install --require-hashes --only-binary=:all: -r requirements-<arch>.lock`
//      (不加 --no-deps:哈希模式下闭包缺一个依赖 pip 就拒装)+ `pip check`;
//   3. 已装发行包的版本与 Requires-Dist(按本解释器求值 marker)必须与 lock 逐项相同 —— 依赖图是
//      office-runtime-lock.test.ts 判 lock 闭包完整的依据,这里保证那份图不是手写的替身;
//   4. 删掉 test/、tkinter、idlelib、ensurepip、pip;compileall 预编译(unchecked-hash:拷贝改了 mtime 也照用,
//      运行时 `-B` 不写回包里);
//   5. 验证真实能力(AC2):随包解释器 `-I` 逐个 import 闭包内每个发行包的顶层模块;再按生产命令形状经 stdio
//      驱动 server.py,四种格式各「写一个样例文件再读回」并比对内容 —— 只握手不算;
//   6. 每个 Mach-O 含目标架构片(与 beforePack 同一判据),打印本架构的实际体积。
// lock 与本脚本都没变时跳过 1–4(产物戳记),5–6 每次都跑。
//
// x64 产物在 arm64 宿主上用 `arch -x86_64`(Rosetta)执行同样的安装与验证;解释器跑不起来就响亮失败,不跳过。
// 只在 darwin 上构建;别的平台打印一行并 no-op(随包运行时只进 mac 包)。
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { ALPHA_OFFICE_PYTHON_SLOT, ALPHA_OFFICE_SERVER_SLOT, WORKSPACE_MARKER, alphaOfficeInstallCommand } from "../src/shared/office-advisories"
import { OFFICE_RUNTIME_BUILD_DIR, checkOfficeRuntime, machOArchs, resolveTargetArch, type TargetArch } from "./target-arch"

const scriptPath = fileURLToPath(import.meta.url)
const packageDir = resolve(dirname(scriptPath), "..")
export const OFFICE_RUNTIME_LOCK_DIR = join(packageDir, "resources", "office-runtime")
const SERVER = join(packageDir, "resources", "office-mcp", "server.py")
const CACHE_DIR = join(packageDir, "native", "office-runtime", "cache")
const STAMP = ".office-runtime-stamp"
const TRIMMED = ["test", "tkinter", "idlelib", "ensurepip"]

export const officeRuntimeDir = (arch: TargetArch) => join(packageDir, OFFICE_RUNTIME_BUILD_DIR, arch)

export type OfficeRuntimeLock = {
  python: { version: string; release: string } & Record<TargetArch, { url: string; sha256: string }>
  requires: Record<string, string[]>
}

export const readOfficeRuntimeLock = (): OfficeRuntimeLock =>
  JSON.parse(readFileSync(join(OFFICE_RUNTIME_LOCK_DIR, "office-runtime.lock"), "utf8"))

/** PEP 503 名字归一:`typing_extensions` / `Typing.Extensions` → `typing-extensions`。 */
export const normalizeDistName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-")

/** `name==version \` + `--hash=sha256:…` 行(uv pip compile 的输出形状);注释与空行忽略。 */
export function parseRequirementsLock(text: string): Map<string, { version: string; hashes: string[] }> {
  const out = new Map<string, { version: string; hashes: string[] }>()
  let current: { version: string; hashes: string[] } | undefined
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").replace(/\\\s*$/, "").trim()
    if (!line) continue
    const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)$/.exec(line)
    if (pin) {
      current = { version: pin[2]!, hashes: [] }
      out.set(normalizeDistName(pin[1]!), current)
      continue
    }
    const hash = /^--hash=sha256:([0-9a-f]{64})$/.exec(line)
    if (hash && current) {
      current.hashes.push(hash[1]!)
      continue
    }
    throw new Error(`unrecognised requirements lock line: ${raw}`)
  }
  return out
}

/**
 * #1564 AC2:一份架构 lock 必须恰好是 requirements.in 五个顶层包的完整传递闭包 —— 顶层版本与 requirements.in 一致,
 * 沿 office-runtime.lock 的 requires 图走到的每个发行包都在 lock 里,lock 里没有图外的包,每条都带 sha256。
 * 返回问题清单(空 = 通过)。删掉 lock 里任何一个传递依赖,这里就点名它。
 */
export function lockClosureProblems(requirementsIn: string, lockText: string, requires: Record<string, string[]>): string[] {
  const tops = parseRequirementsLock(requirementsIn)
  const locked = parseRequirementsLock(lockText)
  const closure = new Set<string>()
  const pending = [...tops.keys()]
  while (pending.length) {
    const name = pending.pop()!
    if (closure.has(name)) continue
    closure.add(name)
    pending.push(...(requires[name] ?? []))
  }
  return [
    ...[...tops].filter(([name, pin]) => locked.get(name)?.version !== pin.version).map(([name, pin]) => `${name}: requirements.in pins ${pin.version}, lock has ${locked.get(name)?.version ?? "nothing"}`),
    ...[...closure].filter((name) => !locked.has(name)).map((name) => `${name}: required (via office-runtime.lock requires) but missing from the lock`),
    ...[...locked.keys()].filter((name) => !closure.has(name)).map((name) => `${name}: in the lock but outside the closure of requirements.in`),
    ...[...closure].filter((name) => !(name in requires)).map((name) => `${name}: office-runtime.lock requires has no entry`),
    ...[...locked].filter(([, entry]) => entry.hashes.length === 0).map(([name]) => `${name}: no sha256 hash`),
  ]
}

export type OfficeRuntimeBuild = { dir: string; arch: TargetArch; reused: boolean; bytes: number; files: number; machO: number; modules: string[] }

export function buildOfficeRuntime(options: { arch?: TargetArch } = {}): OfficeRuntimeBuild {
  if (process.platform !== "darwin") throw new Error("the bundled Office runtime builds on darwin only")
  const arch = options.arch ?? resolveTargetArch()
  const dir = officeRuntimeDir(arch)
  const lock = readOfficeRuntimeLock()
  const requirementsPath = join(OFFICE_RUNTIME_LOCK_DIR, `requirements-${arch}.lock`)
  const lockText = readFileSync(requirementsPath, "utf8")
  const closure = lockClosureProblems(readFileSync(join(OFFICE_RUNTIME_LOCK_DIR, "requirements.in"), "utf8"), lockText, lock.requires)
  if (closure.length) throw new Error(`requirements-${arch}.lock is not the closure of requirements.in:\n  - ${closure.join("\n  - ")}`)
  const locked = parseRequirementsLock(lockText)
  const stamp = createHash("sha256")
    .update(readFileSync(join(OFFICE_RUNTIME_LOCK_DIR, "office-runtime.lock")))
    .update(readFileSync(requirementsPath))
    .update(readFileSync(scriptPath))
    .digest("hex")
  const reused = readText(join(dir, STAMP)) === stamp
  if (!reused) install({ arch, dir, lock, requirementsPath, locked, stamp })
  const modules = verify(dir, arch, locked)
  const size = measure(dir)
  console.log(
    `[alpha:office-runtime] ${arch}: ${(size.bytes / 1024 / 1024).toFixed(1)} MB (${size.files} files, ${size.machO} Mach-O, ${modules.length} top-level modules imported, 4 formats round-tripped)${reused ? " [reused]" : ""} at ${dir}`,
  )
  return { dir, arch, reused, ...size, modules }
}

function install(input: {
  arch: TargetArch
  dir: string
  lock: OfficeRuntimeLock
  requirementsPath: string
  locked: Map<string, { version: string; hashes: string[] }>
  stamp: string
}) {
  const staging = `${input.dir}.staging`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    run("tar", ["-xzf", download(input.lock.python[input.arch]), "-C", staging])
    const root = join(staging, "python")
    const python = [...interpreter(input.arch), join(root, "bin", "python3"), "-I"]
    const pipInstall = [...python, "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-input", "--require-hashes", "--only-binary=:all:", "-r", input.requirementsPath]
    retry(3, () => run(pipInstall[0]!, pipInstall.slice(1)))
    run(python[0]!, [...python.slice(1), "-m", "pip", "--isolated", "check"])
    assertInstalledMatchesLock(python, input.locked, input.lock.requires)
    const stdlib = join(root, "lib", "python3.11")
    for (const name of TRIMMED) rmSync(join(stdlib, name), { recursive: true, force: true })
    for (const entry of readdirSync(join(stdlib, "site-packages")))
      if (entry === "pip" || /^pip-.*\.dist-info$/.test(entry)) rmSync(join(stdlib, "site-packages", entry), { recursive: true, force: true })
    for (const entry of readdirSync(join(root, "bin"))) if (/^pip(3(\.\d+)?)?$/.test(entry)) rmSync(join(root, "bin", entry))
    run(python[0]!, [...python.slice(1), "-m", "compileall", "-q", "-j", "0", "--invalidation-mode", "unchecked-hash", stdlib])
    writeFileSync(join(root, STAMP), input.stamp)
    rmSync(input.dir, { recursive: true, force: true })
    renameSync(root, input.dir)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** 已装 = lock(名字与版本逐项),且每个发行包按本解释器求值后的 Requires-Dist = office-runtime.lock 的 requires。 */
function assertInstalledMatchesLock(python: string[], locked: Map<string, { version: string }>, requires: Record<string, string[]>) {
  const script = [
    "import importlib.metadata as md, json, re, sys",
    "from pip._vendor.packaging.requirements import Requirement",
    "norm = lambda n: re.sub(r'[-_.]+', '-', n).lower()",
    "out = {}",
    "for name in json.loads(sys.argv[1]):",
    "    d = md.distribution(name)",
    "    reqs = [Requirement(r) for r in (d.requires or [])]",
    "    out[name] = {'version': d.version, 'requires': sorted({norm(r.name) for r in reqs if r.marker is None or r.marker.evaluate({'extra': ''})})}",
    "print(json.dumps(out, sort_keys=True))",
  ].join("\n")
  const names = [...locked.keys()].sort()
  const actual = JSON.parse(run(python[0]!, [...python.slice(1), "-c", script, JSON.stringify(names)])) as Record<string, { version: string; requires: string[] }>
  const problems = names.flatMap((name) => {
    const found = actual[name]!
    const want = [...(requires[name] ?? [])].sort()
    return [
      ...(found.version !== locked.get(name)!.version ? [`${name}: installed ${found.version}, locked ${locked.get(name)!.version}`] : []),
      ...(JSON.stringify(found.requires) !== JSON.stringify(want) ? [`${name}: METADATA requires ${JSON.stringify(found.requires)}, office-runtime.lock says ${JSON.stringify(want)}`] : []),
    ]
  })
  const extra = Object.keys(requires).filter((name) => !locked.has(name))
  if (extra.length) problems.push(`office-runtime.lock requires lists distributions the lock does not install: ${extra.join(", ")}`)
  if (problems.length)
    throw new Error(
      `installed Office runtime disagrees with its locks:\n  - ${problems.join("\n  - ")}\n` +
        `actual requires (for office-runtime.lock): ${JSON.stringify(Object.fromEntries(names.map((name) => [name, actual[name]!.requires])))}`,
    )
}

/** AC2 + AC5 的构建期判据:Mach-O 片、顶层模块逐个 import、四格式写后读回。返回 import 过的模块名。 */
function verify(dir: string, arch: TargetArch, locked: Map<string, unknown>): string[] {
  const slices = checkOfficeRuntime(dir, arch)
  if (slices.length) throw new Error(`office runtime ${arch} has wrong slices:\n  - ${slices.join("\n  - ")}`)
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "alpha-office-runtime-verify-")))
  try {
    // 干净环境:没有用户的 PATH / HOME,证明不靠本机装的 python、uv 或缓存。
    const env = { PATH: "/usr/bin:/bin", HOME: workspace, TMPDIR: workspace, LANG: "en_US.UTF-8" }
    const python = [...interpreter(arch), join(dir, "bin", "python3"), "-I", "-B"]
    const importScript = [
      "import importlib, importlib.metadata as md, json, sys",
      "mods = []",
      "for name in json.loads(sys.argv[1]):",
      "    tops = set()",
      "    for f in md.distribution(name).files or []:",
      "        head = f.parts[0]",
      "        if head.endswith(('.dist-info', '.data')) or head in ('..', '__pycache__', 'bin'): continue",
      "        if len(f.parts) > 1: tops.add(head)",
      "        elif head.endswith('.py'): tops.add(head[:-3])",
      "        elif head.endswith('.so'): tops.add(head.split('.')[0])",
      "    if not tops: raise SystemExit(f'{name}: no top-level module found')",
      "    for mod in sorted(tops):",
      "        importlib.import_module(mod)",
      "        mods.append(mod)",
      "print(json.dumps(mods))",
    ].join("\n")
    const modules = JSON.parse(run(python[0]!, [...python.slice(1), "-c", importScript, JSON.stringify([...locked.keys()].sort())], { env, cwd: workspace })) as string[]
    for (const sample of roundTrips(workspace)) {
      const requests = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "build-office-runtime", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: sample.write[0], arguments: sample.write[1] } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: sample.read[0], arguments: sample.read[1] } },
      ]
      // 生产命令本身(main 模板,三个槽按 main 的方式替换),不是手写的一份近似。
      const command = [
        ...interpreter(arch),
        ...alphaOfficeInstallCommand(sample.format).map((argument) =>
          argument === ALPHA_OFFICE_PYTHON_SLOT ? join(dir, "bin", "python3") : argument === ALPHA_OFFICE_SERVER_SLOT ? SERVER : argument === WORKSPACE_MARKER ? workspace : argument,
        ),
      ]
      const stdout = run(command[0]!, command.slice(1), {
        env,
        cwd: workspace,
        input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
      })
      const replies = stdout.trim().split("\n").map((line) => JSON.parse(line) as { id?: number; result?: { isError?: boolean; content?: Array<{ text: string }> } })
      const result = (id: number) => {
        const reply = replies.find((candidate) => candidate.id === id)
        if (!reply?.result || reply.result.isError) throw new Error(`${sample.format} ${id === 2 ? sample.write[0] : sample.read[0]} failed: ${JSON.stringify(reply)}`)
        return JSON.parse(reply.result.content?.[0]?.text ?? "null") as Record<string, unknown>
      }
      result(2)
      const read = JSON.stringify(result(3))
      for (const text of sample.expect) if (!read.includes(text)) throw new Error(`${sample.format} read back ${read} without ${JSON.stringify(text)}`)
    }
    return modules
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

/** 与 office-mcp.test.ts 同形的工具参数;expect = 读回结果里必须出现的写入内容。 */
function roundTrips(workspace: string) {
  return [
    { format: "word", write: ["write_docx", { path: join(workspace, "sample.docx"), title: "Runtime check", paragraphs: ["文档工具随包运行"] }], read: ["read_docx", { path: join(workspace, "sample.docx") }], expect: ["Runtime check", "文档工具随包运行"] },
    { format: "excel", write: ["write_xlsx", { path: join(workspace, "sample.xlsx"), sheets: [{ name: "Data", cells: { A1: "Item", B1: 1564 } }] }], read: ["read_xlsx", { path: join(workspace, "sample.xlsx") }], expect: ['"Item"', "1564"] },
    { format: "powerpoint", write: ["write_pptx", { path: join(workspace, "sample.pptx"), slides: [{ title: "Runtime check", body: ["Bundled"] }] }], read: ["read_pptx", { path: join(workspace, "sample.pptx") }], expect: ["Runtime check", "Bundled"] },
    { format: "pdf", write: ["write_pdf", { path: join(workspace, "sample.pdf"), pages: ["Runtime check page"] }], read: ["read_pdf", { path: join(workspace, "sample.pdf") }], expect: ["Runtime check page"] },
  ] as const
}

/** 目标架构在本机怎么执行:同架构直接跑;arm64 宿主上的 x64 走 Rosetta。别的组合跑不起来,响亮失败。 */
function interpreter(arch: TargetArch): string[] {
  if (arch === process.arch) return []
  if (arch === "x64" && process.arch === "arm64") return ["arch", "-x86_64"]
  throw new Error(`cannot execute the ${arch} Office runtime on a ${process.arch} host`)
}

function download(pin: { url: string; sha256: string }): string {
  mkdirSync(CACHE_DIR, { recursive: true })
  const file = join(CACHE_DIR, `${pin.sha256}.tar.gz`)
  if (!existsSync(file) || sha256(file) !== pin.sha256) {
    const partial = `${file}.partial`
    rmSync(partial, { force: true })
    run("curl", ["-fsSL", "--retry", "4", "--retry-all-errors", "--retry-delay", "3", "--max-time", "600", "-o", partial, pin.url])
    const got = sha256(partial)
    if (got !== pin.sha256) {
      rmSync(partial, { force: true })
      throw new Error(`${pin.url}: sha256 ${got} != locked ${pin.sha256}`)
    }
    renameSync(partial, file)
  }
  return file
}

function measure(dir: string) {
  let bytes = 0
  let files = 0
  let machO = 0
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      if (!entry.isFile()) continue
      files++
      bytes += lstatSync(path).size
      if (machOArchs(readFileSync(path).subarray(0, 4096))) machO++
    }
  }
  walk(dir)
  return { bytes, files, machO }
}

function retry<T>(attempts: number, action: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return action()
    } catch (error) {
      if (attempt >= attempts) throw error
      console.warn(`[alpha:office-runtime] attempt ${attempt}/${attempts} failed, retrying: ${error instanceof Error ? error.message.split("\n")[0] : error}`)
    }
  }
}

function run(cmd: string, args: string[], options: { env?: Record<string, string>; cwd?: string; input?: string } = {}): string {
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe", maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} exited ${result.status ?? result.signal}:\n${result.stderr || result.error?.message || ""}`)
  return result.stdout
}

function sha256(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function readText(file: string) {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined
}

if (import.meta.main) {
  if (process.platform !== "darwin") console.log(`[alpha:office-runtime] skipped on ${process.platform} — the bundled Office runtime ships in mac packages only`)
  else buildOfficeRuntime()
}
