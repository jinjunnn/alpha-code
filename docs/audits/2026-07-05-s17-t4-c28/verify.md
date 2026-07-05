# S17 T4(C28)验证记录 — 崩溃边界下沉 throw 实测 + REQ-014 家族活捉

> 2026-07-05,dev 实例(`bun run dev`,dev 恒开 CDP 9222)+ CDP 驱动(`scratchpad/cdp-probe.ts` 手法:Runtime.evaluate + Page.captureScreenshot)。

## 1. AlphaBoundary throw 实测(C28 验收③)— PASS

探针:`window.__alphaCrashProbe("AlphaSidebar")`(常驻设施,dev/打包同在)→ AlphaSidebar 子树响应式 throw。

| 断言 | 结果 |
|---|---|
| alpha 浮条命中(`[data-alpha-boundary="AlphaSidebar"]` 出现,文案「AlphaSidebar · alpha crash probe · 重载此区域」) | ✅ `boundaryShown:true` |
| 上游全屏 ErrorPage **未**出现 | ✅ `upstreamFullScreenError:false` |
| app 其余存活(首页 + composer 正常渲染) | ✅ `appAlive:true`(t4-02 截图同框可见诚实化后的两档权限 chip +「高」effort chip) |
| 复位 + 点「重载此区域」→ 浮条消失 + 侧栏复活 | ✅ `boundaryGone:true, sidebarBack:true` |

截图:`t4-01-before.png`(正常态)· `t4-02-crashed.png`(局部降级:侧栏空、浮条在右下、app 活)· `t4-03-recovered.png`(恢复)。
§7h 教训闭环:边界必须比上游(冻结 `app.tsx:274` AppBaseProviders)更内层——本次实测证明紧裹注入件的位置**先于上游命中**。

## 2. 顺带活捉:REQ-014 家族崩溃(上游恢复态 → 整屏)

实测中 dev 实例开局即循环崩溃(用户同步目击),完整链条取证:

- **症状**:`TypeError: Cannot read properties of undefined (reading '1')` @ 上游 `path-key.ts isWindowsPath`(`value[1]`,value=undefined)← `titlebar.tsx:283/307 createDirSyncContext(route.dir)` —— **route.dir undefined** → 上游 ErrorBoundary 全屏 ErrorPage(「出了点问题」),反复重试形成循环报错。
- **毒源**:settings store(`<userData>/opencode.global.dat`)的 `tabs` / `tabs.recent` —— recent.key 为**旧格式路由** `sidecar\n/server/<b64>/session/<id>`(**无 dir 段**),新格式按 `/:dir/session/:id` 解析 → dir=undefined;连带盘上存在 `opencode.workspace.undefined.*.dat`(undefined 被当目录名建档的历史痕迹)。
- **证据**:`req014-poisoned-tabs-evidence.json`(tabs 全量 + recent 原文)+ `req014-global-store-backup.dat`(清毒前原件)。
- **处置(即修复手法实证)**:删 global store 的 `tabs`/`tabs.recent` 两键 → reload → 完全恢复(errorPage:false)。**= REQ-014 修法②「main 预清 store」的技术可达性实证**。
- **对 REQ-014 拍板的输入**:① 症状 = **整屏**(上游崩溃屏,非布局内 Not found);② 毒点在 main 可直读写的 `opencode.settings`/global store,预清可行;③ 本次为 dev 实例 + dev 态数据,prod 包是否存在同形态旧 key 待查(风险:store 格式随版本演化,老用户可能携带)。
- **AlphaBoundary 的边界诚实声明**:此类崩溃发生在**上游子树**(titlebar),alpha 下沉边界**不覆盖也不应覆盖**(归属正确);根治仍归 REQ-014。

## 3. 过程发现(记录)

- dev 实例 CDP 端口是**上游既有设施**(`index.ts:262`:`!app.isPackaged` 恒开 9222;打包态 `ALPHA_CDP=1`)——本批曾误加重复开关后撤销;9333/9334 bind 失败真因 = 已装 prod app(S16 的 ALPHA_CDP=1 实例)一直占着 9222,dev 恒 append 9222 撞车。教训:**CDP 走查前先 `lsof -i:9222` 查占用**。
- 实测后环境已还原:dev 实例退出、用户 prod app 重新打开、dev store 毒键已清(原件备份在本目录)。
