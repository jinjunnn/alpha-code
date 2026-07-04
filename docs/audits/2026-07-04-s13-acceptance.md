# S13 验收汇总(REQ-019 + REQ-023)

> 2026-07-04 · S13 定制中心 v3-M2 · 实现 PR = #74(T1+T2)/ #75(T3)/ #76(T4+T5+T6)/ #77(T7+T9)。
> 逐 PR gates:typecheck + tests + alpha-check(北极星)+ 评审(T1+T2 四线全审:代码/合规/DRIFT/安全;后续 PR 代码线深审)+ CDP visual-verify。
> 证据目录:audits/2026-07-04-s13-{t1t2,t3,t4-t5,t6,t7-t9}-visual-verify/。

## REQ-019 验收标准 ↔ 证据

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 六类条目详情页逐一截图核验 | ✅(五类实测 + 云占位) | t1t2(MCP/套件/技能/Agent/插件详情)+ t3(六类专属区块 7 图)+ t7-t9(agent 条目/vendored 插件) |
| 2 | 更新链路真机走通一例 | ✅ 引擎级(旧版 receipt → 角标/分组 → 更新 → receipt 翻新 → 角标消失,IPC 读回断言) | t4-t5/verify.md |
| 3 | 导入本地文件夹 skill 走通(含非法 frontmatter 拒绝) | ✅(合法入账 origin=imported + `../escape` 拒绝 + 重复拒绝 + 弹窗行内错误) | t6/verify.md |
| 4 | 依赖缺失详情页可见(卸 uv 实测) | ⚠️ 部分:实时 which ✓/checking 分支 + IPC 负例实证;卸 uv 像素证据递延真机批 | t4-t5/verify.md |
| 5 | 搜索/筛选/空态/骨架按 §5;Esc 逐级 | ✅(全局搜索跨 tab 持久+分组、来源/许可证筛选+清除空态、已安装骨架、Esc 弹框→详情→列表→关闭) | t1t2 + t7-t9/verify.md |
| 6 | 失败路径零裸 toast(行内) | ✅(onAdd 全类型/更新/导入/套件部分失败均行内;toast 仅成功) | t5/t6/t7 verify |

## REQ-023 验收标准 ↔ 证据

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 断网装 vendored plugin 全程成功 | ⚠️ 零网络由构造保证(资产随包、无下载步、config 绝对路径);关 Wi-Fi 真机走查递延真机批 | t7-t9/verify.md |
| 2 | 官方 agent 条目 Agent tab 可装可卸 | ✅(可安装 grid → 详情页先行(md+权限档预览)→ 安装入账;卸载走 removeFsInstall 管线) | t7-t9/verify.md |
| 3 | catalog 新字段就位 + plugin hooks[] 详情可见 | ✅(vendoredAssetKey/downloadUrl/AgentInstallSpec/hooks[];hooks 详情区块 t3-05) | t3 + t7-t9 |
| 4 | 安装状态机 UI 可见,失败行内可重试,零裸失败 toast | ✅(检查依赖…→安装中…;卡片/详情行内错误;套件逐项重试) | t7-t9/verify.md |
| 5 | 卸载按 receipt.files 净除,~/.config/opencode 零残留 | ✅(vendored 卸载三重断言:config 清空+目录删除+账本去项;测试全程隔离 profile) | t7-t9/verify.md |

## 真机批递延清单(并入 REQ-016 同场,签名包/登录态)

1. 卸 uv → markitdown/git 详情页「✗ 缺失 + brew 指引」像素核验(REQ-019 ④)
2. 关 Wi-Fi → vendored 插件从点添加到引擎加载全程(REQ-023 ①)+ osascript 回退通知实际弹出
3. Git 导入真克隆 happy-path(公网小仓库)
4. dispose 打断活跃流残余风险(承 S12 T8 旧账)
5. 打包件核验:resources/{agents,plugins} 进 dmg;签名/公证不受 vendored js 影响
