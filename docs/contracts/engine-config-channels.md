---
title: Engine config channels (v1/v2 dual-generation contract)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-23
review_after: 2026-10-23
---

# 引擎配置通道契约(v1/v2 双代)

上游 opencode 正处 v1→v2 架构迁移中途,引擎内**同时存在两代配置面**,读取来源与
能力互不相通。alpha 的一切引擎注入都必须同时喂对两代的**原生入口**,否则表现为
"某一代的消费面整体失明"(2026-07-23 全模型「当前不可用」事故,见下)。

## 两代配置面的地面真相

| | v1(`packages/opencode/src/config/`) | v2(`packages/core/src/config.ts`) |
| --- | --- | --- |
| 读取来源 | `OPENCODE_CONFIG_CONTENT` env(merge 序最后)、`OPENCODE_CONFIG` 指向的文件(alpha.jsonc)、`Global.Path.config` 静态目录 | **只读文件**:`OPENCODE_CONFIG_DIR ?? ~/.config/opencode` 目录下的 `opencode.json` + `opencode.jsonc`(json 先、jsonc 后,后者压前者)+ 项目/`.opencode` 发现 |
| 变量解析 | `{file:}` / `{env:}`(`config/variable.ts`) | **无** —— 密钥引用原样成字面量 |
| v1 形态兼容 | 原生 | `isV1 → ConfigV1 decode → migrate → v2 decode`;**解码失败 = 整文件静默丢弃** |
| 主要消费面 | 推理(session prompt → v1 `Provider.Service`)、权限 deny、MCP、plugin、disabled 主权覆盖 | `/api/model` catalog(模型选择器 list)、`v2.session.switchModel/get` |
| `OPENCODE_CONFIG_DIR` 影响 | 仅跳过默认 schema stub 落盘;全局读取仍走静态路径 | **决定唯一全局配置目录**(也影响 v2 的 `AGENTS.md` 全局查找) |

关键不对称:v2 **不读** `OPENCODE_CONFIG_CONTENT` 与 `OPENCODE_CONFIG`——alpha
经典的两条注入通道对 v2 完全不可见。

## alpha 的注入方案:单一真源、双投影

sidecar fork 时(`packages/ui-mac/src/main/sidecar.ts` → `prepareSidecarEnv` 调用
`packages/ui-mac/src/main/alpha-config-injection.ts` 的 `injectAlphaConfig`;#607 把注入
组合体从 sidecar.ts 抽出成独立模块,**只为让它可被测试真实执行** —— sidecar.ts 的首个
import 是 bun 未实现的 `node:module` registerHooks,顶层还有 `getParentPort()`),
同一个 config 对象(平台 provider + BYOK 节点 + 权限 + MCP + disabled 覆盖,源自
`alpha-models.json` + live allowlist + 钥匙串)一次产出、两路投影:

1. **v1**:`OPENCODE_CONFIG_CONTENT = JSON.stringify(config)`(原行为,密钥经
   `{file:}` 引用,fork 前由 main `syncSecretFiles` 物化)。
2. **v2**:`materializeV2EngineConfig` 物化 `<userData>/alpha-engine-config/`:
   - `opencode.json` ← alpha.jsonc 原样拷贝(用户自定义节点;先加载);
   - `opencode.jsonc` ← 注入配置的 `{ $schema, model, provider }` 子集,
     **剥除 apiKey**(v2 无变量解析,catalog 可用性判定走 no-integration 路径
     也不需要 key);后加载,压过用户同名项;
   - 设 `OPENCODE_CONFIG_DIR` 指向该目录。独立失败域:桥失败只损失 v2 面,
     不波及 v1 注入。

同一次 fork 内同源产出,两投影无漂移面。推理密钥只存在于 v1 通道。

## 不变量(实现与 review 都要守)

- **sidecar 进程内不得调用 main-only 单例**(`getAlphaEnvironment` /
  `catalogRegistryChannel`):sidecar 从不跑 `initAlphaEnvironment`,必抛;需要
  的值由 main 算好经 `StartCommand` 传入(如 `registryChannel`)。
- **`injectAlphaConfig` 内任何加固层/旁路步骤必须有自己的降级域**,不得借函数级
  catch 把 provider/权限注入一并炸掉。
  强制手段(#607,`packages/ui-mac/src/main/alpha-config-injection.test.ts`):正向闸门
  执行生产 composition 并锁住 content 里的 model / `enabled_providers` / provider /
  三个 alpha agent / `{file:}` ref;反向闸门用真实故障触发那层 catch,要求失败出声、
  且正向断言体在该路径上真的转红。**该闸门锁的是「注入整体不得静默失败」,
  不是「每个加固层都已各自分域」** —— 后者仍靠 review 逐处核。
- **v2 文件必须能通过 `isV1 → migrate → decode` 链**:v2 解码失败是静默整文件
  丢弃,新增键前先以真实链验证(参照 2026-07-23 探针方法)。
- **密钥不落 v2 文件**:v2 无解析机制,写入即明文。

## 事故记录与收敛

- 2026-07-23:两层断层叠加致打包端全模型「当前不可用」——①sidecar 内调
  `catalogRegistryChannel()` 抛错炸掉整份 v1 注入;②picker 已切 v2 `/api/model`
  而 v2 读不到任何 alpha 注入通道。修复即本契约现行方案。
- 双通道是过渡态。收敛(撤 v1 注入、归一 v2 文件通道)由触发条件票跟踪:
  [alpha-code#523](https://github.com/jinjunnn/alpha-code/issues/523)——上游把
  推理与 secret 解析迁至 v2 之前不动手。
- 每次 rolling-pin 上游 sync 后,若 v1/v2 消费面分工有变(尤其推理链或变量解析),
  先更新本契约再改注入实现。
