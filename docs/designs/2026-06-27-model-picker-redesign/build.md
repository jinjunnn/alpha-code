# 模型选择器 1:1 落地开发计划(build plan)

> 日期:2026-06-27 · 状态:`draft`(待批准后执行)
> 设计源:`./prototype.html`(权威 UI)+ `./spec.md`(权威交互规格,含 v1.2 拍板)
> 目标:**把 prototype 1:1 实现为自有组件,替换现 `model-picker-inject.tsx` 装饰层**;模型目录**零硬编码、单一配置源**;零改 opencode 源码。
> 关联:[[ADR-016]](前端接管)、[[ADR-002]](后端只走 SDK/接缝)、[[ADR-014]](定制中心 IPC 白名单)、[[ADR-007]](config 注入)。

---

## 0. 范围与北极星对齐

**做**:自有 `<AlphaModelPicker>` 组件(浏览/搜索/分组/登录态锁定/自定义流程/测试连接)+ 模型配置外置成 `alpha-models.json` + 新增 `window.api.providers.{add,test}` IPC + 删除旧装饰层。

**不做**:改 opencode 任何源码;重写 agent/session/选择持久化引擎(复用 opencode 的 `model.set` 契约);云平台侧接口(平台模型目录先用内置 JSON,刷新留接缝)。

**北极星**:前端属 ADR-016 已接管范围(放宽);**后端零改 upstream**——数据全走 `@opencode-ai/sdk` + `window.api`,新增 IPC 复用既有 `ext-config.ts` 白名单写盘机制。CI file-diff 守卫对 `packages/{opencode,app,ui}` 仍须零改(本计划全是**新增/改 alpha 自有文件**)。

---

## 1. 现状事实(已勘探,file:line 为准)

| 主题 | 现状 | 出处 |
|------|------|------|
| 挂载 | `<ModelPickerInject/>` 作 `<AppInterface>` 子节点(与 ExtensionHub 同级) | `renderer/index.tsx:402-412` |
| 触发 | `ModelChip.onClick` → 点 `[data-action="prompt-model"]` 原生按钮,fallback `command.trigger("model.choose")` | `AlphaHome.tsx`,`composer-controls.tsx:359` |
| 现实现本质 | MutationObserver 装饰原生 Kobalte popover(贴 badge/banner/锁),**不自己设模型** | `model-picker-inject.tsx` |
| 模型列表(运行时) | `sdk.provider.list()` → `{all, connected, default}`;per-provider `{id,name,models{}}` | `global-sync/bootstrap.ts`,`use-providers.ts:19` |
| 模型选择写回 | 原生 `dialog-select-model` → `useLocal().model.set({modelID,providerID},{recent:true})` → 写 localStorage(Persist `model-selection`/`model.v1`,per-session/draft) | `dialog-select-model.tsx:66`,`context/local.tsx:296-310` |
| 当前模型标签 | composer-inject 从原生按钮 `.truncate` 文本读出 → `composerModelLabel` 信号 | `composer-inject.tsx:60` |
| 模型 config(注入) | `buildAlphaModelConfig()` **硬编码** provider whitelist + alpha 平台模型 + enabled;default 走 `ALPHA_DEFAULT_MODEL` env | `main/alpha-models.ts:40-95` |
| **alpha-catalog.json** | **是定制中心(MCP/skill/plugin)目录,非模型目录** | `renderer/extensions/alpha-catalog.json` |
| tier/倍率 | **仅渲染层正则启发式** `tierOf()`,无配置元数据 | `model-picker-inject.tsx:23-28` |
| 写用户 config 接缝 | `ext-config.ts`:`writeKey(path,value)` 原子写 + `.bak` 回滚 + `ALLOWED_TOP_KEYS={mcp,plugin}` + 字段/命令/URL 白名单;经 `ext-ipc.ts` 暴露 `window.api.ext.persistMcp` | `main/ext-config.ts:18-140`,`main/ext-ipc.ts:34` |
| 用户 config 路径 | `$OPENCODE_CONFIG_DIR` → `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode/opencode.jsonc` | `ext-config.ts:36-53` |
| 深色 | `:root[data-color-scheme="dark"]`(opencode `useTheme` 设),`--a-*` 自动切 | `tokens.css:152`,`alpha-sidebar.tsx` |
| Portal 锚定 | `ChipPopover`(fixed,按 anchor rect 定位,Portal)+ ExtensionHub Portal host(挂 `#root`) | `composer-controls.tsx:131-161`,`extension-hub.tsx:187` |

