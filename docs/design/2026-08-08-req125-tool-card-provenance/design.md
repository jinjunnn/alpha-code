---
type: design
slug: req125-tool-card-provenance
date: 2026-08-08
status: accepted
relates:
  - jinjunnn/alpha-code#538(REQ-125)
  - jinjunnn/alpha-code#722(DECIDE)
  - jinjunnn/alpha-code#731(accepted stable tool identity)
  - jinjunnn/alpha-code#724(REQ-131 policy consumer; out of scope)
---

# 全来源工具卡展示与来源快照基线

> **与既有基线的关系**：本文只消费
> [`2026-07-31-tool-identity-baseline.md`](../2026-07-31-tool-identity-baseline.md)
> 的 `ToolIdentity { source, origin, name }`，不重新定义 identity、别名或权限键。
> 当前 renderer 仍按 `ToolPart.tool` 裸字符串分派专用卡；本文把这条展示缝收紧，
> 但不改授权、用户工具策略或计费判定。

## 1. 一句话裁决

> **专用卡必须由完整稳定 identity 命中宿主拥有的展示规则；来源或规则不完整时，
> 只显示可信来源分类、被动转义后的名称与状态，不显示任意参数、错误或输出。**

标题、图标、翻译、远端 annotations 和展示徽标都是输出，永远不能反向参与授权、
用户工具策略或计费。

**状态**：`accepted`。owner 于 2026-08-09 批准 §9 的 Q1–Q3 推荐项：严格
metadata-only、宿主精确规则独占、technical-id 默认折叠。实现按 §8 的既有 / 新建
CODE 票推进，不再重开这三项产品选择。

## 2. 实读现状与缺口

| # | 现状 | 风险 / 本稿处置 |
| --- | --- | --- |
| F1 | `tool-card-model.ts` 用 `TOOL_CARD_KINDS.get(part.tool)` 按裸别名选择 `bash` / `read` / `websearch` 等专用卡 | 插件或 MCP 撞名即可借用内置卡。改为按完整 `ToolIdentity` + 宿主展示规则选择；禁止从别名反推 identity。 |
| F2 | `unknown` 卡会把 `state.output` 当纯文本显示 | 未知输出无字段边界，不能安全 allowlist。降级卡不再有 body 或展开入口。 |
| F3 | 已有专用卡会显示命令、URL、路径、搜索词、错误和输出 | 这些字段逐类 allowlist，再过字段归一化和共享 redactor；失败即隐藏整字段，不“尽量显示”。 |
| F4 | `ToolPart` 尚没有已落地的来源快照 | 依赖 #731 的 L3 identity 接线；每次调用开始时写不可变 identity + technical-id + 权威来源证明快照。历史回放禁止查 live registry 补猜。 |
| F5 | Alpha Cloud MCP 与第三方 MCP 在引擎中同属 `source="mcp"` | “云端”不能靠 server 名、URL、图标或 annotation 猜；只有调用时有效的宿主权威绑定证明可以铸造该展示事实。 |

## 3. 展示真相分层

一张工具卡只从下面四层取数，层级越低越不可信：

1. **调用事实**：持久化的 `ToolIdentity`、模型可见 `technicalId`、状态与时间。
2. **宿主权威证明**：调用开始时，宿主从已验证绑定图取得的 Alpha Cloud ownership
   证明；若计费系统提供独立、权威的调用分类，也在此时冻结。缺失就不显示相应徽标。
3. **宿主展示规则**：由 Alpha 代码拥有，精确绑定 identity / 权威证明，决定标题、图标、
   allowlist 与 redactor。它可以改变视觉，但不能改变第 1–2 层事实。
4. **远端元数据**：插件或 MCP 的 description / annotation / title。只能作为被动转义的
   补充文案或**提高**警戒；不得选择专用卡、降低警戒或声称“安全 / 免费 / Alpha 官方”。

### 3.1 不可变调用快照

