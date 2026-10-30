// REQ-237 `#1556`(方案 docs/design/req236-catalog-and-model.md §2.3)—— BYOK 的 **App 内置适配器表**。
//
// 决定「用户的 Key 发去哪」的三样东西只在这里:端点 `baseURL`、Key 名 `keyEnv`(钥匙串 → env → 密钥文件名)、
// 协议适配器 `compat`(→ 引擎 npm)。远程 BYOK 目录(`GET /v1/byok-catalog`)只提供模型与展示元数据;它若带这些
// 字段,schema 整份拒绝(ByokCatalogV1 每层 additionalProperties:false),它列出的 provider 不在本表里就被跳过 ——
// 所以远程数据改不了 Key 的去向,也给不了引擎新的出网放行主机(放行集合从注入的 baseURL 派生,network-egress-derived.ts)。
//
// 四个直接读者只认本表(方案 §2.3 读者迁移表):Key 映射(alpha-byok-keys.ts)、要物化的密钥文件集合
// (alpha-secret-files.ts,含会删「不在 wanted 集」旧文件的清理分支)、Key 状态(alpha-provider-status.ts)、
// 保留 id(ext-config.ts)。加一个新供应商 = 发版(方案 §2.9 第 1 条)。
//
// `pico` 是过渡期的字母图标,随 alpha-code#1558 换成按品牌出图后删除;它不是可执行字段,放在这里只因为本表是
// 唯一随包、按 provider 的位置。
//
// electron-free:sidecar 经 alpha-models.ts 读。

export type ByokAdapter = {
  id: string
  compat: "openai" | "anthropic"
  baseURL: string
  keyEnv: string
  pico: { letter: string; color: string }
}

export const BYOK_ADAPTERS: readonly ByokAdapter[] = [
  {
    id: "deepseek",
    compat: "openai",
    baseURL: "https://api.deepseek.com/v1",
    keyEnv: "DEEPSEEK_API_KEY",
    pico: { letter: "D", color: "#2563eb" },
  },
  {
    id: "zhipuai",
    compat: "openai",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    keyEnv: "ZHIPU_API_KEY",
    pico: { letter: "智", color: "#16a34a" },
  },
  {
    id: "minimax",
    compat: "openai",
    baseURL: "https://api.minimaxi.com/v1",
    keyEnv: "MINIMAX_API_KEY",
    pico: { letter: "M", color: "#dc2626" },
  },
  {
    id: "alibaba",
    compat: "openai",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyEnv: "DASHSCOPE_API_KEY",
    pico: { letter: "通", color: "#7c3aed" },
  },
  {
    id: "moonshot",
    compat: "openai",
    baseURL: "https://api.moonshot.cn/v1",
    keyEnv: "MOONSHOT_API_KEY",
    pico: { letter: "K", color: "#111317" },
  },
]

export function byokAdapter(id: string): ByokAdapter | undefined {
  return BYOK_ADAPTERS.find((adapter) => adapter.id === id)
}
