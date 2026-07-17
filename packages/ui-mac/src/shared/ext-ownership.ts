// ext-ownership — REQ-103 slice 1(#195,父 #212 §1):五维所有权 schema 的共享真源。
//
// 五维 = { authored, curated, distributed, runtimeSurfaces, supportTier }(ADR-028 §3)。
// 本模块是枚举值域的唯一定义点:ext-manifest-v2(main)与后续 Hub 扩展清单(inventory)UI(renderer)
// 都从这里取值域与推导规则 —— 同一条扩展在任何面上的五维必须推导一致,不允许各处各推一套。
//
// 来源映射(纯函数,单测锁死):
//   · ownershipFromCatalogEntry —— 内置 catalog 快照(channel "bundled")与 signed channel
//     (channel "remote"/"cache",ed25519 验签,REQ-101)条目;与 ext-install-planner 的
//     manifest 合成共用(planner 从这里导入,不再私有实现)。
//   · ownershipFromSeedAsset —— packaged seed(REQ-102,ext-seed.ts readPackagedSeed)。
//   · ownershipFromInstall —— 本地安装(receipts/records 真源,ext-receipt-v2/alpha-installs):
//     能在当前已验 catalog 解析到条目时按 catalog 推导;解析不到时如实降级
//     (authored=unknown、supportTier=user),绝不向上猜(AC1:curated ≠ authored,不混标)。
//
// 纪律:shared 纯模块 —— 无 node/electron 依赖,renderer 可直接 import(与 office-advisories 同型)。

// ── 值域(#212 §1 显式枚举;扩列 = schema 演进,必须带着单测与消费方一起改)──────────────────

/** 运行面:该扩展的组件实际在哪些位置执行。 */
export const RUNTIME_SURFACES = [
  "engine-process", // 引擎进程内执行 JS(plugin)
  "local-subprocess", // 本机子进程(local MCP)
  "remote-service", // 远程服务(remote MCP)
  "model-context", // 仅注入模型上下文(skill/agent 文本)
  "cloud-pipeline", // 云 pipeline(B 侧执行)
] as const
export type RuntimeSurface = (typeof RUNTIME_SURFACES)[number]

/** 支持等级:谁为这个条目的可用性负责。 */
export const SUPPORT_TIERS = [
  "alpha", // Alpha 自产自支持
  "curated", // 官方上游 + Alpha 策展支持
  "community", // 社区来源,Alpha 只做策展面
  "user", // 用户自装/自负(无策展支持面)
] as const
export type SupportTier = (typeof SUPPORT_TIERS)[number]

/** 分发责任:字节/配置经由哪条通道到达本机。 */
export const DISTRIBUTION_CHANNELS = [
  "bundled", // 随 app 打包(内置资产 / packaged seed)
  "remote-catalog", // 已验 catalog 的远程资产通道(sha256 钉死)
  "npm", // npm registry(钉版)
  "engine-config", // 纯配置条目(custom/catalog MCP)——无字节分发
  "cloud", // 云 pipeline(不落本地字节)
  "local-import", // 用户本地导入(imported/imported-claude/imported-agents)——无分发通道背书
] as const
export type DistributionChannel = (typeof DISTRIBUTION_CHANNELS)[number]

/** authored/curated 维的保留主体名(自由字符串维度中的三个固定语义值)。 */
export const PARTY_ALPHA = "alpha"
export const PARTY_USER = "user"
export const PARTY_UNKNOWN = "unknown"

/** 五维所有权(每个扩展条目可推导;JSON 纯值,IPC 序列化就绪)。 */
export interface OwnershipDims {
  /** 谁写的(catalog source / seed asset source / user / unknown)。 */
  authored: string
  /** 谁策展的(alpha catalog 通道 = "alpha";用户自装 = "user")。 */
  curated: string
  distributed: DistributionChannel
  runtimeSurfaces: RuntimeSurface[]
  supportTier: SupportTier
}

// ── 严格校验(未知键/越域值 loud 拒绝,与 ext-manifest-v2 同纪律)───────────────────────────────

const OWNERSHIP_KEYS = new Set(["authored", "curated", "distributed", "runtimeSurfaces", "supportTier"])
const SURFACE_SET = new Set<string>(RUNTIME_SURFACES)
const TIER_SET = new Set<string>(SUPPORT_TIERS)
const CHANNEL_SET = new Set<string>(DISTRIBUTION_CHANNELS)
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/

export type OwnershipDecode = { ok: true; dims: OwnershipDims } | { ok: false; errors: string[] }

