// catalog-source — 定制中心 catalog 的生效来源(REQ-032):remote(验签通过的远端)→ cache
// (上次验签通过的缓存)→ builtin(随包内置,永不空白 B20)。模块级 signal,use-extensions 与
// extension-hub 共同消费;refreshCatalog() 在 hub 打开时调用(main 侧另有启动预热)。
import { createSignal } from "solid-js"
import catalogJson from "./alpha-catalog.json"
import type { BundledCatalogSnapshotV1, Catalog, CatalogEntry } from "./catalog-types"
import { extIpc } from "./ext-ipc"

// REQ-128 不变量(catalog-types.ts):`Catalog.packages` 是 main 评估后的 CatalogPackageViewV1[],
// raw package envelope / payloadRef **绝不进 renderer**。随包快照逐字镜像已签名 release,它的
// `packages` 是 raw `alpha.host-extension-package.v1` envelope(2026-08-25.2 起第一次真的非空,
// ac#1132)—— renderer 没有任何诚实的办法把它当 view 渲染:verdict/action 依赖 main 侧宿主评估,
// 原样喂给 Hub 则挂载即崩(`componentId` 全是 undefined,ac#1136)。所以 builtin 与 IPC 投影
// (projectRemoteCatalogForRenderer)同款显式投影:只带 entries;package 卡片只在 main 评估过的
// IPC 结果落地后出现。离线要不要供 package 卡片是 ac#1136 里的产品决策,不在这里偷跑。
const rawBundled = catalogJson as unknown as BundledCatalogSnapshotV1
const BUNDLED: Catalog = { version: rawBundled.version, entries: rawBundled.entries }

const [catalogSig, setCatalogSig] = createSignal<Catalog>(BUNDLED)
const [sourceSig, setSourceSig] = createSignal<"builtin" | "cache" | "remote">("builtin")

export const catalog = catalogSig
export const catalogSource = sourceSig

/** 条目级版本(远端 catalog 对可安装条目必填;缺失回退全局版本 —— 与内置 catalog 兼容)。 */
export const entryVersion = (e: CatalogEntry | undefined): string => e?.version ?? catalogSig().version

let inflight: Promise<void> | null = null
export function refreshCatalog(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const r = await extIpc.remoteCatalog()
      if (r.source !== "none" && r.catalog && Array.isArray((r.catalog as Catalog).entries)) {
        setCatalogSig(r.catalog as Catalog)
        setSourceSig(r.source)
      }
      // source none → 保持 builtin(B20 永不空白);错误已由 main 记录,hub 顶部不打扰
    } catch {
      /* IPC 失败 → builtin 兜底 */
    } finally {
      inflight = null
    }
  })()
  return inflight
}