---

## 2. 核心原则

1. **自有组件接管**(ADR-016):不再装饰原生 popover,改自有 `<AlphaModelPicker>` SolidJS 组件 + `--a-*` 设计系统,1:1 还原 prototype。
2. **零硬编码 · 单一配置源**(用户硬性要求):BYOK 预设目录、**平台代理模型目录**(含 tier/倍率/推理/联网元数据)、默认模型,全部从 **`alpha-models.json`** 读;`alpha-models.ts` 退化为「读 JSON + 组装 opencode config」的薄适配器。新增/调价/上新模型 = 改 JSON,**不改代码**。
3. **后端只走 SDK + IPC**:模型列表 `sdk.provider.list()`;选择写回复用 opencode `model.set` 契约(见 §5 风险);自定义供应商持久化 + 测试连接走新增白名单 IPC,**不改 opencode server**。
4. **零改 upstream**:全部新增/改 `packages/ui-mac/*` alpha 文件;`ALLOWED_TOP_KEYS` 加 `"provider"` 是改 alpha 自有 `ext-config.ts`(非 upstream)。
5. **可回退**:每个能力带 env 逃生开关(沿用 `ALPHA_MODELS_DISABLE` 风格)。

---

## 3. 配置数据模型(`alpha-models.json` — de-hardcode 的核心)

新增 `packages/ui-mac/src/main/alpha-models.json`(主进程 bundle;后续可由平台 B / alpha-web C 增量刷新,留接缝)。**单一真相源**,主进程与渲染层都读它。

```jsonc
{
  "version": "2026-06-27.1",
  // 默认模型(取代 alpha-models.ts 硬编码 + 纯 env)
  "defaultModel": "alpha/claude-opus-4.8",
  // tier 元数据(取代渲染层 tierOf 启发式;启发式仅作未知 id 兜底)
  "tiers": {
    "flag": { "label": "旗舰", "mult": "×8" },
    "pro":  { "label": "高级", "mult": "×3" },
    "std":  { "label": "标准", "mult": "×1" }
  },
  // 平台代理模型(取代 alpha-models.ts:61-73 硬编码)。未登录也用它做「锁定预览」。
  "platformModels": [
    { "id": "claude-opus-4.8",  "name": "Claude Opus 4.8",  "tier": "flag", "reasoning": true },
    { "id": "claude-sonnet-4.6","name": "Claude Sonnet 4.6","tier": "pro",  "reasoning": true },
    { "id": "gpt-5.4-search",   "name": "GPT-5.4 · 联网",    "tier": "flag", "reasoning": true, "web": true },
    { "id": "deepseek-v4-pro",  "name": "DeepSeek V4 Pro",   "tier": "pro",  "reasoning": true },
    { "id": "claude-haiku-4.5", "name": "Claude Haiku 4.5",  "tier": "pro" }
    // …其余 gpt-5.4-mini/nano、deepseek-v4-flash 等
  ],
  // BYOK 已知供应商目录 = 自定义流程「快速预设」+ 选择器分组/pico 元数据(取代 whitelist 硬编码)
  "byokProviders": [
    { "id": "deepseek", "name": "DeepSeek",        "pico": {"letter":"D","color":"#2563eb"}, "compat": "openai",    "baseURL": "https://api.deepseek.com/v1",                       "keyEnv": "DEEPSEEK_API_KEY",  "models": ["deepseek-chat","deepseek-reasoner"] },
    { "id": "zhipuai",  "name": "智谱 GLM",         "pico": {"letter":"智","color":"#16a34a"}, "compat": "anthropic", "baseURL": "https://open.bigmodel.cn/api/anthropic",           "keyEnv": "ZHIPU_API_KEY",     "models": ["glm-5","glm-4.5-air"] },
    { "id": "alibaba",  "name": "通义千问 Qwen",    "pico": {"letter":"通","color":"#7c3aed"}, "compat": "openai",    "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "keyEnv": "DASHSCOPE_API_KEY", "models": ["qwen-plus","qwen3-coder-plus"] },
    { "id": "moonshot", "name": "Kimi (Moonshot)",  "pico": {"letter":"K","color":"#111317"}, "compat": "openai",    "baseURL": "https://api.moonshot.cn/v1",                        "keyEnv": "MOONSHOT_API_KEY",  "models": ["kimi-k2","moonshot-v1-128k"] }
  ]
}
```

