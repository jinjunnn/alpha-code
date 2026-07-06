# Sprint 2026-07-06 S25 —— B16 PIPL 数据出境同意/告知门

> **抽取(2026-07-06,S24 收批后用户 GO)**:B16(P1 security,发布短名单 #5,parked→重启)。用户四轮提醒后拍板 GO。重启条件已齐(非技术用户入画像 REQ-008 D3 + 云派发 verified)。ADR-021 §4 两个 consent 挂钩点落地。WIP=1 满足(S24 已收尾)。
> **纪律**:显式=可执行同意门(ADR-021 §4),隐式=诚实告知不装过滤(§3);同意门写盘失败不静默放行(反 placebo);覆盖面如实声明(MCP facade/云自动化路径不覆盖,登记残余)。

## Task 表

| # | 项 | 验收 | 状态 |
|---|---|---|---|
| T1 | 显式通道纯核 + prefs I/O:`alpha-cloud-consent.ts`(parsePrefs/hasCloudConsent/withCloudConsent,版本化)+ alpha-workdir readProjectPrefs/writeProjectPrefs(.alpha/prefs.json 守卫复用) | 单测:损坏 prefs 不误判/版本不匹配重弹/合并不丢字段/往返落盘/非法目录拒 | ✅(15 单测) |
| T2 | 显式门接线:cloud-dispatch IPC 增 directory;main 侧 ensureCloudConsent(原生对话框,诚实告知+勾选;同意写 prefs、拒绝 consent-declined;写盘失败不放行);preload/types/renderer 分流 + dispatchError 映射 + i18n(en/zh) | typecheck 绿;派发链 directory 贯通 | ✅ |
| T3 | 隐式通道(C 侧,alpha-web PR #9):授权同意页平台代付告知行(+ BYOK 逃生 + /privacy 链接)+ 隐私政策修正 §2 误导 + 增出境专章(平台代付默认/云执行可选/首次 per 项目同意) | next build 绿;措辞与 A 侧口径一致 | ✅ |
| T4 | 文档:ADR-021 §4 翻已落地 + B16 建档 + BACKLOG(短名单#5/待拍板队列/parked/Active-P1/sprint)+ CHANGELOG | 四件套齐 + ADR/短名单/队列一致 | ✅(PR #123) |

## Gates
- `scripts/alpha-check.sh` 全绿;alpha-ci 四关随 PR;alpha-web next build 绿;
- 真机递延:同意门实拍 / 拒绝路径不派发 / prefs 落盘 / 同意后二次不弹 → 下一真机批。

## 明确不做(如实声明覆盖边界)
- 不做隐式通道过滤/改写(ADR-021 §3);义务止于告知 + BYOK 逃生。
- MCP facade(会话内 agent cloud.* 工具)派发不经 main → per-项目门不覆盖(会话内显式指令 + B schema 兜底 + 隐式告知已在登录);云自动化(REQ-025)直连 B → 不覆盖(仅任务文本上云)。两者登记残余,不在本批扩覆盖。

## 结果(2026-07-06 回填)

**B16 全落(A 侧 PR #123 + C 侧 alpha-web PR #9)= shipped**:
- 显式:`alpha-cloud-consent.ts` 纯核 + `.alpha/prefs.json` I/O（15 单测）+ `cloud-ipc.ts` 原生同意门（诚实列出境内容/去向/逃生/per-项目 + 「我已知悉」勾选；写盘失败不静默放行）；派发链 `dispatch(envelope, directory)` 贯通。
- 隐式:授权页平台代付告知行 + 隐私政策修正 §2 误导 + 增出境专章（alpha-web PR #9，next build 绿）。
- 文档:ADR-021 §4 翻「已落地」+ B16 建档 + BACKLOG 五处同步（短名单/队列/parked/Active-P1/sprint）+ CHANGELOG。
- gates:北极星守卫 ✓ typecheck ✓ 单测全绿。

**verified 门（真机递延）**:同意门实拍 / 拒绝不派发 / prefs 落盘 / 二次不弹 → 下一真机批。
**残余（如实）**:MCP facade 与云自动化派发路径不经本门覆盖，已登记 [[B16]] 档非目标节。