实现时在工具调用创建点持久化下面的语义，不再复制一套会漂移的 `server` /
`remoteTool` 字段：

```ts
type ToolDisplaySnapshotV1 = {
  identity: ToolIdentity
  // 模型在这次调用实际使用的别名；只进开发者详情。
  technicalId: string
  // 仅宿主可铸造；缺失表示“不作官方来源声明”。
  authority:
    | { kind: "alpha-cloud"; bindingId: string; evidenceDigest: string }
    | { kind: "not-asserted" }
  // 只有计费权威提供事实时才存在；UI 不自行推断。
  billing?: { class: string; evidenceId: string }
}
```

- `identity.source` 是 source；MCP 的 `identity.origin` 是调用时 server 配置键原文；
  `identity.name` 是调用时远端 tool name 原文。三者已经满足 source / server /
  remote-tool 快照要求，不再并列存一套易漂移副本。
- `technicalId` 是当次模型可见别名，不是 identity，也不用于回放时重新解析 identity。
- `authority` 只从宿主已有的 verified binding graph 铸造。server 名、域名、远端
  annotation、卡片图标都不是证据。
- 历史行缺快照、快照结构不完整或证明无效时，按“未知来源”降级；不查 live registry、
  不 dual-read legacy entry、不从别名猜。

### 3.2 回放不变量

| 变化 | 历史卡 | 新调用 |
| --- | --- | --- |
| MCP server 被删除 | 继续显示快照中的 server / remote tool；不声称仍可调用 | 无新调用 |
| server 配置键改名 | 旧名不变 | 新 identity 使用新名 |
| 同一配置键 rebind 到另一端 | 旧 authority / billing 事实不变 | 重新从当次权威绑定铸造；不能继承旧“云端” |
| live catalog 暂时不可用 | 用已持久化快照渲染 | 不能取得权威证明时不显示官方 / 计费声明 |
| 翻译或图标更新 | 可按新视觉重绘 | 不改变 identity、authority、policy 或 billing |

## 4. 全来源覆盖矩阵

| 来源 | 卡片资格 | 主层级 | 未命中宿主规则时 |
| --- | --- | --- | --- |
| `builtin` / `builtin-v2` | 完整 identity 精确命中宿主内置规则 | 本机徽标 + 人类可读动词（读取、检索、运行命令等） | “本机工具” + 原样名称 + 状态；无参数 / 输出 |
| `host` | 完整 identity 精确命中宿主规则 | “Alpha 宿主” + 人类可读标题 | “宿主工具” + 原样名称 + 状态；无参数 / 输出 |
| Alpha Cloud MCP | `source="mcp"` + 当次 `authority.kind="alpha-cloud"` + 精确宿主规则 | `☁️ 网页搜索　"alpha-code e7 …"　云端　完成` 这类层级 | “Alpha 云端工具” + server / remote name + 状态；无任意 body |
| 第三方 MCP | 默认无专用卡。未来仅允许 Alpha 自有、精确绑定 identity 的规则 | “第三方 MCP” + server + remote name + 状态 | 同左；annotation 只能加“第三方声明，未验证”警示 |
| 插件动态工具 | 默认无专用卡。未来仅允许 Alpha 自有、精确绑定插件 identity 的规则 | “插件工具” + plugin origin + export name + 状态 | 同左；名为 `bash` 也绝不借用内置命令卡 |
| identity 缺失 / 非法 | 无 | “未知来源的工具” + 被动转义后的现有名称 + 状态 | 无 body、无展开、无来源 / 云端 / 计费推断 |

“原样名称”指：不翻译、不把别名当真相、不执行 markup；按 Unicode code point 有界截断、
转义后显示。它是远端输入，不因为进入标题就变成可信策略数据。

## 5. 字段 allowlist 与 redactor

### 5.1 总管线