**消费方式**
- **主进程** `alpha-models.ts`:`import catalog from "./alpha-models.json"` → 用 `byokProviders` 生成 `provider.<id>.whitelist` + `enabled_providers`;`ALPHA_BASE_URL` 在时用 `platformModels` 生成 `provider.alpha.models`;`defaultModel` 作 `model`(env `ALPHA_DEFAULT_MODEL` 仍可覆盖)。**删掉所有硬编码数组**。
- **渲染层** picker:经新 IPC `window.api.models.catalog()` 拿同一份 JSON → tier/倍率/pico/分组全用元数据,`tierOf()` 仅作未知 id 兜底。
- **刷新接缝**(留,不在本期实现):主进程启动可选 `GET <platform>/v1/catalog` 合并覆盖 `platformModels`,失败回退内置;离线优先(ADR-014)。

> 决策点(数据,非代码):现有 `minimax`(MiniMax-M2)不在设计的 4 预设里。处理:作为 `byokProviders` 额外条目保留(纯数据,无成本),预设卡片只渲染设计指定的 4 个(或全渲染,见 spec §12 待确认)。**当前代码缺 `moonshot`,本期由 JSON 补上。**

---

## 4. 组件架构(自有 SolidJS,`alpha-ui/model-picker/`)

```
alpha-ui/model-picker/
  index.tsx              ← <AlphaModelPicker/> 容器:popover 锚定 + 取数 + 状态机
  use-model-catalog.ts   ← 拉 window.api.models.catalog() + sdk.provider.list() 合并成行模型
  use-account-state.ts   ← deriveState(auth, summary) → 'out'|'member'|'balance'|'empty'(复用 §1 IPC)
  model-list.tsx         ← 分组渲染(代理/国内直连/自定义)+ 行 + 锁定 CTA
  account-banner.tsx     ← 四态 banner
  add-provider.tsx       ← 二级页:预设列表 + 表单(预设只读模型 / 自定义手输)+ 测试连接
  native-bridge.ts       ← 路 C:open 隐藏原生 picker → 点匹配 [data-key] 行 → 关(完成 model.set)
  model-picker.css       ← 全 --a-* token(从 prototype 抽,删 model-picker-reskin.css)
```

- **挂载**:`renderer/index.tsx` 用 `<AlphaModelPicker/>` 取代 `<ModelPickerInject/>`;同 `<AppInterface>` 子节点 + Portal(ExtensionHub host 模式)。
- **触发/锚定**:`ModelChip` 不再点原生按钮,改 flip 全局信号 `modelPickerOpen + anchorRect`;`<AlphaModelPicker>` 监听,用 `ChipPopover` 定位逻辑(`composer-controls.tsx:131`)在 chip 上方弹出。
- **尺寸约束**(spec §10):宽 `380` 固定;`max-height: min(560px, 72vh)`,仅列表内滚,搜索/banner/底部 sticky。
- **深色**:不需处理,`--a-*` 跟随 `data-color-scheme` 自动。
- **键盘/点外关闭**:Esc/点遮罩关;↑↓ 导航(复用既有 a-pop 模式)。

---

## 5. 数据流 & ⚠️ 头号风险:模型选择写回

**取数**(读):`use-model-catalog` 合并三源 →
1. `platformModels`(JSON)→ 代理组;登录后用 `provider.list().all.alpha.models` 校正可用性;未登录用 JSON 静态做锁定预览。
2. `provider.list().connected` ∩ `byokProviders` → 国内直连组(**只显已配置**:connected 才出现);每个 model id 一行。
3. connected 里的自定义 provider → 自定义组。
- tier/倍率/pico/reasoning ← JSON 元数据;倍率仅代理行显示。

**写回(选择模型)— P0 Spike 已结论(2026-06-27,静态分析定案)**:opencode 的「当前模型」是**客户端 localStorage 偏好**,经 **route 作用域的 `useLocal().model.set`** 写(`context/local.tsx`,`LocalProvider` 挂在 `pages/directory-layout.tsx:44`)。`app.tsx:421-425` 注释明确:appChildren 只在 **QueryProvider + Settings/Command/Highlights** 这层「server-agnostic shell」渲染;`ModelsProvider`/`LocalProvider`/`PromptProvider` 等全在**逐路由**层。→ alpha overlay **拿不到** `useLocal`/`useModels`。

