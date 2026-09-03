# `#1227` 右栏 PDF 叠放载体 —— 真 Chromium 证据

*2026-09-03 · Electron 42.3.3(Chromium 142)· macOS 15*

判的是一件事:**右栏点开一个 pdf,页面到底画出来了没有。**
成因分析在 [`docs/architecture/2026-09-03-electron-pdf-viewer-session.md`](../../architecture/2026-09-03-electron-pdf-viewer-session.md)。

## 为什么需要一个 Electron 判据

叠放层是 main 持有的 `WebContentsView`,内容在另一个进程上,发起它的 renderer 的 DOM 里
**没有它的节点** —— 单元测试能判的只有"参数对不对",判不了"画出来没有"。而这个缺陷的形状
恰恰是:参数全对、`loadURL` resolve、`did-finish-load` 触发,画面全黑。

## 判据

`harness/main.cjs` 调**生产模块**的 `openRailPreview`(`rail-preview-host.ts` 经 `bun build`
打成 CJS、electron 外置),等 5 秒,然后:

| 量 | PASS 阈值 | 说明 |
| --- | --- | --- |
| `nonDarkPercent` | > 20 | 叠放 view 位图的非暗像素占比(黑屏态实测恒 `0.0`) |
| `frameCount` | ≥ 3 | 第三个 frame 是真正渲染页面的 plugin OOPIF;黑屏态只有 2 个 |
| `partitionsAfterClose` | 为空 | `persist:` 分区目录在 close 之后必须被收掉 |

## 结果

| 版本 | nonDarkPercent | frameCount | blockedPaths | 结论 |
| --- | --- | --- | --- | --- |
| 修复前(`#1227` 之前的 `rail-preview-host.ts`) | `0.0` | 2 | 5 条 `"null"` | **FAIL** — `results/before.png` 是一块 #242424 |
| 修复后(本次工作树) | `93.6` | 3 | 无 | **PASS** — `results/after.png` 可读出页面文本 |

红对照不是构造出来的:它就是这台机器上装着的 0.1.9 的行为。

## 复跑

```bash
bash docs/verification/2026-09-03-1227-rail-pdf-session/run.sh          # 判当前工作树 → results/after.*
bash docs/verification/2026-09-03-1227-rail-pdf-session/run.sh HEAD~1   # 取任一 ref 的红对照
```

需要一个装好 `electron/dist` 的 checkout(worktree 里常常只有包没有二进制;脚本会自动回退到
主 checkout 的 `node_modules`,找不到就明说并以 2 退出,不会给出"跑不起来 = 绿"的空结论)。
PDF 夹具由脚本现场生成(单页、含可见文本),不进仓;`harness/probe-bundle.cjs` 每次现打包、
跑完删除。
