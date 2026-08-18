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
// 语义与上游那份一致(超时 reject,由本文件末尾的 catch 归一为 reload-pending),ui-mac 侧
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

export type McpActivationReference = {
  reference: string
  status: "connected" | "disabled" | "failed" | "reload-pending"
}

export type ProjectMcpActivationVerdict = "active" | "shadowed" | "unverifiable"

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
    return isRecord(status) && status.status === "connected" ? "active" : "unverifiable"
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
 * Reload the engine from durable config after an MCP install. This keeps `{file:...}` resolution
 * inside ConfigVariable at config-load time and returns no config or secret bytes to the renderer.
 */
export async function reloadInstalledMcp(
  name: string,
  awaitServer: () => Promise<ServerReadyData>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = { awaitServer: 5_000, dispose: 5_000, status: 10_000 },
): Promise<McpActivationReference> {
  try {
    const server = await withTimeout(
      awaitServer(),
      timeoutMs.awaitServer,
      "timed out waiting for the engine before MCP reload",
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
    const disposed = await withTimeout(
      client.global.dispose(),
      timeoutMs.dispose,
      "timed out disposing the engine before MCP reload",
    )
    if ((disposed as { error?: unknown }).error) return { reference: name, status: "reload-pending" }

    const status = await withTimeout(
      client.mcp.status(),
      timeoutMs.status,
      "timed out reading MCP status after engine reload",
    )
    if ((status as { error?: unknown }).error) return { reference: name, status: "reload-pending" }
    const state = (status as { data?: Record<string, { status?: unknown }> }).data?.[name]?.status
    if (state === "connected") return { reference: name, status: "connected" }
    if (state === "disabled") return { reference: name, status: "disabled" }
    return { reference: name, status: "failed" }
  } catch {
    return { reference: name, status: "reload-pending" }
  }
}
