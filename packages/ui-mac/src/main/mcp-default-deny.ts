// #535 / REQ-109 T6,启动可用性基线 §② G1、§③:
// 用户全局 opencode 配置是外部输入面。sidecar fork 时只枚举引擎真实的 XDG 全局目录,
// 把不在 alpha 治理集的 mcp 以 lone `{enabled:false}` 写进末序 OPENCODE_CONFIG_CONTENT;
// 治理内 server 不复制、不改写。项目配置面、上游 MCP 实现均不动。
//
// `OPENCODE_CONFIG_DIR` 会在同一 fork 尾部被 v2 bridge 改指 alpha 自有目录,不能拿它做枚举
// 真源。这里镜像 core Global.Path.config 使用的 xdg-basedir 规则:
// `XDG_CONFIG_HOME || ~/.config`,再拼 `opencode`。读取/解析逐文件 best-effort,任何坏文件只
// loud 跳过自身,不得把 sidecar 上方已经完成的 provider/identity/permission 注入一起炸掉。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse, type ParseError } from "jsonc-parser"

const GLOBAL_CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"]

type Config = { mcp?: Record<string, unknown> }

export function injectMcpDefaultDeny(
  config: Config,
  options: {
    alphaConfigPath: string
    /** 仅测试/隔离注入;生产缺省严格镜像 Global.Path.config,绝不看 OPENCODE_CONFIG_DIR。 */
    userConfigDir?: string
    /** 本轮 injectAlphaConfig 新放入 config.mcp 的名称;不得把继承 env 当成治理来源。 */
    injectedMcpNames?: Iterable<string>
    /** 仅测试注入;生产固定同步读盘,与 sidecar fork 注入时序一致。 */
    readFile?: (file: string) => string
    logError?: (message: string) => void
  },
): void {
  const logError = options.logError ?? ((message: string) => console.error(message))
  try {
    const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"))
    const alpha = readConfig(options.alphaConfigPath, "alpha", readFile, logError)
    const alphaMcp = asRecord(alpha?.mcp)
    const userConfigDir =
      options.userConfigDir ??
      join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
    const globalMcp = GLOBAL_CONFIG_FILES.map((name) =>
      readConfig(join(userConfigDir, name), "user-global", readFile, logError),
    )
      .flatMap((source) => Object.entries(asRecord(source?.mcp)))
      .reduce<Record<string, unknown>>((result, [name, leaf]) => {
        result[name] = { ...asRecord(result[name]), ...asRecord(leaf) }
        return result
      }, Object.create(null) as Record<string, unknown>)
    // #223 R6 Major:治理集只认「alpha.jsonc 里真有的」与「本轮注入面真放进去的」。以前这里写死
    // 一个 `"cloud"` 字面量,于是**不代付时**用户全局配置里一个叫 cloud 的第三方 server 被永久
    // 当成治理来源、连 enabled:false 都不写 —— 名字不是治理凭据。代付两条分支下注入面都会把
    // cloud 放进 injectedMcpNames(kill-switch 下放的是中和条目),治理语义因此不变。
    const governed = new Set([...Object.keys(alphaMcp), ...(options.injectedMcpNames ?? [])])
    const denied = Object.keys(globalMcp)
      .filter((name) => !governed.has(name))
      .sort()

    denied.forEach((name) => setLeaf(config, name, "enabled", false))
    if (denied.length)
      logError(`[req109-535] default-denied user-global MCP names=${JSON.stringify(denied)}`)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    logError(`[req109-535] MCP sovereignty injection skipped (${code ?? "unexpected error"})`)
  }
}

function readConfig(
  file: string,
  role: "alpha" | "user-global",
  readFile: (file: string) => string,
  logError: (message: string) => void,
): Record<string, unknown> | undefined {
  let text: string
  try {
    text = readFile(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      if (role === "alpha") logError(`[req109-535] alpha MCP governance config missing; skipping file ${file}`)
      return
    }
    logError(`[req109-535] unreadable ${role} MCP config skipped: ${file} (${code ?? "read error"})`)
    return
  }

  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) {
    logError(`[req109-535] unparseable ${role} MCP config skipped: ${file} (${errors.length} error(s))`)
    return
  }
  return asRecord(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function setLeaf(config: Config, name: string, field: "enabled", value: boolean): void {
  const map = asRecord(config.mcp)
  config.mcp = {
    ...map,
    [name]: {
      ...asRecord(map[name]),
      [field]: value,
    },
  }
}
