// alpha-code's curated model menu, injected into opencode's config by the sidecar (see
// sidecar.ts -> injectAlphaConfig). Everything here rides opencode's NATIVE config contract, so
// it touches zero upstream source and survives every fork-sync (ADR-005/006/007).
//
// CATALOG DATA (REQ-237 `#1556`):平台模型(id / 计价 / 名称 / 品牌 / 能力 / 档位)只来自已应用的网关目录
// (V3 `display`);BYOK 模型与元数据只来自已应用 BYOK 目录(远程 `GET /v1/byok-catalog`,随包
// ./alpha-models.json 只留首启引导);BYOK 的端点 / Key 名 / 协议适配器只来自 App 内置适配器表
// ./byok-adapters.ts。两份已应用目录由 main 在 fork 前钉住(alpha-live-allowlist.ts pinAppliedCatalog),
// picker 与本函数读同一份。本文件不持有任何目录数据。
//
// The four native levers (runtime: packages/opencode/src/provider/provider.ts):
//   - enabled_providers: HARD allowlist. When set, ONLY these provider ids are visible.
//   - provider.<id>.whitelist: per-provider model allowlist (the only "keep only these" lever;
//     listing under `.models` MERGES with the models.dev catalog instead of restricting).
//   - provider.<id> with { npm, options:{ baseURL, apiKey }, models }: a custom OpenAI-compatible
//     ("@ai-sdk/openai-compatible") / Anthropic ("@ai-sdk/anthropic") gateway.
//   - model: "<providerID>/<modelID>" -- the default selection.
//
// Keys are written as {file:<userData>/alpha-secrets/<VAR>} refs (A6) — opencode resolves them at
// config load (config/variable.ts). The files are materialized by main right before every sidecar
// fork (syncSecretFiles), so "provider is keyed" is now a FILE-presence question, not an env one:
// the sidecar env is allowlisted (sidecar-env.ts) and never carries key values.
//
// Escape hatch: ALPHA_MODELS_DISABLE=1 skips this entirely.

import type { ByokCatalogV1 } from "@alpha-code/contracts-consumer"
import catalog from "./alpha-models.json"
import type { AlphaModelCatalog, ByokProvider } from "../shared/alpha-model-types"
import { byokEngineId, byokModelMeta } from "../shared/alpha-model-types"
import { projectPlatformModels, readAppliedByokCatalog, readAppliedPlatformSnapshot } from "./alpha-live-allowlist"
import { byokAdapter } from "./byok-adapters"
import { customProviderSecretName, hasSecretFile, secretFileRef } from "./alpha-secret-files"
import { readCustomProviderRecords } from "./custom-provider-records"
// NOTE: this module is loaded by the SIDECAR (utilityProcess) via buildAlphaModelConfig, so it must
// stay electron-free. getProviderKeyStatus (which reads the safeStorage keychain) lives in the
// main-only alpha-provider-status.ts for that reason — do NOT import alpha-byok-keys here.

const BUNDLED = catalog as unknown as Pick<AlphaModelCatalog, "defaultModel" | "defaultPlatformModel" | "platformProvider">

/** BYOK 段的**唯一**投影:已应用 BYOK 目录 × App 内置适配器表(方案 §2.3)。provider 身份 / 名称 / preset / 模型 /
 *  逐模型元数据 / 品牌取目录;`compat` / `baseURL` / `keyEnv` 只取适配器表 —— 目录里不认识的 provider 没有适配器,
 *  投影不出来(采纳时已跳过,这里是同一判据的读侧)。 */
export function projectByokProviders(byok: ByokCatalogV1): ByokProvider[] {
  return byok.providers.flatMap((provider): ByokProvider[] => {
    const adapter = byokAdapter(provider.id)
    if (!adapter) return []
    return [
      {
        id: provider.id,
        name: provider.name,
        preset: provider.preset,
        compat: adapter.compat,
        baseURL: adapter.baseURL,
        keyEnv: adapter.keyEnv,
        brand: provider.brand,
        models: provider.models.map((model) => model.id),
        modelMeta: Object.fromEntries(
          provider.models.map((model) => [
            model.id,
            {
              name: model.name,
              ...(model.reasoning ? { reasoning: true } : {}),
              ...(model.variants ? { variants: model.variants } : {}),
            },
          ]),
        ),
        imageInput: Object.fromEntries(provider.models.map((model) => [model.id, model.image_input])),
      },
    ]
  })
}

