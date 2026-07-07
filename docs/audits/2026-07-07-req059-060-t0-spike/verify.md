# T0 通道判定 spike — REQ-059(全局)/ REQ-060(项目级)

> 状态:**源码判定完成**(2026-07-07);真机 spike 分两半——G1 全局可随 T1 载体顺带验,hook 四路变异可见性是 REQ-060 GO 前必做真机项。
> 方法:引擎源码逐行核实(file:line),对齐 design v3 §二/§四 的机制假设。分支 `feat/req059-060-config-truth`。
> 纪律(REQ-059 验收⑤ / REQ-060 §风险):任一路由两通道皆不通 → 停,回用户拍板,**不得自作主张回退 symlink**。

## 结论先行

- **REQ-059 全局层(G1 = `OPENCODE_CONFIG` 文件通道):源码判定全 GREEN,建议 GO**。走标准 config merge(非 hook 变异),时序天然正确、junk-free、压 XDG、项目可覆盖、dispose 重读;桌面走 v1 loader 铁证;A6 白名单**无需补**。
- **REQ-060 项目级(config hook 注入):机制确认存在,但四路消费方「变异可见性 + 重读时序」源码判不死,是 GO 前唯一真机 gate**。需先有 ext 插件载体(T1)才能真机 spike。

## 一、桌面走哪套 config loader —— v1(铁证,排除 design 的 v2 担忧)

- alpha 现有 `injectAlphaConfig` 经 `OPENCODE_CONFIG_CONTENT` 注入(sidecar.ts:349),**生产在用且生效**;该 env 的消费点 = `packages/opencode/src/config/config.ts:468`。
- ⇒ 桌面 sidecar 的 config 装配走 `packages/opencode/src/config/config.ts`(即 design 所称 v1 loader),**不是** `packages/core` 的 v2 装载器。design §七「v2 只见 `OPENCODE_CONFIG_DIR`(core/global.ts:64)」的担忧对桌面不适用。
- 该文件同时消费 `OPENCODE_CONFIG`(:401)与 `OPENCODE_CONFIG_CONTENT`(:468)——G1 与现有 CONTENT 通道同一 loader、相邻代码。

## 二、G1(`OPENCODE_CONFIG` 全局文件通道)逐项判定 — 全 GREEN

| 判定项 | 结论 | 源码依据 |
|---|---|---|
| 在 v1 merge 链被消费 | ✅ | config.ts:401-403 `if (Flag.OPENCODE_CONFIG) merge(...)` |
| merge 序在 XDG 之后(→ provider 迁入压制 XDG 残留) | ✅ | :399-400 global(XDG)→ :401 OPENCODE_CONFIG |
| merge 序在项目之前(→ 项目可覆盖全局,语义正确) | ✅ | :401 → :407 项目直连文件 → :423 项目 `.opencode` 目录 |
| `~/.alpha` 零引擎 junk(不被 ensureGitignore/npm install) | ✅ | junk 循环仅遍历 `directories`(:414/:423),`OPENCODE_CONFIG` 单文件不在其中(:437-447) |
| dispose 重读文件(安装免重启,路径不变内容变) | ✅ 源码 / 真机顺带 | 整段在 per-instance load 函数(带 ctx.directory);InstanceState dispose 重建重跑 |
| 五类全能(mcp/plugin/agent/command/skills/provider) | ✅ | 标准 config 文件,merge 后 `config.get()` 即含;agent/command 上游本就「.md → config 条目」(config/agent.ts、config/command.ts),skills 走 `skills:[paths]` |
| A6 sidecar env 白名单 | ✅ 无需补 | sidecar-env.ts:66 `PREFIXES=["OPENCODE_",...]` 天然放行(`OPENCODE_CONFIG` 不含 KEY/TOKEN/SECRET);且 `injectAlphaConfig` 在 sidecar 进程内注入,不经 main→sidecar 白名单。REQ-059 T1「白名单补项」判断**可修正为无需改** |
| 注入实现复杂度 | 极简 | `injectAlphaConfig` 内 `process.env.OPENCODE_CONFIG = <~/.alpha/alpha.jsonc>`(写文件后),一行 |

**关键区分**:G1 是「标准 config 文件 merge」,在 `config.get()` 装配时就并入——所有消费方(mcp/agent/skill/…)读到的都是**已合并态**,不存在「变异晚于消费方读取」的时序问题。这是 G1 与 config-hook 通道的本质差异,也是 REQ-059 能先 GO 的根据。

## 三、config hook(REQ-060 项目级通道)判定 — 机制在,变异可见性待真机

| 判定项 | 结论 | 依据 |
|---|---|---|
| `config` hook 契约存在稳定 | ✅ | plugin/src/index.ts:225 `config?: (input: Config) => Promise<void>` |
| per-instance(知道自己在哪个项目) | ✅ | PluginInput 带 `directory`/`worktree`(:56-60);dispatch 在 InstanceState.make 内(plugin/index.ts:130) |
| dispose 重建即重触发(免重启语义) | ✅ | hook dispatch 在 Plugin.state init(:240);instance dispose→重建→重 init |
| 相邻项目隔离 | ✅ 源码 | 同函数 event 订阅按 `ctx.directory` 过滤(:251);config 装配 per-instance |
| hook 收到的 cfg = 共享 config 对象 | ✅ | `const cfg = yield* config.get()`(:148),dispatch 传该 cfg(:243) |
| **变异 cfg.{mcp/skill/agent/command} 是否被各消费方看到** | ⚠️ **待真机** | hook 语义标注 "Notify"(:240 注释);对象是否单例 + 各消费方是否在 hook **之后**重读 config(尤其 mcp「读一次建连接」类)= 时序问题,源码判不死 |
| plugin host fan-out(动态 import `.alpha/plugins/*.js` 转发 hook) | ⚠️ 待真机 | 机制可行(hook 转发),但「插件列表先于 hook 已定」的鸡生蛋需实测转发时序 |

**真机 spike 清单(REQ-060 GO 前,需 ext 插件载体 T1)**:
1. hook 注入四路:mcp 连接 / skill 被发现 / agent 进选择器 / command 可用——逐路记录「变异后消费方是否看到」;
2. dispose→重注入生效(改 `.alpha/alpha.jsonc` 后下一条消息可用);
3. plugin host fan-out(自包含 JS + `tool.execute.before` 打点);
4. 相邻项目隔离(A 项目注入物在 B 不可见)——源码已强,真机确认;
5. 任一路不通 → 该路回退单指针(`<proj>/.opencode/opencode.jsonc`→`.alpha`),**回用户拍板**。

## 四、GO 建议(分阶段)

1. **REQ-059 全局层先行(G1 GREEN)**:sidecar 注入 `OPENCODE_CONFIG` + ext-config 写入切 `~/.alpha/alpha.jsonc`(mcp/plugin/治理键/provider 域)+ reconcile 迁移 + 全局桥退役 + 存量 `~/.opencode` 清理。真机验收(合并/dispose/junk-free/provider 压制)随实现顺带,无独立 gate 阻塞。
2. **REQ-060 项目级**:先做 T1 最小载体(`alpha-project-bridge` ext 插件的 config hook + 一条 fixture)→ 跑上节真机 spike 四路 → 判定表全 GREEN 才继续 fan-out/信任门/创建流全量;任一路不通停回用户。

## 五、附:本 spike 未改任何生产代码

纯源码核实 + 判定。分支 `feat/req059-060-config-truth` 仅含本文档。实现按 §四 GO 建议在后续增量提交。
