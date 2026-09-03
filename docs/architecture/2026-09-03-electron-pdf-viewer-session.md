# Chromium 内置 PDF viewer 在 Electron 隔离 session 里的真实行为

*勘破日期 2026-09-03 · Electron 42.3.3(Chromium 142)· macOS 15 (darwin 25.3.0) · 票 `#1227`*

右栏文件查看器的 PDF 叠放载体(`packages/ui-mac/src/main/rail-preview-host.ts`)自 `#244`
落地起就是**整块深色空白**。本文记录把它跑出来之后看见的真实行为 —— 不是读文档、不是推断,
命令与数值都可复跑(`docs/verification/2026-09-03-1227-rail-pdf-session/run.sh`)。

## 结论先说

Chromium 的 PDF viewer 不是渲染器的一个内建能力,而是**一个内建扩展 + 一套 chrome://resources
上的界面代码**。因此它在两个地方会被隔离配置无声掐死:

| # | 前提 | 不满足时发生什么 |
| --- | --- | --- |
| 一 | session 必须是**落盘的**(`persist:` 分区或默认 session) | 扩展在 off-the-record profile 里根本不装载 |
| 二 | 网络面必须放行 `chrome://resources/` | 扩展装载了,但它的界面脚本一条都取不到 |

**两条都不报错。** 两条都表现为同一个画面:viewer 的深色底色铺满,页面不出现。少修任何一条,
症状与完全没修一模一样 —— 这正是它在 `#244` 之后活了这么久没被发现的原因。

## 观测手段(以及为什么不能用 DOM 探针)

叠放层是 main 持有的 `WebContentsView`,内容画在**另一个进程**上;发起它的 renderer 的
DOM 里没有它的任何节点。所以判据只有两个:

1. `webContents.capturePage()` 的位图 —— 统计非暗像素占比(采样步长 37 像素);
2. `webContents.mainFrame.framesInSubtree` 的 frame 树。

frame 树是这里最有价值的一个信号,因为它把"装载到哪一步"说清楚了:

- **2 个 frame** = 根文档 + `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html`。
  mime handler 已经把 viewer 挂上了 —— 所以"URL 装载成功""did-finish-load 触发"
  这些常见的健康信号**全是绿的**,而页面根本没渲染。
- **3 个 frame** = 多出一个 URL 与根文档相同的子 frame,那是真正画页面的 plugin OOPIF。
  只有它出现,用户才看得见东西。

> 只看 `did-finish-load` / `loadURL` 的 resolve 判"PDF 显示了",会一路绿到用户面前。
> 本仓《本机验证陷阱》里"绿但其实没测生产路径"的又一个实例。

## 成因一:off-the-record profile 不装载扩展

`session.fromPartition("alpha-rail-preview-<id>")` —— 没有 `persist:` 前缀 —— 在 Electron 里
是**内存态(OTR)profile**。Chromium 不在 OTR profile 里启用内建扩展,PDF viewer 是其中之一。

同一份配置(同一个自定义协议、同一组 deny handler、`plugins: true`),只改分区形态:

| 分区形态 | 非暗像素 | frame 数 | 结果 |
| --- | --- | --- | --- |
| `alpha-rail-preview-<id>`(内存) | 0.0% | 2 | 深色空白 |
| `persist:alpha-rail-preview-probe`(落盘,固定名) | 93.6% | 3 | 页面正常 |
| `persist:alpha-rail-preview-<id>`(落盘,一次性名) | 93.6% | 3 | 页面正常 |
| 默认 session | 93.6% | 3 | 页面正常 |

内存分区下 Chromium 自己也会在 console 里说一句
`Not allowed to load local resource: chrome://resources/css/text_defaults_md.css` ——
那是**扩展没装载**的次级表现,不是成因二。两者的区别是:内存分区下这条由 Chromium 拒绝,
落盘分区下这条能装载,但会撞上成因二的白名单。

被证伪的三个方向(都跑过,都不是):

- **不是 webRequest 白名单**(把过滤器整个换成放行,内存分区仍然 0% / 2 frame);
- **不是自定义协议的 privileges**(补上 `secure` / `supportFetchAPI` / `stream` / `corsEnabled`
  之后,内存分区仍然 0% / 2 frame);
- **不是自定义协议本身**(默认 session 用同一个 `alpha-artifact-preview://` 协议正常渲染)。

## 成因二:viewer 的界面整个住在 `chrome://resources/`

分区改成 `persist:` 之后仍然全黑。生产模块自己的日志面(`__setRailPreviewLogSink`)
给出五条被 `webRequest.onBeforeRequest` 取消的请求:

```
chrome://resources/css/text_defaults_md.css                (stylesheet)
chrome://resources/lit/v3_0/lit.rollup.js                  (script)
chrome://resources/js/load_time_data.js                    (script)
chrome://resources/mojo/mojo/public/js/bindings.js         (script)
chrome://resources/cr_elements/cr_a11y_announcer/cr_a11y_announcer.css  (stylesheet)
```

PDF viewer 的 UI 是 Lit 组件 + mojo 绑定拼出来的,这些资源编译在 Chromium 二进制里。
`safeOrigin()` 对它们返回 `"null"`(opaque origin),所以 `blockedPaths` 里看到的是五条
`"null"` —— **日志里没有名字**,这也是它难被认出的一部分。原白名单只放行了
`chrome-extension://`,把 viewer 的躯壳放进来了,却把它的血肉挡在外面。

放行范围只到 `chrome://resources/`,不是整个 `chrome://`:它们是编译进二进制的静态资源,
不带用户数据,也不是文档能借以出网的面;导航面(`will-navigate` / `will-redirect` /
`setWindowOpenHandler`)一条都没放宽。

## 落盘的代价怎么还

`persist:` 意味着 `<userData>/Partitions/alpha-rail-preview-<previewId>/` 真的会被建出来。
分区名仍是一次性的(每个 preview 独一份,互不寻址),隔离面一条不改;新增的只有清理:

- `closeRecord` 里 `clearStorageData()` 之后删掉该分区目录;
- 启动时 `purgeRailPreviewPartitions()` 扫一遍前缀残留(上一次运行被强杀时 close 跑不到)。

判据里包含这一条:`partitionsAfterClose` 必须为空。

## 复跑

```bash
bash docs/verification/2026-09-03-1227-rail-pdf-session/run.sh          # 判当前工作树
bash docs/verification/2026-09-03-1227-rail-pdf-session/run.sh HEAD~1   # 取红对照
```

被测对象是**生产模块本身**(`rail-preview-host.ts` 经 `bun build` 打成 CJS、electron 外置,
harness 直接 `require` 并调 `openRailPreview`),不是一份手抄的替身。
证据见 `docs/verification/2026-09-03-1227-rail-pdf-session/results/`。
