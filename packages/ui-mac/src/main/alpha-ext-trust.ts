// REQ-060 信任门(项目自带可执行扩展的 per-project consent)—— 纯核。
//
// 语义:项目 `.code-puppy/alpha.jsonc` 的 mcp 与 `.code-puppy/plugins/*.js` 是**可执行物**(打开陌生仓库即
// 在本机跑其代码),@alpha-code/ext 的信任门只在 `.code-puppy/prefs.json` 的 `extensionsConsent.granted
// === true` 时加载它们(plugin.ts:readProjectExtensionsConsent)。本模块负责决策记录的读写语义与
// 可执行物清单派生;弹窗在 ext-ipc(B16/ADR-021 同款分层:纯核可单测,对话框在 IPC 层)。
//
// 决策(granted/denied)都落盘 —— 拒绝 = 该项目仅文本类(skill/agent/command)生效,且不再重复弹。
// 版本化:告知内容实质变更时 bump EXTENSIONS_CONSENT_VERSION → 旧决策失效、重新弹。

import type { ProjectPrefs } from "./alpha-cloud-consent"

export const EXTENSIONS_CONSENT_VERSION = 1

export type ExtensionsConsent = { version: number; granted: boolean; decidedAt: string }

/** 已有当前版本的决策(granted 与 denied 都算)⟺ 不再弹。 */
export function hasExtensionsDecision(prefs: ProjectPrefs): boolean {
  const c = (prefs as { extensionsConsent?: { version?: unknown; granted?: unknown } }).extensionsConsent
  return c?.version === EXTENSIONS_CONSENT_VERSION && typeof c.granted === "boolean"
}

export function extensionsGranted(prefs: ProjectPrefs): boolean {
  const c = (prefs as { extensionsConsent?: { version?: unknown; granted?: unknown } }).extensionsConsent
  return c?.version === EXTENSIONS_CONSENT_VERSION && c.granted === true
}

/** 合并写入决策(保留 prefs 其它字段)。iso 由调用方注入(单测确定性)。 */
export function withExtensionsConsent(prefs: ProjectPrefs, granted: boolean, iso: string): ProjectPrefs {
  return { ...prefs, extensionsConsent: { version: EXTENSIONS_CONSENT_VERSION, granted, decidedAt: iso } }
}

export type ProjectExecutables = { mcp: string[]; plugins: string[] }

/**
 * 从项目 alpha.jsonc 文本 + plugins 目录文件列表派生可执行物清单(供弹窗如实列明「要加载什么」)。
 * jsonc 坏/缺 → mcp 空(与 ext 侧 mergeProjectConfig 的诚实降级一致);plugins 只认 .js(ADR-006)。
 */
export function listProjectExecutables(jsoncText: string | null | undefined, pluginFiles: string[]): ProjectExecutables {
  let mcp: string[] = []
  if (jsoncText) {
    try {
      const parsed: unknown = JSON.parse(stripJsonc(jsoncText))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const m = (parsed as Record<string, unknown>).mcp
        if (m && typeof m === "object" && !Array.isArray(m)) mcp = Object.keys(m as Record<string, unknown>)
      }
    } catch {
      /* 项目文件坏 → 引擎侧也不会注入,无可执行物 */
    }
  }
  return { mcp, plugins: pluginFiles.filter((f) => f.endsWith(".js")) }
}

/** 极简 jsonc → json(与 @alpha-code/ext project-config 同款):去注释 + 尾逗号。 */
function stripJsonc(text: string): string {
  let out = ""
  let inStr = false
  let strCh = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inStr) {
      out += c
      if (c === "\\") {
        out += n ?? ""
        i++
      } else if (c === strCh) inStr = false
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      strCh = c
      out += c
      continue
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (c === "/" && n === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}