```text
完整快照
  → 精确选择宿主展示规则（失败 = metadata-only）
  → 规则内字段 allowlist（未知 key 丢弃）
  → 按字段类型归一化
  → 共享 redactor
  → 既有行数 / 字节 / 项数上限
  → 纯文本 / 现役安全组件渲染
```

任何一步失败都隐藏**整个字段**并给出“详情已隐藏”，不能回退到 raw JSON / `String(value)`。
降级卡没有第 2 步，因此永远没有参数、错误或输出 body。

### 5.2 分类规则

| 工具类别 | 顶层可显示 | 展开区可显示 | 永不显示 |
| --- | --- | --- | --- |
| 文件读取 / 列表 / glob | 已脱敏相对路径、文件 / 项数、状态 | 已脱敏路径列表 | 文件正文、未知 metadata、绝对 home 前缀 |
| grep / 诊断 | 已脱敏 pattern、include、命中数 | 已脱敏路径 + 行号 + 通过内容 redactor 的有界摘录 | 未筛选 stdout / diagnostics 对象 |
| shell | “运行命令”、退出码、状态；命令仅在完整字段通过 redactor 时显示 | 通过 redactor 的有界 stdout / stderr | env、cwd 绝对路径、headers、原始 process 对象 |
| edit / write / patch | 已脱敏路径、文件数、增删统计、状态 | 通过内容 redactor 的有界 diff；失败则只留统计 | 原始文件全文、未知附件 / metadata |
| web fetch | 宿主标题、已清洗 URL、状态 | 无默认正文 | URL userinfo / query / fragment、headers、响应正文 |
| web search | 宿主标题、通过 redactor 的 query、结果数、状态 | 已清洗结果 host + 宿主允许的标题 | 搜索请求 headers、结果 query / fragment、原始响应 |
| skill / task | 宿主标题、已脱敏 name / description、状态 | 宿主已知的 session link / agent class | prompt、环境、任意子会话输出 |
| 第三方 MCP / plugin / unknown | 来源分类、origin、name、状态 | 仅开发者详情中的快照字段 | **全部参数、错误、输出、annotation body** |

### 5.3 共享脱敏清单

- **键级丢弃**（大小写及 `-` / `_` 归一后匹配）：`authorization`、`proxy-authorization`、
  `cookie`、`set-cookie`、`x-api-key`、`api-key`、`token`、`access-token`、
  `refresh-token`、`password`、`secret`、`credential`、`client-secret`、`private-key`、
  `session`。header map 默认全丢，不做“把未知 header 值显示出来”的例外。
- **URL**：必须用结构化 URL parser；删除 username / password / query / fragment，
  只保留 scheme、host、port 与脱敏 pathname。解析失败时整条隐藏。
- **路径**：能落在 workspace 内才显示相对路径；外部路径只留脱敏 basename 与 `…/`。
  任一 segment 命中 token / secret / password / credential / api-key / private-key / `.env`
  等 sentinel 时替换为 `[已隐藏]`。不得显示用户名所在的 home 前缀。
- **自由文本**：Bearer / Basic credential、PEM private key、secret-like 环境变量赋值、
  常见 token 前缀、URL credential 任一命中时替换对应 span；无法确定边界时隐藏整行，
  无法完成有界扫描时隐藏整字段。
- **错误 / 输出 / diff**：只允许宿主规则点名的字段进入；先脱敏再限长。JSON parse
  失败不是显示原文的理由。unknown / third-party generic 卡永远不进入此路径。
- **技术细节**：canonical identity、technical-id、authority evidence id 同样先做长度限制与
  纯文本转义；开发者详情不能成为秘密旁路。

“已隐藏”是确定结果，不提供点击恢复 raw 值的入口。需要原始调试材料时走既有受控日志 /
产物通道，本时间线卡不承担秘密查看器职责。

## 6. 标题、徽标与开发者详情