/** The applied model catalog (picker via getEffectiveCatalog, engine via buildAlphaModelConfig): both segments
 *  come from the catalog pinned before the current fork. */
export function getModelCatalog(userDataPath: string): AlphaModelCatalog {
  const byokProviders = projectByokProviders(readAppliedByokCatalog(userDataPath).byok)
  return {
    defaultModel: BUNDLED.defaultModel,
    defaultPlatformModel: BUNDLED.defaultPlatformModel,
    platformProvider: BUNDLED.platformProvider,
    platformModels: projectPlatformModels(readAppliedPlatformSnapshot(userDataPath)),
    byokProviders,
    presetIds: byokProviders.filter((provider) => provider.preset).map((provider) => provider.id),
  }
}

/** REQ-228 #1420:引擎 config 的 `modalities.input`,引擎据它算 `capabilities.input.image`
 *  (packages/opencode/src/provider/provider.ts 的 config 合并;读它的是 transform.ts unsupportedParts —— 看不了图的模型收到的
 *  图片被换成一句 ERROR)。**每个注入的模型都显式写**,不留给引擎回落:回落的来源是 models.dev 底表里同 provider id 的条目,
 *  托管模式下那是 alpha 自己写的 `modalities.input: []`,开发 / 非托管时是真 models.dev —— 同一个模型两种答案。
 *  `text` 恒在(显式写了 input 之后,引擎对未列出的模态一律判 false)。 */
type InputModalities = { input: Array<"text" | "image"> }
const inputModalities = (image: boolean): InputModalities => ({ input: image ? ["text", "image"] : ["text"] })

type InjectedModel = {
  name: string
  reasoning?: boolean
  variants?: Record<string, Record<string, unknown>>
  modalities: InputModalities
}

export type AlphaModelConfig = {
  enabled_providers: string[]
  model?: string
  provider: Record<string, unknown>
}

