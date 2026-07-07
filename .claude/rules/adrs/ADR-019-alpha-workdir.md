---
id: ADR-019
title: ".alpha 项目工作目录:alpha harness 产物全量收敛"
status: accepted
date: 2026-07-03
related: [ADR-002, ADR-005, ADR-006, ADR-014]
---

## 背景
用户问 alpha 是否应像 codex(`.codex`)/ Claude Code(`.claude`)那样有自己的项目工作目录、harness 落点是否该设计。事实核查:opencode **已有** `.opencode/`(tool/plugin/agent/command/skill/theme/opencode.jsonc,引擎运行时自动发现)+ 全局 `~/.config/opencode`;真问题 = **alpha 自有 harness 产物**(云任务 contract/artifact、run 记录、alpha 项目偏好、dispatch 状态)无固定落点。2026-07-03 用户拍板:**全部进 `.alpha/`**(否决「混合」作主案)。

## 决策
1. **`.alpha/` 是 alpha 在用户项目内唯一的自有工作目录**:凡 **alpha 写入**的项目级产物一律落 `.alpha/`,此后不再往 `.opencode/` 新增 alpha 私有内容。
2. **私有运行时产物直接落**(引擎不读,无需桥接):云任务 contract/artifact(B3/G4 回流落点)、run 记录、项目偏好。子目录 schema 由 REQ-004 spike 验证后**回填本 ADR 修订**。
3. **引擎自动发现的原语走桥接**(`.opencode/` 扫描路径在上游写死,零改上游 ADR-005):
   - **config 可寻址类**(`plugin[]` / `instructions[]` / `mcp.servers`):经 sidecar `injectAlphaConfig`(ADR-007/009 既有接缝)注入指向 `.alpha/` 内绝对路径;
   - **目录扫描类**(tool/skill/agent/command):实体落 `.alpha/`,`.opencode/` 内放 **symlink**(用户视角一切在 `.alpha`,引擎照常发现);
   - 桥接可行性由 REQ-004 实测(symlink 跟随 + ADR-006 Electron-Node 运行时行为);某类不通 → 该类回退**双写同步**(`.alpha` 为真源),最后手段 = 该类留 `.opencode/`,逐类记录在修订里。
4. **边界**:只管 alpha 写入物;用户自建的 `.opencode/` 内容**不迁移、不接管**(尊重 opencode 生态);全局 `~/.config/opencode` 不动。
5. **`.gitignore` 策略**:`.alpha/` 默认建议 ignore(运行时产物);可提交子集(如需共享的项目偏好)随 spike 回填拍板。

## 后果
- ✅ 用户视角单一工作目录、品牌一致(对齐 `.codex`/`.claude` 心智);alpha 产物与上游命名空间彻底隔离,升级绝缘。
- ✅ B3/G4 云任务 artifact 回流有确定落点;REQ-004 从「三选一」收敛为「验证 + 回填」。
- ✅ ~~桥接未实测~~ **已实测(见下方修订)**:①② 双通,回退③不启用。
- ⚠️ 项目根多一个目录;symlink 桥会让 `.opencode/` 出现指针文件(用户可见,需文档说明)。

## 修订(2026-07-03,REQ-004 spike 回填;证据:[audits/2026-07-03-req004-alpha-bridge-spike](../../../docs/audits/2026-07-03-req004-alpha-bridge-spike.md))

1. **§3 桥接 verdict(实测)**:
   - **config 注入 = CONFIRMED(生产在用)**——`injectAlphaConfig`(`sidecar.ts:146-219`)已用同机制注绝对路径(instructions/plugin/`{file:}`);上游 `plugin[]`/`instructions[]`/`mcp.servers` 均支持绝对路径。
   - **symlink 桥 = CONFIRMED(fixture 6/6 PASS)**——上游全部 `.opencode/` 扫描传 `symlink:true` → glob@13.0.5 `follow:true`(`packages/core/src/util/glob.ts:13-20`);目录链/文件链/**整 `.opencode` 目录链**/多跳链均被发现(one-hop 假说被运行时证伪,仅防环)。约束:tool/plugin 是单层 `*` + nodir → **须逐文件链**(目录链不可见);`instructions[]` 自身 glob 未传 symlink → 只用纯绝对文件路径形态(alpha 现状即如此)。
   - **双写同步(回退③)不启用**。
   - skills 备用通道:`config.skills.paths[]` 支持绝对路径(`skill/index.ts:211-219`),symlink 出平台问题时的免链替代。
   - **ADR-006 叠加不变**:桥进 `.alpha/` 的 tool/plugin 仍必须预 bundle 自包含 JS(symlink 只解决发现,不解决生 TS 加载)。
