import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { parse, type ParseError } from "jsonc-parser"
import { isExtensionName } from "../shared/extension-name"
import { assertProjectAlphaRootIdentity, resolveProjectAlphaRoot } from "./alpha-workdir"
import { listConfiguredMcpServerNamesStrict } from "./ext-config"
// 刻意不从 `packages/opencode/src/util/timeout` import:那是 UPSTREAM_PATHS 下持续滚动重钉的
// vendored 上游,深 import 它的内部模块路径 = 下次 pin bump 上游改名就打断主进程构建。
// 语义与上游那份一致(超时 reject,由本文件末尾的 catch 归一为 unverifiable),ui-mac 侧
// 另有两份同形态的本地实现(use-extensions.ts:225、wsl/runtime.ts:395)。
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    }),
  ])
}
import type { ServerReadyData } from "../preload/types"

export type ProjectMcpActivationVerdict = "active" | "shadowed" | "pending" | "unverifiable"

/**
 * Prove that a live MCP status belongs to D's durable project leaf before consulting the
 * otherwise name-only status map. The projection is deliberately closed: no config, path, or
 * status bytes cross this main-owned boundary.
 */
export async function probeProjectMcpActivation(
  name: string,
  directory: string,
  awaitServer: () => Promise<ServerReadyData>,
  options: {
    fetch?: typeof fetch
    timeoutMs?: { awaitServer: number; globalConfig: number; effectiveConfig: number; status: number }
    configuredGlobalNames?: typeof listConfiguredMcpServerNamesStrict
  } = {},
): Promise<ProjectMcpActivationVerdict> {
  if (!isExtensionName(name)) return "unverifiable"
  const project = resolveProjectAlphaRoot(directory)
  if (project.status !== "project") return "unverifiable"

  const durable = readDurableProjectMcpLeaf(project.root, name)
  if (!durable.ok || durable.value === undefined) return "unverifiable"

  const configured = (options.configuredGlobalNames ?? listConfiguredMcpServerNamesStrict)()
  if (!configured.ok) return "unverifiable"
  if (configured.names.includes(name)) return "shadowed"

  const injected = injectedGlobalMcpLeaf(name)
  if (!injected.ok) return "unverifiable"
  if (injected.value !== undefined) return "shadowed"

  const timeoutMs = options.timeoutMs ?? {
    awaitServer: 5_000,
    globalConfig: 5_000,
    effectiveConfig: 5_000,
    status: 10_000,
  }
  try {
    const server = await withTimeout(
      awaitServer(),
      timeoutMs.awaitServer,
      "timed out waiting for the engine before project MCP activation probe",
    )
    const client = createOpencodeClient({
      baseUrl: server.url,
      fetch: options.fetch ?? fetch,
      headers:
        server.username || server.password
          ? {
              Authorization: `Basic ${Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString(
                "base64",
              )}`,
            }
          : undefined,
    })

    // `/global/config` covers the engine's global config service; the strict main-side name read
    // above additionally covers Alpha's OPENCODE_CONFIG truth and retained legacy files.
    const globalResponse = responseData(
      await withTimeout(
        client.global.config.get(),
        timeoutMs.globalConfig,
        "timed out reading global config for project MCP activation probe",
      ),
    )
    if (!globalResponse.ok) return "unverifiable"
    const global = mcpLeafFromConfig(globalResponse.data, name)
    if (!global.ok) return "unverifiable"
    if (global.value !== undefined) return "shadowed"

    const effectiveResponse = responseData(
      await withTimeout(
        client.config.get({ directory: project.projectDir }),
        timeoutMs.effectiveConfig,
        "timed out reading effective project config for MCP activation probe",
      ),
    )
    if (!effectiveResponse.ok) return "unverifiable"
    const effective = mcpLeafFromConfig(effectiveResponse.data, name)
    if (!effective.ok) return "unverifiable"
    if (effective.value === undefined || !isDeepStrictEqual(effective.value, durable.value)) return "shadowed"

    // Only a provenance-proven D leaf may consult the name-keyed live status map, and the request
    // itself remains directory-scoped. All non-connected/ambiguous outcomes collapse closed.
    const statusResponse = responseData(
      await withTimeout(
        client.mcp.status({ directory: project.projectDir }),
        timeoutMs.status,
        "timed out reading directory-scoped MCP status",
      ),
    )
    if (!statusResponse.ok || !isRecord(statusResponse.data)) return "unverifiable"
    const status = statusResponse.data[name]
    if (isRecord(status) && status.status === "connected") return "active"
    // `#1563`:引擎还在后台启动这台服务 —— 准备中,不是「核验不了」。
    if (isRecord(status) && status.status === "pending") return "pending"
    return "unverifiable"
  } catch {
    return "unverifiable"
  }
}

