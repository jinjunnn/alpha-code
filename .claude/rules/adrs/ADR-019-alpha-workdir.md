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