2. **§2 子目录 schema(回填)**:`.alpha/runs/<runId>/`(contract.json · status.json · artifacts/,= B3/G4 回流落点)· `.alpha/prefs.json`(项目偏好)· `.alpha/{skills,tools,agents,commands}/`(桥接真源,`.opencode/` 内放同名 symlink)。identity/behavior/secrets 属**全局级**产物留 userData,不进项目 `.alpha/`。
3. **§5 gitignore(回填拍板)**:整个 `.alpha/` 建议 ignore(运行时产物);可提交子集暂不引入(YAGNI)。
4. **写盘守卫**:复用 `safeResolve`(realpath 防逃逸)+ `writeKey` 原子写 + `syncSecretFiles` 0600 模式;`.alpha/` 根须加入路径白名单(实现随 B3 T2)。

## 修订(2026-07-04,新增全局层 `~/.alpha`;S12/REQ-018 定制中心通用化)
原 ADR 只定义**项目级** `<项目>/.alpha/`。定制中心 v3(ADR-014 v3)的全局安装物需要**全局层**,故补:
1. **`~/.alpha/` = alpha 全局自有目录**(`alphaGlobalRoot()`,`ALPHA_GLOBAL_DIR` 可覆盖用于测试)。子目录:`installs.json`(安装账本 receipts)· `{skills,agents,plugins}/`(全局安装真源,`~/.opencode/<类>` 内放同名 symlink 桥,与项目级同构)· `commands/`(预留)。
2. **桥法拍板(D1)= `~/.alpha` 真源 + `~/.opencode/<类>` symlink 桥**(与项目级同构;原生 CLI 也可见=装一次处处用)。`alpha-bridge.ts`:全新 kind 用整目录链,已存在真实目录退化逐条目链,卸载只拆自有链、不碰用户内容/共享 dir-link。
3. **MCP/plugin 引擎侧持久化 = `~/.opencode/opencode.jsonc`**(文件通道,非 `.alpha`)——home `.opencode` 是引擎原生 config 源,实例 reload 可见;**不设 `~/.alpha/connectors.json`**(jsonc + receipts 即全部真相,避免双真相)。
4. **原「全局产物留 userData」限定**:identity/behavior/secrets 等 **alpha 内部**产物仍留 userData;`~/.alpha` 承载**用户可见的全局安装物**。MCP 密钥仍走 userData 的 `{file:}` 通道(`alpha-mcp-secrets/`,A6),不进 `~/.alpha`。
5. **存量迁移**:T2 之前写进共享 `~/.config/opencode` 的 alpha 安装物 → 一次性迁 `~/.alpha`(`alpha-migrate.ts`,只迁 catalog 名字匹配项、不碰用户自建;门控 `ALPHA_MIGRATE_ENABLE`,A6 真机验证后开);`ALPHA_LEGACY_INSTALL_ROOT=1` 逃生回旧行为。
6. **§4 边界不变**:用户自建的 `~/.opencode` / `~/.config/opencode` 内容不迁移、不接管。

## 修订(2026-07-07,REQ-052 —— 不变量成文:`.opencode` 内 alpha 自有条目只允许指向 `.alpha`)
用户点名(环境重建时打开 `~/.opencode/skill/` 见 skill-creator/agent-creator 两条直链 app Resources 的 symlink):出厂技能通道(REQ-036 初版,factory-skills.ts)走了「`.opencode` 直链 app 资源」的零拷贝捷径,跳过 `.alpha`,破坏「用户视角一切在 `.alpha`、`.opencode` 只是引擎发现面」的心智——目录安装链路(alpha-bridge)一直合规,唯此通道漂移。就此成文:
1. **不变量**:`.opencode`(全局与项目级)内 alpha 自有条目只允许两种形态——① 指向 `.alpha` 真源的 symlink(dir-link 或 item-link);② `opencode.jsonc` 内的 config 条目。**内容本体(包括仅指向 app 打包资产的链)一律先落 `.alpha`**;任何新安装/注入通道(含出厂/vendored 资产)都必须经 `.alpha` 中转一跳。
2. **出厂技能改两跳桥**(REQ-052):`~/.alpha/skills/<name>` → app 资源(真源,零拷贝保留)+ 复用 alpha-bridge 落 `~/.opencode/skills`(多跳 symlink 引擎可见,REQ-004 spike 实测);启动 reconcile 自动迁移旧直链并顺手拆掉空的 `~/.opencode/skill/`(仅 `isAlphaFactoryLink` 判定为我方的链才拆,用户真实目录/异源链照旧不碰,§4 边界不变)。