/** STRICT 五维解码:未知键、越域枚举、空 runtimeSurfaces、重复面全部 loud 拒绝(可定位错误)。 */
export function decodeOwnershipDims(input: unknown, at = "ownership"): OwnershipDecode {
  const errors: string[] = []
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [`${at}: required object (authored/curated/distributed/runtimeSurfaces/supportTier)`] }
  }
  const obj = input as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!OWNERSHIP_KEYS.has(key)) errors.push(`${at}: unknown key "${key}" — refused (strict schema, never silently dropped)`)
  }
  const party = (v: unknown, name: string): string | undefined => {
    if (typeof v !== "string" || v.length === 0) {
      errors.push(`${at}.${name}: required non-empty string`)
      return undefined
    }
    if (v.length > 64 || CONTROL_RE.test(v)) {
      errors.push(`${at}.${name}: must be ≤64 chars without control characters`)
      return undefined
    }
    return v
  }
  const authored = party(obj.authored, "authored")
  const curated = party(obj.curated, "curated")
  const distributed = obj.distributed
  if (typeof distributed !== "string" || !CHANNEL_SET.has(distributed))
    errors.push(`${at}.distributed: ${JSON.stringify(distributed)} not in [${DISTRIBUTION_CHANNELS.join(", ")}]`)
  const tier = obj.supportTier
  if (typeof tier !== "string" || !TIER_SET.has(tier))
    errors.push(`${at}.supportTier: ${JSON.stringify(tier)} not in [${SUPPORT_TIERS.join(", ")}]`)
  const surfaces: RuntimeSurface[] = []
  if (!Array.isArray(obj.runtimeSurfaces)) {
    errors.push(`${at}.runtimeSurfaces: required array`)
  } else {
    if (obj.runtimeSurfaces.length === 0) errors.push(`${at}.runtimeSurfaces: must not be empty`)
    const seen = new Set<string>()
    obj.runtimeSurfaces.forEach((s, i) => {
      if (typeof s !== "string" || !SURFACE_SET.has(s)) {
        errors.push(`${at}.runtimeSurfaces[${i}]: ${JSON.stringify(s)} not in [${RUNTIME_SURFACES.join(", ")}]`)
        return
      }
      if (seen.has(s)) {
        errors.push(`${at}.runtimeSurfaces[${i}]: duplicate "${s}"`)
        return
      }
      seen.add(s)
      surfaces.push(s as RuntimeSurface)
    })
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    dims: {
      authored: authored!,
      curated: curated!,
      distributed: distributed as DistributionChannel,
      runtimeSurfaces: surfaces,
      supportTier: tier as SupportTier,
    },
  }
}

// ── 来源映射输入(结构化最小面;CatalogEntry / SeedAsset / InstallRecordV2 结构性满足)──────────

/** catalog 条目推导所需的最小结构(renderer CatalogEntry 结构性满足,shared 不反向依赖 renderer)。 */
export type OwnershipCatalogEntryLike = {
  type: string
  source?: string
  installSpec?: { kind?: string; mcpType?: string; source?: string; vendoredAssetKey?: string }
  remoteAsset?: unknown
}

/** catalog 条目的可信来源通道:remote/cache = signed channel(ed25519);bundled = 随包快照。 */
export type CatalogTrustChannel = "remote" | "cache" | "bundled"

/** kind 级运行面推导(无 installSpec 细节时的诚实默认;mcpType 已知时精确)。 */
export function runtimeSurfacesForKind(kind: string, opts: { mcpType?: string } = {}): RuntimeSurface[] {
  if (kind === "mcp") return opts.mcpType === "remote" ? ["remote-service"] : ["local-subprocess"]
  if (kind === "plugin") return ["engine-process"]
  if (kind === "cloud") return ["cloud-pipeline"]
  return ["model-context"] // skill / agent / command / bundle:仅进模型上下文
}

/** catalog 条目的运行面(与 ext-install-planner 的 manifest 合成共用同一实现)。 */
export function runtimeSurfacesForCatalogEntry(entry: OwnershipCatalogEntryLike): RuntimeSurface[] {
  const spec = entry.installSpec
  return runtimeSurfacesForKind(entry.type, spec?.kind === "mcp" ? { mcpType: spec.mcpType } : {})
}

