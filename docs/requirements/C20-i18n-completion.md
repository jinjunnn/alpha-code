---
id: C20
title: alpha-ui i18n 补全 + 全语种 OpenCode 残留清零
type: ux
priority: P2
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §6.3 / R7(每语种残留:zh 19 / en 30)
---

## 背景/证据
14 个 alpha .tsx 里 9 个零 i18n(Home/Onboarding/composer 工具条/两个 picker 硬编码简中)→ 切语言对主力界面无效,非中文用户永久中文 UI;brand transform 每语种只重写精选少数,残留 "OpenCode" 遍布每语种(zh:19/en:30/zht:18);原生崩溃对话框英文硬编码(`windows.ts:375-404`)。

## 验收标准
1. alpha-ui 9 个硬编码组件全部接 i18n(en+zh 起步);
2. 语言切换对全部 alpha 界面生效(截图核验两语种);
3. 各语种 "OpenCode" 自我指代残留清零(brand-i18n 清单扩充,`grep` 各语种文件为 0,真实事物名如 opencode.json 除外);
4. 原生崩溃对话框文案本地化或中英兼容。

## 关联
ADR-007(brand transform)、C29(已修崩溃屏一角)、B11/B20/C21(S8 同批)。

## 跳过记录(2026-07-04,/loop 自动批 — deferred)
本轮跳过(机械但**体量大 + 需双语视觉核验**):9 个 alpha 组件外化 + brand-i18n 各语种清单扩充 + 原生崩溃对话框;验收②③需切语言双语截图核验(en/zh),离线不可做 → 有漏 key 静默回退(空白/英残)风险且离线看不到。→ 并入专项 i18n 批(带双语视觉核验);后续可先拆低风险子任务(仅 brand-i18n 各语种 "OpenCode" 残留 grep 清零),但全量外化不在无人值守简单批。
