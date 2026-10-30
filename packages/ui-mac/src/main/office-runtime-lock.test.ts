// #1564 AC2:随包 Office 运行时的两份架构 lock 覆盖 requirements.in 五个顶层包的**完整**传递依赖闭包,每条带哈希;
// 运行时本身(python-build-standalone)按 URL + sha256 钉死。
//
// 依赖图来自 office-runtime.lock 的 requires —— 那份图不是手写的替身:build-office-runtime.ts 每次全新安装都把它
// 与已装发行包的 METADATA(按随包解释器求值 marker)逐项比对,不一致即拒绝出产物。判据函数 lockClosureProblems
// 是构建脚本安装前跑的同一个函数。先证明它能红:从真 lock 里删掉一个传递依赖、或塞进一个闭包外的包,它都点名。
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { OFFICE_RUNTIME_LOCK_DIR, lockClosureProblems, parseRequirementsLock, readOfficeRuntimeLock } from "../../scripts/build-office-runtime"

const read = (name: string) => readFileSync(join(OFFICE_RUNTIME_LOCK_DIR, name), "utf8")
const requirementsIn = read("requirements.in")
const lock = readOfficeRuntimeLock()

/** 从 uv pip compile 的输出里删掉一个发行包的整段(pin 行 + 它的 hash 行 + via 注释)。 */
function withoutDistribution(text: string, name: string): string {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.startsWith(`${name}==`))
  if (start < 0) throw new Error(`${name} is not in the lock`)
  const end = lines.findIndex((line, index) => index > start && /^[A-Za-z0-9]/.test(line))
  return [...lines.slice(0, start), ...lines.slice(end < 0 ? lines.length : end)].join("\n")
}

describe("#1564 AC2 bundled Office runtime locks", () => {
  test("requirements.in names exactly the five top-level packages the four formats import, each pinned", () => {
    expect([...parseRequirementsLock(requirementsIn)].map(([name, pin]) => `${name}==${pin.version}`).sort()).toEqual([
      "openpyxl==3.1.5",
      "pypdf==6.16.1",
      "python-docx==1.2.0",
      "python-pptx==1.0.2",
      "reportlab==5.0.0",
    ])
  })

  for (const arch of ["arm64", "x64"] as const) {
    test(`requirements-${arch}.lock is the complete hashed closure of requirements.in`, () => {
      const text = read(`requirements-${arch}.lock`)
      expect(lockClosureProblems(requirementsIn, text, lock.requires)).toEqual([])
      // 闭包实测 11 个发行包(方案 §1.3:五个顶层包只是其中一部分)。
      expect(parseRequirementsLock(text).size).toBe(11)
      // 两份 lock 都由 uv pip compile 按各自的目标平台与 Python 3.11 生成(文件头记着命令)。
      expect(text).toContain(`--python-version 3.11 --python-platform ${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin --generate-hashes`)
    })

    test(`requirements-${arch}.lock: deleting one transitive dependency, or adding one outside the closure, is named`, () => {
      const text = read(`requirements-${arch}.lock`)
      expect(lockClosureProblems(requirementsIn, withoutDistribution(text, "et-xmlfile"), lock.requires)).toEqual([
        "et-xmlfile: required (via office-runtime.lock requires) but missing from the lock",
      ])
      expect(lockClosureProblems(requirementsIn, withoutDistribution(text, "lxml"), lock.requires)).toEqual([
        "lxml: required (via office-runtime.lock requires) but missing from the lock",
      ])
      expect(lockClosureProblems(requirementsIn, `${text}\nsix==1.17.0 \\\n    --hash=sha256:${"0".repeat(64)}\n`, lock.requires)).toEqual([
        "six: in the lock but outside the closure of requirements.in",
      ])
      const unhashed = text.replace(/(xlsxwriter==\S+) \\\n(\s+--hash=sha256:[0-9a-f]{64}( \\)?\n)+/, "$1\n")
      expect(lockClosureProblems(requirementsIn, unhashed, lock.requires)).toEqual(["xlsxwriter: no sha256 hash"])
    })
  }

  test("the runtime itself is a python-build-standalone CPython 3.11 pinned by URL + sha256 per architecture", () => {
    expect(lock.python.version).toMatch(/^3\.11\.\d+$/)
    for (const [arch, triple] of [["arm64", "aarch64-apple-darwin"], ["x64", "x86_64-apple-darwin"]] as const) {
      const pin = lock.python[arch]
      expect(pin.url).toBe(
        `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.python.release}/cpython-${lock.python.version}%2B${lock.python.release}-${triple}-install_only_stripped.tar.gz`,
      )
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(lock.python.arm64.sha256).not.toBe(lock.python.x64.sha256)
  })
})