export function buildAlphaModelConfig(userDataPath: string): AlphaModelConfig | undefined {
  if (process.env.ALPHA_MODELS_DISABLE === "1") return undefined

  const provider: Record<string, unknown> = {}
  const enabled: string[] = []

  // `#1555` 起读 fork 前钉住的「已应用目录」(alpha-applied-catalog.json),不读后台刷新器随时改写的 LKG ——
  // picker 读同一份,两边永远是同一个版本。平台段:网关 edition 清单 + V3 `display`,没有有效快照 ⇒ 空
  // (`#1556`:随包平台清单已删除)。BYOK 段:已应用 BYOK 目录,从不按账户 / edition 收窄(REQ-109 #595,
  // 契约 docs/contracts/byok-availability.md)。用户自定义节点(下方第 (3) 段,来自真源)不受目录约束。
  const applied = getModelCatalog(userDataPath)
  const platformModels = applied.platformModels

  // (1) BYOK 直连节点 (方案 C): inject each catalog provider that HAS a key (opt-in) as a FULL custom
  // provider — npm/baseURL come from the App's built-in adapter table (`#1556`: never from remote data, so a
  // remote catalog can neither redirect a user's key nor mint a new egress host — network-egress-derived.ts
  // derives the allowlist from these baseURLs), models from the applied BYOK catalog, and the apiKey is a
  // {file:} ref into the secret channel (fed by the alpha keychain / shell / alpha.env via main's
  // syncSecretFiles at fork, A6). No key file → not injected, so the picker only shows keyed BYOK nodes.
  // Calls go DIRECT to the provider's baseURL (never via the gateway).
  for (const p of applied.byokProviders) {
    if (!p.keyEnv || !hasSecretFile(userDataPath, p.keyEnv)) continue
    const npm = p.compat === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
    // REQ-153 #1236:`reasoning` 是引擎 `capabilities.reasoning` 的唯一来源(config schema
    // core/src/v1/config/provider.ts:14,消费 provider/provider.ts:1457;models.dev 对 `<id>-byok`
    // 这个 provider id 没有条目,fallback 恒 false)。不转发 ⇒ transform.variants() 首行 return {}。
    // REQ-153 #1266:`variants`(档位 → 引擎 options)与 picker 的 BYOK 行同一份派生(byokModelMeta),
    // 引擎侧 provider.ts:1503-1507 把它与自己按 npm 派生的档位表 mergeDeep —— 桌面 chip 列出的每个
    // 标签,引擎 `model.variants[variant]` 都查得到。
    // REQ-153 #1267:上游 transform.options() 对 zhipuai* 无条件写 thinking:enabled,`关` 档
    // (`thinking: { type: "disabled" }`)是用户关掉它的唯一途径,而它要能被引擎查到,就必须从这里注入。
    // `#1556`:元数据只来自 BYOK 目录自己,不再借平台同名条目。
    // Inject under a non-models.dev engine id (`<id>-byok`) so opencode's availability gate doesn't
    // filter these out via the models.dev integration collision (see byokEngineId). Display id, key
    // status, gateway allowlist and the key store all keep the plain `p.id`.
    const engineId = byokEngineId(p.id)
    // REQ-228 #1420:能不能看图取 BYOK 目录自己的 `image_input` —— 平台同名条目看不了图是因为网关拒收图片,
    // 不是模型本身不能看;直连不经网关。缺值 ⇒ 看不了图。
    const models: Record<string, InjectedModel> = {}
    for (const m of p.models) {
      const meta = byokModelMeta(applied, engineId, m)
      models[m] = {
        name: m,
        ...(meta.reasoning ? { reasoning: true } : {}),
        ...(meta.variants ? { variants: meta.variants } : {}),
        modalities: inputModalities(p.imageInput[m] === true),
      }
    }
    provider[engineId] = {
      npm,
      name: p.name,
      options: { baseURL: p.baseURL, apiKey: secretFileRef(userDataPath, p.keyEnv) },
      models,
    }
    enabled.push(engineId)
  }

  // (2) ALPHA platform gateway -- a custom OpenAI-compatible provider whose key is fronted by ALPHA
  // (代发). Auto-joins the allowlist (front of list) only once ALPHA_BASE_URL points at the gateway
  // AND the key file exists (a URL with no key would only produce doomed 401 calls).
  // REQ-001:模型清单以已应用的网关目录为准(registry 真实 id + V3 `display`);没有有效快照 ⇒ 节点照注入、
  // 模型表为空(`#1556` AC1:不回退随包清单)。
  if (process.env.ALPHA_BASE_URL && hasSecretFile(userDataPath, "ALPHA_API_KEY")) {
    const pp = applied.platformProvider
    // REQ-127 #681:平台段走与 picker 完全相同的那一份投影。此前这里自制 nameById/variantsById/source
    // 三段装配,于是「什么算有效缓存」有两份定义 —— 空缓存时 picker 给 0 行、引擎配置给静态 9 行。
    // REQ-029:variants(推理档)随投影下发 —— 引擎 request 层 merge 进 options(echo 实验实锤
    // reasoningEffort→reasoning_effort / reasoning:{effort} 原样透传到 harness 请求体)。
    // ⚠️ REQ-153 #1236 实读(2026-09-06,alpha-platform `lib/openai-wire.ts` rebuildOpenAIRequest 生产函数):
    // 网关自 #107 起按显式白名单重组上游 body,**只转发 messages/tools/tool_choice/stop/response_format/
    // temperature/top_p**,`reasoning_effort` / `reasoning` / `thinking` / `top_k` 一律剥掉 ——
    // 「网关 spread 透传」已不成立。平台节点的档位只到 harness 为止;直连 BYOK 节点不经网关,档位真到上游。
    // 引擎配置**不写 pricing**:那是展示用的,不进 opencode 的 provider 契约。
    // REQ-153 #1236:`reasoning` 同样转发(见 BYOK 段注释)。单变量实测:只补这一处,同一条
    // `run --model alpha/glm-5.2 --variant max` 的请求体立刻出现 `"reasoning_effort":"max"`。
    // REQ-228 #1420:平台模型一律看不了图 —— 网关两个聊天入口今天都 400 拒收图片(alpha-platform openai-wire.ts /
    // worker.ts MULTIMODAL_BLOCK_TYPES),哪怕上游模型本身能看。图片走云端识图(#1419),不走聊天入口。
    const models: Record<string, InjectedModel> = {}
    for (const m of platformModels) {
      models[m.id] = {
        name: m.name,
        ...(m.reasoning ? { reasoning: true } : {}),
        ...(m.variants ? { variants: m.variants } : {}),
        modalities: inputModalities(false),
      }
    }
    provider[pp.id] = {
      npm: pp.npm,
      name: pp.name,
      options: { baseURL: process.env.ALPHA_BASE_URL, apiKey: secretFileRef(userDataPath, "ALPHA_API_KEY") },
      models,
    }
    enabled.unshift(pp.id)
  }

  // (3) User-added custom providers (`#1392`, `#1383` 基线 §四 子票 2) — emitted from the `#1391` TRUTH file
  // (`<appData>/alpha-code-state/custom-providers/<env>.json`, main-only writable, outside every fence root),
  // read through custom-provider-records.ts. Each record becomes a FULL block, same shape as the catalog BYOK
  // nodes above (npm / name / options.baseURL / models), so the engine sees the node without any config file
  // taking part, and network-egress-derived.ts (which only reads this injection surface) authorizes exactly
  // that baseURL — one value, two readers, no fork.
  //
  // Config files (alpha.jsonc / <XDG>/opencode / ~/.opencode) contribute NOTHING here any more (基线 I1): every
  // one of them sits inside the seatbelt's writable set, so a provider block written there by the fenced engine
  // tree must neither reach the allowlist nor the injection map. Two mechanisms make that hold end to end:
  // opencode REPLACES (not unions) `enabled_providers` on merge and OPENCODE_CONFIG_CONTENT is merged last, so
  // an id absent from THIS list is dropped by the engine; and a block injected here is complete, so a same-id
  // block in a config file loses `options.baseURL` to ours (same id, later merger wins). Judged end to end
  // (真引擎清单 + 放行集合) in custom-provider-derivation.test.ts.
  //
  // The key never lives in the truth file (REQ-226 `#1343`): main materializes it from the keychain store into
  // `<userData>/alpha-secrets/custom-provider--<id>` at fork (server.ts → syncSecretFiles), and this injection
  // emits `{file:}` only when that file exists; absent ⇒ "" (the engine starts; that provider 401s on first
  // call — fail closed, never a dangling ref: config/variable.ts throws on a missing file).
  // Ids alpha injects itself above (platform / `<id>-byok`) are reserved at add time (ext-config.ts
  // isReservedProviderId), so no record can collide with them; a truth file that fails the strict read yields
  // no records at all (and one log line) — "unanswerable" derives nothing, it does not fall open.
  for (const record of readCustomProviderRecords()) {
    if (Object.prototype.hasOwnProperty.call(provider, record.id)) continue
    const secret = customProviderSecretName(record.id)
    // REQ-228 #1420:只有用户在记录里显式声明的模型能看图(custom-provider-truth.ts `imageInput`);自定义地址上的同名模型
    // 不一定是 models.dev 里那一个,所以不猜。
    const models: Record<string, { name: string; modalities: InputModalities }> = {}
    for (const m of record.models) models[m] = { name: m, modalities: inputModalities(record.imageInput?.includes(m) === true) }
    provider[record.id] = {
      npm: record.compat === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
      name: record.name,
      options: {
        baseURL: record.baseURL,
        apiKey: hasSecretFile(userDataPath, secret) ? secretFileRef(userDataPath, secret) : "",
      },
      models,
    }
    enabled.push(record.id)
  }

  // Default model: env override wins, else catalog default, else none (never force a default whose
  // key may be absent). Format "<providerID>/<modelID>".
  const model = process.env.ALPHA_DEFAULT_MODEL ?? applied.defaultModel ?? undefined

  return {
    enabled_providers: enabled,
    ...(model ? { model } : {}),
    provider,
  }
}