| 路线 | 结论 | 原因 |
|------|------|------|
| 路 A 直接 `useLocal().model.set` | ❌ 否决 | provider 不在 overlay 作用域(route-scoped) |
| 路 B 复刻 localStorage 写 | ❌ 否决 | opencode 内存 `persisted` store **不会**响应同文档外部写 → 不 reload 不生效 |
| **路 C 驱动原生 picker 作隐藏选择引擎** | ✅ **采用** | 走 opencode 真实代码路径,session/draft/recent 语义全对;`command.trigger("model.choose")` 可达(CommandProvider 是 shared),行可经既有 `[data-key="provider:modelId"]` 钩子点击 |

**路 C 落地(P2 实施时进一步简化 → 路 C′「原地装饰」)**:读现 `model-picker-inject.tsx` 后发现它**已是「原地装饰原生 popover」**——它 restyle 的就是**真实的原生行**。所以用户点的是原生行 → 原生 `onSelect` → `model.set` **直接、正确触发**。**结论:只要继续走「原地装饰/接管」而非「另起 alpha popover」,§5 的 model.set 不可达问题就根本不存在**,无需 native-bridge、无需 command 驱动、无 reactivity 问题。
- **P2 = 把现装饰层演进到新设计稿**(非另写组件):现装饰层已覆盖分组/pico/tier/banner/锁/footer ≈ 80%;P2 改动 = ① CSS 重做成 prototype 视觉(搜索框/行/banner/组头/footer/宽 380·max-h)② tier/倍率改读 `window.api.models.catalog()`(去硬编码启发式,留 fallback)③ 组头改「代理节点 · 经 ALPHA 代理」、副标题=model id。
- **唯一真正新增**:① 未登录时注入「锁定预览」代理行(原生列表此时无 alpha 行,从 catalog.platformModels 注入只读行,点击引导登录)②自定义流程二级页(P4,Portal 覆盖 popover)③ providers.add/test IPC(P4)。
- **native-bridge.ts 取消**(不需要);组件目录 §4 相应简化为「沿用 `model-picker-inject.tsx` + 拆子模块」。

**当前模型标签**:沿用 `composerModelLabel`(或改读 `useLocal().model` / selection 信号),ModelChip 显示当前选中名。

---

## 6. 新增 IPC:`window.api.providers.{add,test}`(复刻 persistMcp 范式)

**改动文件(全 alpha 自有)**:
1. `preload/types.ts`:`ElectronAPI` 加
   ```ts
   providers: {
     add: (cfg: { id: string; name: string; compat: "openai"|"anthropic"; baseURL: string; apiKey: string; models: string[]; setDefault?: boolean })
       => Promise<{ ok: true } | { ok: false; reason: string }>
     test: (cfg: { compat: "openai"|"anthropic"; baseURL: string; apiKey: string; model: string })
       => Promise<{ ok: true; ms: number } | { ok: false; reason: string }>
   }
   models: { catalog: () => Promise<ModelCatalog> }   // 暴露 alpha-models.json 给渲染层
   ```
2. `preload/index.ts`:`ipcRenderer.invoke("providers-add"/"providers-test"/"models-catalog", …)`。
3. `main/ext-config.ts`:
   - `ALLOWED_TOP_KEYS` 加 `"provider"`。
   - 新 `SAFE_PROVIDER_FIELDS = {npm, name, options, models}`(`options` 仅 `{baseURL, apiKey}`)。
   - `persistProvider(id, cfg)`:校验 `SAFE_NAME`、`baseURL` 走既有 URL 白名单(https / loopback http)、组装 `{npm:"@ai-sdk/openai-compatible"或 anthropic 对应, name, options:{baseURL, apiKey}, models:{…}}` → `writeKey(["provider", id], block)`。
   - ⚠️ **enabled_providers 已核实(`config.ts:41-51`)**:opencode 用 remeda `mergeDeep`,**数组「替换」不「并集」**(仅 `instructions` 特判 concat);`OPENCODE_CONFIG_CONTENT` 最后合并 → alpha 注入的 `enabled_providers` 硬白名单**整体覆盖**用户 opencode.jsonc 的同名键。**后果**:只把 provider 写进 opencode.jsonc 不够——不在被注入的 allowlist 里会被丢弃。**解法(P4 前置)**:`alpha-models.ts` 启动时**读用户 opencode.jsonc 的 `provider` 键**,把其 id 并进注入的 `enabled_providers`(curated + 用户自定义)→ 自定义 provider **重连/重启后可见**;"即时生效"需 opencode 运行时 provider 热加(MCP 有 `mcp.add` live,provider 待核实)→ 列 stretch。**此前置改造先于 add-flow UI。**
