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
- ⚠️ 桥接未实测——由 [REQ-004](../../../docs/requirements/REQ-004-alpha-workdir-spike.md) spike 出 verdict 后回填;不通类目按 §3 降级并记录,**不回摆主决策**。
- ⚠️ 项目根多一个目录;symlink 桥会让 `.opencode/` 出现指针文件(用户可见,需文档说明)。