/** catalog 条目的分发责任(planner 原 distributedFor,逐字义保留)。 */
export function distributionChannelForCatalogEntry(entry: OwnershipCatalogEntryLike, channel: CatalogTrustChannel): DistributionChannel {
  if (entry.type === "mcp") return "engine-config"
  if (entry.type === "cloud") return "cloud"
  if (entry.type === "plugin") {
    const spec = entry.installSpec
    return spec?.kind === "plugin" && spec.vendoredAssetKey ? "bundled" : "npm"
  }
  const spec = entry.installSpec
  if (spec?.source === "remote" || entry.remoteAsset) return "remote-catalog"
  if (spec?.source === "builtin") return "bundled"
  return channel === "bundled" ? "bundled" : "remote-catalog"
}

/** 支持等级 ← 来源(catalog source / seed asset source 共用):alpha/official/community/其余=user。 */
export function supportTierForSource(source: string | undefined): SupportTier {
  if (source === "alpha") return "alpha"
  if (source === "official") return "curated"
  if (source === "community") return "community"
  return "user"
}

/**
 * 内置 catalog 快照(channel "bundled")或 signed channel(channel "remote"/"cache")条目 → 五维。
 * AC1 锚点:authored = 条目来源(official/community/…),curated 恒 "alpha" —— 策展 ≠ 作者,不混标。
 */
export function ownershipFromCatalogEntry(entry: OwnershipCatalogEntryLike, channel: CatalogTrustChannel): OwnershipDims {
  return {
    authored: entry.source ?? PARTY_USER,
    curated: PARTY_ALPHA,
    distributed: distributionChannelForCatalogEntry(entry, channel),
    runtimeSurfaces: runtimeSurfacesForCatalogEntry(entry),
    supportTier: supportTierForSource(entry.source),
  }
}

/**
 * packaged seed 资产(REQ-102,seed lock 恒派生自 stable 已验 catalog)→ 五维。
 * 分发责任恒 "bundled"(字节随 app 包签名到达);策展面 = alpha(seed 是策展 catalog 的打包切片)。
 */
export function ownershipFromSeedAsset(asset: { type: string; source: string }): OwnershipDims {
  return {
    authored: asset.source,
    curated: PARTY_ALPHA,
    distributed: "bundled",
    runtimeSurfaces: runtimeSurfacesForKind(asset.type),
    supportTier: supportTierForSource(asset.source),
  }
}

/** 本地安装推导所需的最小结构(InstallRecordV2 与 v1 InstallReceipt 结构性满足)。 */
export type OwnershipInstallLike = {
  /** catalog entry id 或 `user:<name>`。 */
  id: string
  kind: string
  origin: string
}

/**
 * 本地安装(receipts/records 真源)→ 五维。
 *   · resolved 给定(安装 id 在当前已验 catalog 仍可解析)→ 按 catalog 推导(与浏览面一致);
 *   · origin=catalog 但条目已从 catalog 消失 → 如实降级:authored=unknown(不猜作者)、
 *     curated 保留 alpha(安装当时经 alpha 策展通道,origin 为 main 落账事实)、
 *     supportTier=user(策展支持面已不可达 —— 绝不向上猜 official/community);
 *   · created(自定义 MCP)/ imported*(npm/本地导入)→ authored=curated=user,
 *     分发责任按 kind 如实(engine-config / npm / local-import),supportTier=user。
 */
export function ownershipFromInstall(
  install: OwnershipInstallLike,
  resolved?: { entry: OwnershipCatalogEntryLike; channel: CatalogTrustChannel },
): OwnershipDims {
  if (resolved) return ownershipFromCatalogEntry(resolved.entry, resolved.channel)
  if (install.origin === "catalog") {
    return {
      authored: PARTY_UNKNOWN,
      curated: PARTY_ALPHA,
      distributed: fallbackChannelForKind(install.kind),
      runtimeSurfaces: runtimeSurfacesForKind(install.kind),
      supportTier: "user",
    }
  }
  return {
    authored: PARTY_USER,
    curated: PARTY_USER,
    distributed: install.origin === "created" ? "engine-config" : install.kind === "plugin" && install.origin === "imported" ? "npm" : "local-import",
    runtimeSurfaces: runtimeSurfacesForKind(install.kind),
    supportTier: "user",
  }
}

/** catalog 条目消失后的分发通道兜底(按 kind 的既有事实;不假装知道资产形态)。 */
function fallbackChannelForKind(kind: string): DistributionChannel {
  if (kind === "mcp") return "engine-config"
  if (kind === "cloud") return "cloud"
  if (kind === "plugin") return "npm"
  return "remote-catalog"
}
