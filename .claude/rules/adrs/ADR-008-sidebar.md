---
id: ADR-008
title: Codex 风格左边栏 — AppInterface children + Portal 注入,数据走 SDK,CSS 接缝替换 V2 chrome
status: accepted
date: 2026-06-17
related: [ADR-003, ADR-007]
---

## 决策(全部落 `packages/ui-mac/*`,零改 upstream)
1. **挂载**:自有 `<AlphaSidebar>` 作 `AppInterface` 的 `children`(身处 Router + 全部 Provider 内),Solid `<Portal>` 投到 `document.body`(fixed,逃出偏移容器、保留响应式上下文)。
2. **数据**:`@opencode-ai/sdk/v2/client`(**必须 `/client` 子路径**;`/v2` barrel 带 Node-only 依赖会崩 renderer)。`project.list()` + 按目录 `session.list` + `/global/event`(跨目录 firehose;`/api/event` 按 directory 过滤收不全)。`list()` 默认不抛,**必须判 `{error}`** 否则列表清空。
3. **替换 V2 chrome**:scoped 于 `body[data-alpha-sidebar]` 的 CSS 隐藏上游顶栏/首页冗余 chrome,侧栏独占导航。
4. **强制 V2**:`alpha-defaults.ts` 一次性置 `settings.v3.general.newLayoutDesigns=true`(`ALPHA_LEGACY_LAYOUT=1` 可关)。
5. **品牌/行为**:α Mark + "ALPHA CODE";新会话即时 `session.create({directory})` 后跳转;项目归档/移除 = 客户端 hide(`alpha.sidebar.hidden` localStorage,opencode 无删项目接口)。
6. **顶栏自有工具条**:收纳/首页/前进后退、终端/审查 toggle(经 `command.trigger`);`ui-mac/scripts/patch-upstream.ts`(第二个 build-time transform)调审查面板宽度。

## 上游耦合点(改名只"外观回退",非 merge 冲突,sync 后重指即可)
CSS 选择器(titlebar tabs / layout V2 fallback / home 280px aside / `Logo` 字标 / `aria-controls="review-panel"`);`patch-upstream.ts` 两条子串(`session.tsx` `0.45`→`0.7`、`layout.tsx` `DEFAULT_SESSION_WIDTH`);base64 路由编码;`/global/event` 信封形状 + `session.create` / `session.list(scope)` 契约;worktree `"/"` = 全局约定。

## 后果
- ✅ 深度定制 UI,零改 upstream;破坏面均外观级可恢复。
- ⚠️ 数据是 SDK 薄重取(SSE 实时),不复用 opencode 内部 session store;"插件/自动化"无 opencode 后端(占位)。
