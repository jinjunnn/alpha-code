# 审计:前端 reskin 视觉回归根因 —— 546-sync 静默打断 DOM 锚点契约

> 2026-07-03 · 触发:用户 v0.1.0 桌面端截图批(图1–图9)+ 「已经回归非常多次了」
> 性质:append-only 证据(ADR-018);发现已登记 → [[REQ-010]](症状修复)/ [[REQ-012]](流程强化)/ [[C14]](结构治理)

## 结论(一句话)

**不是回滚,是上游合并静默作废了 reskin 依赖的 DOM 契约。** 546-commit 上游同步(2026-07-03)重写了上游前端 2.5 万行,把 alpha CSS-only reskin 挂钩的 **192 个上游锚点中的 94 个(49%)改名/删除**,换肤规则随即静默回落到上游默认样式。所有现有 gate(北极星守卫 / typecheck / test / 零冲突)全绿放行,v0.1.0 在其上打包发布、**前端零复验**。

## 证据链

### 1. 时间线(git 核实,非回滚)
- reskin 全套落地并当时核验:**2026-06-27 ~ 06-30**(`631970b2` 时间线 40 构件 / `23f972f2` 模型选择器接管 / `392efa39` picker 锚定 / `de4f5bd7` 时间线保真)。
- 546-commit 上游同步:**2026-07-02 20:47 `3b638e4a` / 07-03 02:14 `22107dd5`**(晚于 reskin)。
- `v0.1.0` tag = `02373249`,**在合并提交之后** → 用户运行的 v0.1.0 **包含**这次 sync。
- 全仓 `git log --all -i --grep="revert|rollback|回滚"`:**无一条碰 alpha-ui**(命中全是上游 core/mcp/OpenTUI)。⟹ **用户的设计工作没有被 git 回滚。**

### 2. 合并冲击面(定量)
- `git diff --stat 3b638e4a^1 22107dd5 -- packages/{app,ui,tui}`:**451 文件改,+25,381 / −24,988 行**。
- reskin 锚点对账(`data-component/action/slot`,脚本见本审计同日 session):**依赖 192,失效 94(49%),幸存 98**。

### 3. 死锚点 ↔ 用户报障映射(确诊)
| 用户截图 | 死掉的上游锚点 | 症状 |
|---|---|---|
| 图2 用户消息不换肤 | `data-component="user-message"` ❌ | 用户侧元信息/操作行回落上游默认 |
| 图2/时间线工具卡 | `tool-output` `tool-trigger` `tool-part-wrapper` `edit-tool` `write-tool` `bash-output` `task-tool-*` `todos` `reasoning-part` `text-part` `compaction-part` ❌ | 整个工具卡换肤挂空 |
| 图8/图9 新对话 | `session-new-composer` ❌ | 新会话 composer 异常 / 侧栏异物 |
| 图3/图9 发送圆环 | `dock-prompt`/`prompt-submit` **幸存** | composer 部分幸存→圆环处理错位(半挂状态) |
| 图6/7/8 模型卡 | `prompt-model` **幸存** | 模型卡组件仍能渲染→**证明非重建、是接线问题** |

**幸存/失效并存** = 用户看到的「有的换了新皮、有的还原回去」的物理解释。

## 为什么「回归非常多次」——结构性,非偶发

| 层 | 现状 | 后果 |
|---|---|---|
| **架构**(ADR-016 决策②) | reskin 挂钩上游内部 `data-component/slot` —— **非稳定公开契约**,上游自由改名 | 每次上游动这些组件 = reskin 断 |
| **自动化**(`sync-upstream.yml`) | dev→alpha **每日自动合并** | 断裂按天频率发生 = 「非常多次」 |
| **北极星 CI 守卫**(ADR-004) | 只查「有没有**编辑**上游文件」(file-diff) | 零冲突合并=零编辑=**绿**,即使换肤全碎 |
| typecheck / bun test | CSS 选择器不进类型系统,无锚点存在性断言 | 测不出 |
| **唯一语义 tripwire**(ADR-015,`sync-upstream.yml:61-80`) | 只覆盖 **prompt/agent** 底座 | **前端 reskin 无等价 tripwire** |
| **546-sync retro** | 只复验后端契约(WSL `probeAddable`);grep 前端/reskin/CSS/UI=**0 命中** | 前端从未被 sync 复验 |
| **结构缓解 C14**(ADR-016 待办①薄 re-export 收敛层) | `ready`/未启动 | 锚点分散 6 个 CSS 文件,断了也不集中、不报警 |

⟹ **每次日常 sync 都是对 reskin 的一次盲盒;除了用户肉眼,没有任何 gate 拦得住。** ADR-016 ⚠️ 早已预警此失效模式,但从未建防护。

## 流程强化建议(= [[REQ-012]],扩 ADR-015 的合并验证到前端)

团队已为 **prompt 层** 发明了正确范式(ADR-015:file-diff 测不出的语义漂移 → 合并验证 gate + sync tripwire)。**把同一范式复制到前端 reskin:**

1. **锚点契约测试(基石)**:把 reskin 依赖的上游锚点收敛成机器可读清单;测试断言每个锚点在上游产物/源码中仍存在。任何 sync 删/改锚点 → **CI 红**,合入 alpha / 打包前拦下。**静默→高声。** 单点最高杠杆。
2. **前端 tripwire**(`sync-upstream.yml`):镜像 ADR-015 prompt tripwire —— sync 触碰 `packages/{app,ui}` 承载锚点的组件 → `::warning` + label 要求人工视觉复验。
3. **post-sync 视觉冒烟 gate**:把 [[visual-verify-required]] 接进升级 runbook —— 每次上游合并后、tag/发布前,CDP 截图跑关键屏(首页/会话/模型卡/composer/时间线)对基线;这正是 546-sync 跳过的一步。
4. **收尾 C14**:把 94+ 分散锚点依赖收敛成单一映射层(ADR-016 待办① 薄 re-export);上游改名只改一处,测试(1)读它。

**结构性取舍(留用户拍板,非本审计裁决)**:根子是 ADR-016 主动耦合了易变的非契约 DOM。长期两条路 —— ⓐ 接受耦合 + 靠 gate(1)-(4)兜;ⓑ 对最高 churn 区(时间线工具卡)从 CSS-reskin 升级为**真 alpha 组件 + SDK 取数**(重,但彻底脱离上游 DOM 耦合,ADR-016 已把它列为 build-order 方向)。
