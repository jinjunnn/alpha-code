# alpha-code 核心目标

> 本文只记录长期产品目标、成功信号与边界,不记录当前 Sprint、Issue
> 状态、优先级或完成比例。活跃交付见
> [`alpha-code` Issues](https://github.com/jinjunnn/alpha-code/issues) 与
> [`Alpha Delivery`](https://github.com/users/jinjunnn/projects/2);产品组合目标见
> [`alpha-work/GOALS.md`](https://github.com/jinjunnn/alpha-work/blob/main/GOALS.md)。

## Mission

交付一个 Alpha 自有、可信且可分发的桌面编码 agent:复用成熟的 opencode
引擎能力,但让用户可感知的产品体验、特权边界和升级策略由 Alpha 明确拥有。

## G1 — 上游升级隔离

成功信号:

- upstream 同步对 Alpha-owned 路径零静默覆盖;
- 上游源码变更和 Alpha 适配边界由机器守卫发现;
- 契约适配集中在公开 SDK/plugin/interface seam,不散落私有补丁。

Guardrails:

- `dev` 保持 upstream 镜像,产品交付在 Alpha 分支;
- 不为便利复制或长期 fork agent core、session、context 与 tool engine;
- 所有必要的 seam 变更必须可测试、可恢复并在 ADR 中说明。

## G2 — Alpha 拥有产品表面

成功信号:

- Home、Draft、SessionWorkspace、Settings 与恢复路径有显式 Alpha
  ownership、typed boundary 和独立回退;
- 路由、页面与 runtime ownership 可分别验收,不以 CSS/DOM 覆盖伪装完成;
- terminal、diff、viewer 等成熟重型能力可作为可替换引擎组件复用。

Guardrails:

- 不扩大无类型 Portal、DOM anchor 或 MutationObserver 接缝;
- 未证明 URL、draft、session、provider 生命周期等价前不切默认路径;
- 用户数据格式和回退路径保持向后兼容。

## G3 — 可信本地能力与扩展运行时

成功信号:

- renderer 输入不能直接授权文件删除、进程执行、凭据使用或持久安装;
- extension manifest、receipt、安装事务、权限和恢复由 main-owned 边界强制;
- prod/beta/dev 的可变状态隔离,更新与撤销可审计且可回滚;
- Artifact/Browser 等高权限能力默认隔离、限额并持续向用户可见。

## G4 — 清晰的云边界

成功信号:

- 桌面只经版本化模型、MCP、job 和 artifact 契约调用 `alpha-platform`;
- 登录、授权与账户体验经 `alpha-web` 的明确 token purpose 完成;
- 本地运行仍可独立工作,云故障不会伪装成功或破坏本地数据。

Guardrails:

- `alpha-code` 不复制云计费、平台密钥或多租户 enforcement;
- 发送到云端的内容、目的和回退必须诚实可见;
- 云返回的状态和产物始终经过本地信任边界验证。

## G5 — 多 harness 可演进

成功信号:

- opencode、Claude Code 与 Codex 通过显式 adapter/contract 参与,而不是互相
  模拟私有运行时;
- 新 harness 可以先作为受控 executor 接入,再以独立验证决定是否进入会话级
  composition;
- harness 选择不破坏会话、权限、Artifact 和审计语义。

## Does not own

- 模型网关、云执行、计量和多租户 enforcement:`alpha-platform`;
- 公共站点、身份、计费体验和 Catalog 发布:`alpha-web`;
- Claude Code plugin 包装与发布:`alpha-code-plugin`;
- 跨仓需求和 Project 工作流:`alpha-work`。