- **主标题**：宿主规则提供本地化、人类可读动词；规则缺失时使用稳定分类文案
  （“第三方 MCP 工具 / 插件工具 / 未知来源的工具”），远端 name 作为次级文本。
- **来源徽标**：只读 `identity.source` 与持久化 authority；`mcp` 本身不等于 Alpha Cloud。
- **状态**：只读结构化执行状态，不从 error 文本反推状态码或分类。
- **technical-id**：默认折叠在“开发者详情”，与 canonical identity、server / plugin origin
  一起显示；不占主标题，也不参与任何判定。
- **第三方 annotation**：最多出现“第三方声明，未验证”的折叠提示；只能加警示，
  不能换图标、选专用卡、显示“官方 / 安全 / 免费”。

## 7. 必须变红的反例

| # | 判据 | 绕过后必须红 |
| --- | --- | --- |
| T1 | plugin / MCP 导出名为 `bash`、`read`、`websearch` 仍走 metadata-only | 把 dispatch 改回 `part.tool` 裸名 |
| T2 | identity 缺失 / 非法时只见来源分类、名称、状态 | 重新显示 input / output / error 任一字段 |
| T3 | Alpha Cloud 徽标只认当次持久化 authority | 仅凭 server 名、URL、title、icon 或 annotation 判云端 |
| T4 | server 删除 / 改名 / rebind 后历史来源与 authority 不变 | 回放时查 live registry 或 catalog 覆盖快照 |
| T5 | URL 移除 userinfo / query / fragment；header 默认全丢 | 恢复 raw URL / headers |
| T6 | 路径 secret sentinel、token、未经筛选 error / output 不能穿过卡片 | redactor 失败时回退 raw string |
| T7 | 标题 / 图标 / 翻译 / annotation 改动不改变 policy / billing 结果 | 任一 UI 字段进入授权、策略或计费输入 |
| T8 | technical-id 只在折叠开发者详情 | 把模型别名提升为主标题或从它反推 identity |

## 8. 后续实现切片

1. **P1 · 快照写入（[#878](https://github.com/jinjunnn/alpha-code/issues/878)）**：
   在 #731 L3 identity 接线之上，于每次调用创建点冻结
   `identity + technicalId + authority (+ billing fact when authoritative)`；持久化 / SDK /
   replay 用例覆盖 delete / rename / rebind。
2. **P1 · 展示规则与 redactor（[#879](https://github.com/jinjunnn/alpha-code/issues/879)）**：
   renderer 改为 identity 驱动；建立最小宿主规则表与 typed redactors；unknown /
   third-party generic 完全 metadata-only。
3. **P1 · 卡片 UI（[#587](https://github.com/jinjunnn/alpha-code/issues/587)）**：
   来源徽标、人类标题、安全通用卡、折叠开发者详情；本增量帧已在批准时合入
   `current/conversation-timeline/design.html#tool-provenance`。
4. **P1 · 反例门**：T1–T8 已按责任面分配给 #878（T3–T4）、#879
   （T1–T2、T5–T7）与 #587（T8），并各自接入 alpha-check。

依赖顺序固定为 #731 L3 → 快照 → renderer/redactor → UI/反例门；#724 策略消费可并行，
但不能读展示标题或徽标。

## 9. Owner 裁决（2026-08-09）

- **Q1 · 已批准（metadata-only）**：identity 缺失、非法或无宿主规则时，只显示来源分类、
  名称、状态；不提供“已脱敏 raw body”例外。
- **Q2 · 已批准（宿主规则独占）**：第三方 MCP / plugin 只有命中 Alpha 自有、精确
  identity 规则时才有专用卡；远端 annotation 永不授予专用卡。
- **Q3 · 已批准（默认折叠）**：technical-id 与 canonical identity 放在默认折叠的
  开发者详情，而非完全隐藏。

三项不改变授权、策略或计费机制。批准只解除 #722 的设计阻塞；实现仍按 §8 的依赖顺序
和各票验收门推进。
