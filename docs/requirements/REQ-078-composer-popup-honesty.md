---
id: REQ-078
title: "@/+ 装配弹窗诚实化与能力补齐 — 附件真通道 + 「附加终端」文案如实 + 零查询钉变更文件"
type: ux
priority: P1
repo: A
created: 2026-07-09
status: ready
source: 用户议题②(2026-07-09 供给面简报)+ @/+ 弹窗全量审计实锤两处 placebo(C28);用户确认「登记即 ready」
---

## 背景(审计钉死,2026-07-09)

REQ-073 的 @/+ 统一装配弹窗(`composer-autocomplete-core.ts` + `composer-autocomplete.tsx`)今天提供:添加(文件和文件夹 / 附加终端 / 计划模式 / 第三方主档模式行)、Agent 引用(`v2.agent.list` 滤 hidden+internal)、文件引用(`find.files` limit=8,仅有查询词时)、扩展市场入口。对照引擎/上游能力审计出**两处 placebo 缺陷 + 三个高价值缺口**。

### 缺陷(违反 C28 反 placebo 纪律,先于新增能力处理)

1. **「文件和文件夹」行在两个模式下都送不进消息**:
   - home 上 `file.attach` 命令未注册(它由上游 prompt-input 组件挂载时注册,home 不挂载)→ 点击静默 no-op(catch 吞,composer-autocomplete.tsx:306-309);
   - session 页该命令打开的是**被 CSS 隐藏的上游 composer** 的附件流(composer-takeover.tsx:4-5),选中文件落进隐藏上游 prompt store,而 alpha 提交只发自己的 text+mentions(alpha-composer.tsx:532-540)→ **用户选的附件被静默吞掉**。REQ-055 v1 边界自认「附件/拖拽/图片粘贴不迁」,但弹窗行仍存在且看似可用。
2. **「附加终端」文案失实 + home 死行**:desc 写「把终端输出带进上下文」(composer-autocomplete-core.ts:170),实际 `terminal.new` 只打开终端 tab(use-session-commands.tsx:486-488,session 页注册);引擎**没有**终端输出→context part 的原语;home 上同样未注册 = 死行。

### 缺口(引擎/上游均已支持,alpha 弹窗未接)

- **附件真通道**:引擎 `FilePartInput` 支持任意 mime + dataUrl(图片/PDF/文本,sdk types.gen.ts:2560);上游冻结 composer 有粘贴(prompt-input.tsx:1579)、拖拽(drag-overlay.tsx)、原生选择器(prompt-input.tsx:1166-1168)三通道 + 类型白名单(constants/file-picker.ts)可参照。
- **零查询钉「变更/最近文件」**:`file.status`(git 状态)现成;上游 @ 菜单零查询时钉 open/recent files(prompt-input.tsx:692)。现状 alpha 零查询只给提示行(core.ts:197)。
- `find.files` limit=8 偏小,随手放宽。

## 验收标准

1. **T1 placebo 修复(先行)**:「文件和文件夹」行在真通道就绪前撤下或直接接 T2;「附加终端」文案改为如实(「打开终端面板」),home 上不展示不可用行;两个模式行为一致,失败路径 loud(不吞 catch)。
2. **T2 附件真通道**:alpha composer 自有附件 state + chips(图片/PDF/文本文件);原生选择器 + 粘贴 + 拖拽三通道;提交把附件并入 prompt parts(图片 = dataUrl FilePart);零改上游文件。
3. **T3 引用节零查询默认展示**:git 变更文件(`file.status`)+ 本会话最近引用;键盘可达;`find.files` limit 放宽。
4. 单测覆盖弹窗数据装配;CDP 截图核验([[visual-verify-required]]);GLOSSARY「输入语法分工」不漂移(`/` 执行,`@`/`+` 装配)。

## 非目标(均另拍另立)

- 行区间引用 `@path:12-40`(引擎吃 `file://…?start=&end=`,后续 tier);
- MCP 资源引用(`/experimental/resource`,NON_GOALS#4 须风险标注 + fail-soft);
- LSP 符号引用(`/find/symbol`);
- SubtaskPartInput 装配(@agent 已覆盖「指派」心智);
- shell 模式(模式节语义已钉死为主档,要做另立 REQ);
- prompt 历史 ↑/↓(composer 层缺口,非本弹窗)。

## 关联

- [[REQ-072]] / [[REQ-073]](已 archived,本 REQ 是其诚实化收尾)· C28 反 placebo 纪律 · [[ADR-016]]