function readDurableProjectMcpLeaf(
  projectRoot: string,
  name: string,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  try {
    assertProjectAlphaRootIdentity(projectRoot)
    const target = join(projectRoot, "alpha.jsonc")
    const stat = lstatSync(target)
    if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false }
    const errors: ParseError[] = []
    const config: unknown = parse(readFileSync(target, "utf8"), errors, { allowTrailingComma: true })
    if (errors.length > 0) return { ok: false }
    return mcpLeafFromConfig(config, name)
  } catch {
    return { ok: false }
  }
}

function injectedGlobalMcpLeaf(
  name: string,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  const content = process.env.OPENCODE_CONFIG_CONTENT
  if (content === undefined) return { ok: true, value: undefined }
  const errors: ParseError[] = []
  const config: unknown = parse(content, errors, { allowTrailingComma: true })
  if (errors.length > 0) return { ok: false }
  return mcpLeafFromConfig(config, name)
}

function mcpLeafFromConfig(
  config: unknown,
  name: string,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  if (!isRecord(config)) return { ok: false }
  if (config.mcp === undefined) return { ok: true, value: undefined }
  if (!isRecord(config.mcp)) return { ok: false }
  const leaf = config.mcp[name]
  if (leaf === undefined) return { ok: true, value: undefined }
  return isRecord(leaf) ? { ok: true, value: leaf } : { ok: false }
}

function responseData(response: unknown): { ok: true; data: unknown } | { ok: false } {
  if (!isRecord(response) || response.error !== undefined || !Object.hasOwn(response, "data"))
    return { ok: false }
  return { ok: true, data: response.data }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * `#1529`(基线 §2.5 / §2.6):只剩**核验**那一半 —— 读某目录引擎实例里这个 MCP 的连接状态。
 * 重载不再在这里做:安装体改为经 reload-coordinator 请 ext 调度器重载(等会话空闲)。
 * 只返回状态,不返回任何配置或密钥字节。读不出(超时 / HTTP 错误 / 形状不对)= `unverifiable`。
 */
export type McpVerification = {
  reference: string
  /**
   * `needs_auth` / `needs_client_registration` 原样透传(`#1531`):重载修不好它们,呈现面据此不出「现在重载」。
   * `pending`(`#1563`,与上游 v2 同名):引擎在后台启动这台服务,是「准备中」而不是失败,同样不出「现在重载」。
   */
  status: "connected" | "pending" | "disabled" | "failed" | "needs_auth" | "needs_client_registration" | "unverifiable"
  /** `pending` 时引擎带出的上一次失败原因(只在后台重连时有,`#1563`)。 */
  lastFailure?: string
}

export async function verifyInstalledMcp(
  name: string,
  directory: string,
  awaitServer: () => Promise<ServerReadyData>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = { awaitServer: 5_000, status: 10_000 },
): Promise<McpVerification> {
  try {
    const server = await withTimeout(
      awaitServer(),
      timeoutMs.awaitServer,
      "timed out waiting for the engine before MCP verification",
    )
    const client = createOpencodeClient({
      baseUrl: server.url,
      fetch: fetchImpl,
      headers:
        server.username || server.password
          ? {
              Authorization: `Basic ${Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString(
                "base64",
              )}`,
            }
          : undefined,
    })
    const status = await withTimeout(
      client.mcp.status({ directory }),
      timeoutMs.status,
      "timed out reading directory-scoped MCP status",
    )
    if ((status as { error?: unknown }).error) return { reference: name, status: "unverifiable" }
    const entry = (status as { data?: Record<string, { status?: unknown; error?: unknown }> }).data?.[name]
    const state = entry?.status
    if (state === "connected") return { reference: name, status: "connected" }
    if (state === "pending")
      return {
        reference: name,
        status: "pending",
        ...(typeof entry?.error === "string" ? { lastFailure: entry.error } : {}),
      }
    if (state === "disabled") return { reference: name, status: "disabled" }
    if (state === "needs_auth" || state === "needs_client_registration") return { reference: name, status: state }
    return { reference: name, status: "failed" }
  } catch {
    return { reference: name, status: "unverifiable" }
  }
}
