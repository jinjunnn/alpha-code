---
id: ADR-003
title: 前端走 B+A(挂 AppInterface + 自定义 Platform + token 换肤)
status: accepted
date: 2026-06-14
---

## 决策
复用 `AppInterface`(`packages/app/src/app.tsx`)+ 自定义 `Platform`(~40 方法 host 接缝)+ token 主题,屏幕按需逐个替换;Mac 外壳保留 Electron,复用 `packages/desktop` 的 sidecar + `window.api` 模式。(放弃纯换肤方案 A / 全新 SDK 渲染器方案 C。)

## 后果
- ✅ 最快起步,白嫖状态/同步/事件/permission/diff 层,升级摩擦小,保留向 C 渐进迁移的路。
- ⚠️ 改官方 `pages/*` 视觉会在升级时 merge 大文件 → 视觉改造优先走 token + 自有组件,不改 `pages/*` 内部。
- ⚠️ 复用 app/ui + 内嵌 server 需从源码构建(它们 `private:true`)。