## 修订(2026-07-07,REQ-059 —— 引擎配置真源入 `.alpha`:`~/.alpha/alpha.jsonc` + `.opencode` 指针化收官)
用户拍板(「一会 alpha 一会 opencode,租户都蒙了;最小量改动」,真源命名 `alpha.jsonc`):REQ-052 不变量此前只覆盖**内容本体**(安装物),alpha 写入的**引擎 config 文件本体**(`~/.opencode/opencode.jsonc`:mcp / plugin / REQ-037 治理键)仍是 `.opencode` 内最后一个 alpha 真身——租户查看自己装的连接器必须进 opencode 牌目录。就此收官:
1. **不变量适用范围扩展**:「内容本体一律先落 `.alpha`」扩到 **config 文件本体** —— alpha 写入的引擎配置唯一真源 = `~/.alpha/alpha.jsonc`,`~/.opencode/opencode.jsonc` 降为指向它的 file symlink。此后全局 `.opencode` 内 alpha 痕迹**只剩指针**;引擎自产物(package.json / node_modules / .gitignore,plugin bootstrap)按目录落于 `~/.opencode`,属引擎所有,不在不变量射程。
2. **机制依据(源码钉死,2026-07-07)**:上游 `packages/opencode/src/config/paths.ts` `ConfigPaths.directories()` 把 home `.opencode` **无条件**并入每个 instance 的 config 源(start=stop=home 的 walk)→ `~/.opencode/opencode.jsonc` 对全部项目会话生效(S16 真机实证的机制解释),且与 [[REQ-058]] sidecar cwd 改动零耦合;引擎 config 写面只有 XDG 全局与 `.opencode/.gitignore`,从不写本文件(symlink 无被碾风险);引擎的文件名要求(`opencode.json(c)`)由指针满足,真源改名 `alpha.jsonc` 引擎无感(`$schema` 保留,编辑器补全不受影响)。
3. **迁移** = 启动 reconcile(REQ-052 同款,幂等):存量普通文件过**所有权判定**(顶层键 ⊆ {$schema,mcp,plugin,agent,permission,command} ∧ mcp 名 ⊆ receipts ∧ 治理键 ⊆ 治理面)→ 整文件迁 + 原位换链;疑用户手写 → bail-out 不迁不碰(loud,该机维持旧目标,功能零损失);逃生 `ALPHA_JSONC_TRUTH_DISABLE=1`(回本修订前行为),`ALPHA_LEGACY_INSTALL_ROOT` 语义不变。
4. **盘点定界**(「还有哪些配置要一起改」的裁定,详表见 [[REQ-059]] 档):provider/BYOK 设置域留共享 XDG(生态互通刻意为之,无 provenance 不可安全迁);项目级 `.opencode` 配置 = 生态位不接管(alpha 从不写);`alpha.env`/receipts/automations/项目 `.alpha` 已合规;`.mcp.json` 不做(Claude Code 私有约定,引擎零处读取,导入归 [[REQ-034]]);**将来**若需 alpha 写项目级引擎配置,同构约定 `<proj>/.alpha/alpha.jsonc` + 指针(本修订只立约定,不实现)。
5. **后果**:✅ 租户心智一句话成立(「`.alpha` 是你的,`.opencode` 是引擎的」),连接器配置的用户口径统一为 `~/.alpha/alpha.jsonc`;⚠️ 对 home `.opencode` config 源的依赖自 REQ-018 T2 既已存在,本修订未新增上游耦合(paths.ts 变动由 sync 契约 diff 纪律覆盖);⚠️ bail-out 态(用户手写混入)该机维持旧布局,功能零损失、品牌收敛暂缓。

## 修订补充(2026-07-07 晚,用户四连拍板收口 —— **全面零 `.opencode`**,撤销同日上一修订的 symlink 通道)
用户四连拍板(①项目内五类生成物全落 `.alpha` ②接管 XDG provider 域与项目 config ③每个项目不要出现两个目录 ④用户级一并消灭 `.opencode`、不用 symlink):**alpha 在任何层级不再创建任何 `.opencode`**。
1. **通道改道**(真源 `~/.alpha/alpha.jsonc` / `<proj>/.alpha/alpha.jsonc` 不变):全局 = `OPENCODE_CONFIG` 原生 additional-config 合并(v1 `config.ts:401` per-instance、dispose 重读、junk 循环不含之;上游文档 `customize-opencode.md:431` 语义背书)+ ext 插件 `config` hook 备援(`plugin/index.ts:240-249`,per-instance,PluginInput 带 directory/worktree);项目 = 同一 hook 注入(项目唯一目录 = `.alpha`,信任门必做:项目自带 mcp/plugin 首次加载 per-project 确认,ADR-021 模式)。per-route 可行性由 T0 spike 对 v1/v2 双装载器逐路裁定;回退 symlink 需用户重拍板。
2. **provider/BYOK 写入域迁真源**(接管 XDG):alpha 永不再写 `~/.config/opencode`;merge 序(home/OPENCODE_CONFIG 在 XDG 后)压制残留,copy-don't-delete 迁移。
3. **全局目录桥退役**(修订 2026-07-04 D1 与 REQ-052 两跳桥的 `.opencode` 半跳):skills/agents 等经通道注入;存量 `~/.opencode` reconcile 清理(alpha-owned 拆除;残余仅引擎 junk 白名单则整目录删;含用户内容留 + loud,§4 边界不变)。
4. **接受的损失(用户指令覆盖)**:原生 opencode CLI 对 alpha 安装物可见性放弃(D1「装一次处处用」作废);⚠️ G2 hook 语义标注 "Notify",变异可见性逐路实测是 GO 前唯一闸门。
5. 载体:REQ-059(全局,已修订)+ REQ-060(项目级,T0 后立);权威方案 = `docs/designs/2026-07-07-project-alpha-only-extensions.md` v3。
