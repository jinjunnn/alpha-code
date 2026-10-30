// REQ-236 `#1553` AC2 —— 「本机存一份」:落在会话实例目录的隐藏目录 `attachments/<uuid>/<净化后的文件名>`,≤20 MiB,
// 记录的是相对隐藏目录根的 POSIX 路径;路径逃逸、超限、实例目录不被接纳时如实失败且不留任何文件。
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { attachmentAbsolutePath, MAX_ATTACHMENT_BYTES } from "../shared/attachment-path"
import { PROJECT_HIDDEN_DIR } from "../shared/project-hidden-dir"
import { stageComposerAttachment } from "./composer-attachment-stage"

const temps: string[] = []
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const bytes = (text: string) => new TextEncoder().encode(text)
const STAGED = new RegExp(`^attachments/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/([^/]+)$`)

describe("stageComposerAttachment", () => {
  test("写进 <实例目录>/<隐藏目录>/attachments/<uuid>/<名字>;返回相对隐藏目录根的路径;隐藏目录自带 .gitignore", () => {
    const project = temp("alpha-stage-")
    const result = stageComposerAttachment(project, "季度复盘.docx", "word", bytes("docx-bytes"))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path).toMatch(STAGED)
    expect(result.path.match(STAGED)![1]).toBe("季度复盘.docx")
    const absolute = attachmentAbsolutePath(project, result.path)
    expect(absolute.startsWith(join(project, PROJECT_HIDDEN_DIR, "attachments") + "/")).toBe(true)
    expect(readFileSync(absolute, "utf8")).toBe("docx-bytes")
    expect(readFileSync(join(project, PROJECT_HIDDEN_DIR, ".gitignore"), "utf8")).toBe("*\n")
    // 同名再放一次是另一份(每次一个新 uuid,不覆盖)。
    const again = stageComposerAttachment(project, "季度复盘.docx", "word", bytes("v2"))
    expect(again.ok && again.path !== result.path).toBe(true)
    expect(readFileSync(absolute, "utf8")).toBe("docx-bytes")
  })

  test("名字净化:去掉路径结构与控制字符,dotfile 回退,超长截断后仍以读取工具要求的扩展名结尾", () => {
    const project = temp("alpha-stage-name-")
    const name = (input: string, reader: "word" | "pdf" = "word") => {
      const result = stageComposerAttachment(project, input, reader, bytes("x"))
      if (!result.ok) throw new Error(result.reason)
      return result.path.match(STAGED)![1]
    }
    expect(name("../../evil.docx")).toBe("evil.docx")
    expect(name("a/b\\c.docx")).toBe("c.docx")
    expect(name("bad\u0000\u001fname.docx")).toBe("badname.docx")
    expect(name(".hidden.docx")).toBe("attachment.docx")
    const long = name(`${"长".repeat(200)}.pdf`, "pdf")
    expect(long.length).toBe(128)
    expect(long.endsWith(".pdf")).toBe(true)
    expect(name("扫描件", "pdf")).toBe("扫描件.pdf")
  })

  test("超过 20 MiB 拒绝,且不创建隐藏目录", () => {
    const project = temp("alpha-stage-big-")
    expect(stageComposerAttachment(project, "big.pdf", "pdf", new Uint8Array(MAX_ATTACHMENT_BYTES + 1))).toEqual({ ok: false, reason: "too-large" })
    expect(existsSync(join(project, PROJECT_HIDDEN_DIR))).toBe(false)
    expect(stageComposerAttachment(project, "edge.pdf", "pdf", new Uint8Array(MAX_ATTACHMENT_BYTES)).ok).toBe(true)
  })

  test("路径逃逸:attachments 被换成指向项目外的符号链接 ⇒ 失败,项目外零写入", () => {
    const project = temp("alpha-stage-escape-")
    const outside = temp("alpha-stage-outside-")
    mkdirSync(join(project, PROJECT_HIDDEN_DIR))
    symlinkSync(outside, join(project, PROJECT_HIDDEN_DIR, "attachments"))
    expect(stageComposerAttachment(project, "a.docx", "word", bytes("x"))).toEqual({ ok: false, reason: "not-project" })
    expect(readdirSync(outside)).toEqual([])
  })

  test("实例目录不被接纳(主目录、相对路径、根目录、隐藏目录本身是符号链接)⇒ 失败", () => {
    expect(stageComposerAttachment(homedir(), "a.docx", "word", bytes("x"))).toEqual({ ok: false, reason: "not-project" })
    expect(stageComposerAttachment("relative/dir", "a.docx", "word", bytes("x"))).toEqual({ ok: false, reason: "not-project" })
    expect(stageComposerAttachment("/", "a.docx", "word", bytes("x"))).toEqual({ ok: false, reason: "not-project" })
    const project = temp("alpha-stage-link-")
    const outside = temp("alpha-stage-link-out-")
    symlinkSync(outside, join(project, PROJECT_HIDDEN_DIR))
    expect(stageComposerAttachment(project, "a.docx", "word", bytes("x"))).toEqual({ ok: false, reason: "not-project" })
    expect(readdirSync(outside)).toEqual([])
  })

  test("IPC 入参不合形状 ⇒ invalid(未知读取工具、非字节、非字符串)", () => {
    const project = temp("alpha-stage-invalid-")
    expect(stageComposerAttachment(project, "a.zip", "zip", bytes("x"))).toEqual({ ok: false, reason: "invalid" })
    expect(stageComposerAttachment(project, "a.docx", "toString", bytes("x"))).toEqual({ ok: false, reason: "invalid" })
    expect(stageComposerAttachment(project, "a.docx", "word", "not-bytes")).toEqual({ ok: false, reason: "invalid" })
    expect(stageComposerAttachment(42, "a.docx", "word", bytes("x"))).toEqual({ ok: false, reason: "invalid" })
    expect(existsSync(join(project, PROJECT_HIDDEN_DIR))).toBe(false)
  })
})