4. **新** `main/provider-test.ts`:`testProvider(cfg)` 主进程 `fetch` 发 **1-token chat**:
   - openai 兼容:`POST {baseURL}/chat/completions` `{model, messages:[{role:"user",content:"ping"}], max_tokens:1}` + `Authorization: Bearer <key>`。
   - anthropic 兼容:`POST {baseURL}/v1/messages`(或 baseURL 已含 /anthropic)`{model, max_tokens:1, messages:[…]}` + `x-api-key` / `anthropic-version`。
   - 返回 `{ok,ms}` 或 `{ok:false,reason}`;**Key 仅在主进程**,不回渲染层、不入日志。
5. `main/ext-ipc.ts`(或新 `provider-ipc.ts`):注册 `providers-add`/`providers-test`/`models-catalog`,在 `main/index.ts` 调用注册。

**安全**(沿用 ADR-014 §8 + ext-config 现状):字段白名单、URL WHATWG 解析白名单、realpath/原子写/`.bak` 回滚、Key 不出主进程。
> 决策点:BYOK key 落 **opencode.jsonc `provider.options.apiKey` 明文**(与 opencode 常规一致,user-local)还是 keychain + `{env:}` 引用(更安全)?默认前者(简单、1:1),安全审查时再升级。

---

## 7. 分阶段实施

| 阶段 | 内容 | 主要文件 | 验收 |
|------|------|----------|------|
| **P0 Spike** | ✅ **已完成**(静态分析):`model.set` 不可达 → 采路 C(驱动原生 picker)。见 §5 | — | 已定案 |
| **P1 配置外置** | ✅ **完成+已验证**:`alpha-models.json` + `alpha-models.ts` 读 JSON(删硬编码)+ `models.catalog` IPC | `alpha-models.json`,`alpha-models.ts`,`shared/alpha-model-types.ts`,`models-ipc.ts`,preload×2,`index.ts` | tsgo 过;两态注入 config 与改前**逐字段一致**✅ |
| **P2 装饰层演进** | ✅ **完成+typecheck**:装饰层改 catalog 驱动(tier/倍率/pico 去硬编码)+ 组头「经 ALPHA 代理」+ 副标题=model id + 倍率仅代理 + CSS 380/max-h/聚焦环 | `model-picker-inject.tsx`,`model-picker-reskin.css` | tsgo 过;视觉 1:1 **待真机 CDP** |
| **P3 登录态/锁定预览** | ✅ **完成+typecheck+bundle**:banner 四态 + 未登录注入「锁定预览」代理行(`ensureLockedPreview`,从 catalog.platformModels 注入只读行,点击引导登录)+ 健壮区分 model-picker / provider-dialog | `model-picker-inject.tsx`,CSS | 视觉/行为 **待真机** |
| **P4-pre allowlist 改造** | ✅ **完成+验证**:`alpha-models.ts` 读用户 opencode.jsonc `provider` 键并入 `enabled_providers`(`readUserProviderIds`);无用户 provider 时注入 config 不变(已验证) | `alpha-models.ts`,`ext-config.ts` | 等价性✅;自定义可见 **待真机** |
| **P4 自定义流程** | ✅ **完成+typecheck+bundle**:二级 overlay(4 预设只填 Key,模型读 JSON / 自定义手输 id)+ 测试连接(1-token chat)+ 保存;`providers.add/test` IPC 复刻 persistMcp 白名单 | `model-picker-add.tsx`,`ext-config.ts`,`provider-test.ts`,`provider-ipc.ts`,preload×2,`index.ts` | IPC 通道已 bundle;端到端 **待真机** |
| **P5 收尾** | dead 代码已清(删 PROV_* 硬编码 map);逃生开关 `ALPHA_MODELPICKER_LEGACY`(可选,待定) | `model-picker-inject.tsx` | — |
| **P6 验证(唯一剩余)** | CDP 截图四态×浅深 + 配 key 选模型端到端 + providers.add 重连可见 + 测试连接真端点 + ship 实测 | — | 见 §10,**需真机 + provider key** |

