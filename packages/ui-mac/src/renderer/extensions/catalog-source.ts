// catalog-source — 定制中心 catalog 的生效来源(REQ-032):remote(验签通过的远端)→ cache
// (上次验签通过的缓存)→ builtin(随包内置,永不空白 B20)。模块级 signal,use-extensions 与
// extension-hub 共同消费;refreshCatalog() 在 hub 打开时调用(main 侧另有启动预热)。
import { createSignal } from "solid-js"
import catalogJson from "./alpha-catalog.json"
import type { Catalog, CatalogEntry } from "./catalog-types"
import { extIpc } from "./ext-ipc"

const BUNDLED = catalogJson as unknown as Catalog

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
