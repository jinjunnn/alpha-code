---
id: REQ-020
title: 定制中心 v3-M3:云能力进 hub(登录门控 + pipeline 条目)+ ADR-021 §2 三校验落地
type: feature
priority: P2
status: verified
repo: X
created: 2026-07-04
sprint: 2026-07-04-s14-ext-hub-m3
source: designs/2026-07-04-extension-hub-v3-universal.md(§6、§8 M3)
---

## 背景/证据
云对定制中心完全不可见:hub 与登录态零耦合(全文无 `window.api.auth` 引用);注入的 `mcp.cloud`(`sidecar.ts:201-213`)不在 UI;B 侧已 live 的 pipeline(research/**code-review PA-22**/docs)无入口。同时 **ADR-021 §2 三项上行硬校验(1MB 帽/secrets 扫描拒发/denied_paths 默认注入)至今未实现**(`alpha-cloud-jobs.ts:47-48` 薄透传;ADR-021:32 自认待实现,挂 B3 验收⑦)——云入口进 hub 与自动化云档位之前必须补上。

## 任务拆分(按优先级序)
1. **T1 ADR-021 §2 三校验落地**(与 B3 验收⑦ 合账):`dispatchCloudJob` 前置——envelope 序列化 >1MB 拒发(loud);`input/objective` secrets 模式扫描(API key/token/私钥块),命中拒发并指出字段;contract 未声明时默认注入 denied_paths(`.env* / *.pem / .alpha/ / .git/`);单测覆盖三路径。
2. **T2 云分区 + 登录门控**:hub 左栏「云能力」;未登录/BYOK → 条目灰显 + 诚实说明 + 登录 CTA(`window.api.auth.start`);platform 模式 → 状态点亮(mcp.status.cloud)。
3. **T3 cloud 连接器详情页**:4 工具(cloud_dispatch/status/await/artifacts)说明 + 数据边界(diff-only 优先/1MB 帽/denied_paths,引 ADR-021)+ 连接状态。
4. **T4 云 pipeline 条目**(catalog 新类型 `cloud`):research / code-review / docs;详情页 = 输入契约(`autonomy:pipeline, kind, input`)、预算默认(25 iter/300k tok/600s)与上限、tier、上行数据明细;「启用」语义 = 进 receipts 可用列表(不写引擎 config),供会话/自动化选用;code-review 提供 dispatch 入口(diff-only)。
5. **T5 E10 远程 catalog 客户端**(门:C 仓端点):签名增量 catalog(条目级 ed25519/minisign,离线验签失败回退内置);仍离线优先。

## 验收标准
1. dispatch >1MB / 含密钥样本被拒且错误信息指明字段;denied_paths 缺省注入在 envelope 中可见(单测+一次真发);
2. BYOK/未登录态云分区灰显文案正确、登录后点亮(真机双态截图);
3. code-review 从 hub 入口端到端一次(dispatch → 进度 → artifact 回流 `.alpha/runs/`,兼 B3 verified 项);
4. ADR-021 的「⚠️ 待实现」条随实现 PR 改 ✅ 并回写(完成同步纪律)。

## 非目标
计费/余额展示(账户面板域)、租户级安装漫游(B 侧存储,roadmap)、B16 consent 弹窗实现(parked,仅保留挂钩点)、E10 的 C 仓端点本体(仓 C)。

## 关联
依赖 REQ-018(receipts/分区框架);B3(verified 待真机项同场);E10(客户端半);B16(挂钩点);REQ-021 A3 与 REQ-022 的**硬前置**(无 §2 校验不得开云档自动化)。