---

## 8. 文件清单

**新增**:`main/alpha-models.json`、`main/provider-test.ts`、`renderer/alpha-ui/model-picker/{index,model-list,account-banner,add-provider}.tsx`、`{use-model-catalog,use-account-state}.ts`、`model-picker/native-bridge.ts`、`model-picker/model-picker.css`。

**改**:`main/alpha-models.ts`(读 JSON,删硬编码)、`main/ext-config.ts`(provider 写入 + 白名单)、`main/ext-ipc.ts`(或新 provider-ipc + index.ts 注册)、`preload/{types,index}.ts`(providers/models API)、`renderer/index.tsx`(换挂载 + CSS import)、`composer-controls.tsx`(ModelChip 改触发)、`AlphaHome.tsx`(触发逻辑)。

**删**:`renderer/alpha-ui/model-picker-inject.tsx`、`renderer/alpha-ui/model-picker-reskin.css`。

---

## 9. 风险与回退

| 风险 | 影响 | 对策 |
|------|------|------|
| `model.set` 不可达(§5,已证实) | 选了不生效 | ✅ 采路 C 驱动原生 picker(走真实代码路径);耦合面 = `model.choose` 命令 + `data-key` 格式,进 sync 复核清单 |
| 借 opencode 内部 context/SDK 形状升级漂移 | 静默失效 | 收敛到 `providers/*` 薄 re-export(ADR-016);`provider.list`/`model.set` 形状进 sync 复核清单 |
| `provider` 写入 opencode V1 schema 细节(enabled?字段名?) | 写了不被发现 | P1 对照 `core/src/v1/config` 核实;ALLOWED_TOP_KEYS 误判会 loud-fail(已知纪律) |
| BYOK key 明文落盘 | 安全 | 决策点;默认 user-local 明文(同 opencode),可升级 keychain+{env:} |
| 测试连接各家兼容性差异 | 误报失败 | 按 compat 分支;失败显真实 reason 不静默 |
| 逃生开关缺失 | 出问题难关 | 加 `ALPHA_MODELPICKER_LEGACY=1` 回退旧装饰层(过渡期保留旧文件一版再删) |

---

## 10. 验收标准

1. **1:1 视觉**:四态(out/member/balance/empty)× 浅/深,与 prototype CDP 截图逐项对齐。
2. **零硬编码**:`alpha-models.ts` 无模型字面量数组;改 `alpha-models.json` 即可增删模型/调 tier,无需改代码(实测加一个模型验证)。
3. **功能**:搜索过滤;一 id 一行;只显已配置 BYOK;代理永远可见、未登录锁定引导登录;倍率 ×N 可见;自定义预设只填 Key、自定义端点手输 id、测试连接 1-token chat;保存即时生效、N id → N 行。
4. **选择生效**:切模型后下一条 prompt 真的用新模型(端到端实测,非仅 UI)。
5. **零改 upstream**:`git diff` 不含 `packages/{opencode,app,ui}`;CI file-diff 守卫过。
6. **ship 实测**:`bun --cwd packages/ui-mac run dev` 起得来;`ship:mac` 装机后真机核验(见 [[visual-verify-required]]、[[ship-workflow]])。

---

## 11. 排期估算(粗)

P0 spike 0.5–1d · P1 配置外置 0.5d · P2 骨架+选择 1.5–2d(随 P0 结果浮动)· P3 登录态 1d · P4 自定义+IPC+测试 1.5d · P5 拆旧 0.25d · P6 验证 0.5–1d。**合计 ≈ 6–7.5 人日**,P0/P2 是不确定性来源。

---

## 12. 执行前待你确认
1. **P0 先行**:同意先做 spike 定选择写回路线,再大规模写组件?(强烈建议)
2. **BYOK key 落盘**:明文进 opencode.jsonc(简单)vs keychain+{env:}(安全)——本期选哪个?
3. **minimax / 预设数量**:JSON 里保留 minimax 吗?预设卡片只显 4 个还是含 minimax?
4. **过渡逃生开关**:是否要 `ALPHA_MODELPICKER_LEGACY=1` 保留旧装饰层一版(P5 暂不物理删)?
