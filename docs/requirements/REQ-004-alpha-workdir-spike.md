---
id: REQ-004
title: ".alpha 项目工作目录:全量收敛方案验证(用户已定向)"
type: spike
priority: P2
status: archived
repo: A
created: 2026-07-03
sprint: 2026-07-03-s11-cloud-loop
---

## 背景(为什么)
用户提问:软件是否应该像 codex(`.codex`)/ Claude Code(`.claude`)那样在项目根目录生成 `.alpha` 工作目录?harness 落点是否该设计?

**事实核查**:opencode **有**项目级工作目录——`.opencode/`(`tool/ plugin(s)/ agent/ command/ skill/ theme/ opencode.jsonc`,运行时自动发现,见 GLOSSARY)+ 全局 `~/.config/opencode`。所以「opencode 没设计」不成立;真问题是 **alpha 自有 harness 产物**(云任务 contract / artifact、run 记录、alpha 项目偏好、dispatch 状态)落哪。

## 用户决策(2026-07-03)
**主案 = 乙:全部进 `.alpha/`**(用户:「我希望可以全部进 alpha」)。原「丙:混合」降为回退方案。spike 任务从「三选一」变为「**验证乙案的可行边界与桥接机制**」。

## 可行边界(登记即知的技术事实)
- ✅ **无条件可行**:alpha 私有运行时产物(云任务 contract/artifact、run ledger、偏好、dispatch 状态)——引擎不读它们,落点完全自主,直接进 `.alpha/`。
- ⚠️ **需桥接**:需要 opencode 引擎**自动发现**的项目级原语(`.opencode/{tool,plugin,agent,command,skill}` 与 `opencode.jsonc`)——扫描路径写死在上游、零改上游(ADR-005)改不了路径。桥接候选(全部零改上游,spike 逐一实测):
  1. **config 可寻址类**(`plugin[]` / `instructions[]` / `mcp.servers`):经 sidecar `injectAlphaConfig`(既有接缝,ADR-007/009)注入指向 `.alpha/` 内绝对路径 → 预期直接可行;
  2. **目录扫描类**(tool/skill/agent/command):实体落 `.alpha/`,`.opencode/` 内放 **symlink** → 用户视角一切在 `.alpha`,引擎照常发现;须实测上游扫描器跟随 symlink + ADR-006 运行时(Electron-Node 预 bundle)下不炸;
  3. **回退:双写同步**(`.alpha` 为真源,写入时镜像到 `.opencode/`)——最稳但有一致性维护面。
- 📌 边界约定:`.alpha` 策略只管 **alpha 写入的东西**(定制中心/云任务/偏好);用户自己手写的 `.opencode/` 内容不搬(尊重 opencode 生态习惯)。

## 验收标准(可验证,逐条)
1. 桥接三法逐一实测出 verdict(config 注入 / symlink 发现 / 双写),file:line + 复现步骤记录;
2. ADR 落 `.claude/rules/adrs/`(proposed→accepted):`.alpha/` 目录 schema、`.gitignore` 策略、桥接机制选型、云任务产物(B3/G4)落点、与用户自有 `.opencode/` 的边界;
3. 零改上游复核:`.opencode/` 运行时发现机制不受影响(北极星守卫绿);
4. 与 B3/G4 artifact 回流路径对齐(dispatch 结果写 `.alpha/` 何处、会话内如何引用)。

## 非目标
- 全局配置(`~/.config/opencode`)不动;
- spike 内不做全量实现,只验证 + 决策。

## 方案 / 关联
关联:B3/G4(云任务产物是首个真实租户)、ADR-014(定制中心写盘路径)、ADR-006(运行时世界)、ADR-002/005(零改上游)。

## 验证记录
- **2026-07-03(S11 T1,spike 完成)**:桥接三法 verdict = **config 注入 CONFIRMED(生产在用)· symlink 桥 CONFIRMED(引擎同款 glob fixture 6/6 PASS,含整目录链与多跳链;one-hop 假说证伪)· 双写回退不启用**。上游全线 `symlink:true`(`packages/core/src/util/glob.ts:13-20`,glob@13.0.5);约束:tool/plugin 须逐文件链 + 预 bundle JS(ADR-006);skills 备用 `config.skills.paths[]`。schema/gitignore 已回填 [ADR-019 修订](../../.claude/rules/adrs/ADR-019-alpha-workdir.md)。全证据:[audits/2026-07-03-req004-alpha-bridge-spike](../audits/2026-07-03-req004-alpha-bridge-spike.md)。
- **待(verified 门槛)**:打包态 in-app 桥接冒烟(随 B3 T2 同场:artifact 写 `.alpha/runs/` + 一条桥接 skill 被引擎发现)。
