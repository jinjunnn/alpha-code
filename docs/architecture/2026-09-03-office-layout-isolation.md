# Office 版式渲染:在既有隔离载体里跑第三方渲染库

*2026-09-03 · Electron 42.3.3(Chromium 142)· 票 `#1229`*

owner 2026-09-03 裁决:Office 三件套改用现成渲染库出真版式(Word 用 `docx-preview`,
Excel / PPT 用 `@file-viewer`),不走「把 LibreOffice 装进安装包」那条路。本文记录**这三个库
被放在哪里跑、为什么是那里、以及为此放宽了什么**——全部数值都是跑出来的,复跑脚本在
[`docs/verification/2026-09-03-1229-office-layout/`](../verification/2026-09-03-1229-office-layout/README.md)。

## 先说结论

第三方渲染库要吃**用户给的、可能是恶意的文档字节**。它跑在哪里,决定了它被带偏时能碰到什么。

| 候选位置 | 它能碰到什么 | 结论 |
| --- | --- | --- |
| 主 renderer(应用自己的窗口) | `window.api` 全桥、会话、工作区、所有面板 | **不可接受** |
| 一个新造的隔离窗口 | 需要重新造一遍权限/网络/导航/下载全拒组 | 重复,且新的一份迟早与旧的漂移 |
| **既有右栏叠放载体**(`rail-preview-host`) | 零 preload、persist 分区、权限三面全拒、`will-download` 拦、webRequest 只放行本协议、导航面全拒 | **选它** |

所以是「**同一套隔离,第三块画布**」——与 html / pdf 载体逐条共用同一组 deny,只有画什么不同。

## 为此放宽了两处,都实测过最小化

### 一、协议要加 `supportFetchAPI`

宿主页要把文档字节当**数据**取回来。不加这一条,同源 `fetch` 被拒:

```
Fetch API cannot load alpha-artifact-preview://<token>/__alpha_office__/document.
URL scheme "alpha-artifact-preview" is not supported.
```

这是**全应用一次性**的注册,与 HTML 产物预览共用同一个协议名。所以必须回答:加了之后,
恶意 HTML 产物是不是就能 fetch 同伴文件了?

**跑了负向控制,答案是不能。** 造一份内联脚本 + 双重 fetch(同伴文件 / 外网)的恶意 HTML,
按生产的 `HTML_PREVIEW_CSP` 供给,实测控制台只有:

```
Blocked script execution in 'alpha-artifact-preview://<token>/evil.html'
because the document's frame is sandboxed
```

——那份 CSP 的裸 `sandbox` 指令在 fetch 之前就把脚本整个禁掉了,恶意 HTML **连发起 fetch 的
机会都没有**。`script-src 'none'` 是第二道。故这次放宽不削弱 HTML 那条路。仍然不给 `secure`。

### 二、Office 宿主页用**另一份** CSP

`HTML_PREVIEW_CSP` 的守卫核心是「文档一行脚本都不许跑」。Office 这条路恰恰要跑**我们自己
打包进去的那段渲染代码**,裸 `sandbox` 会连它一起禁掉。所以换一种守法:

```
script-src 'self'    ← 允许的脚本只有这一个来源
connect-src 'self'   ← 只够取文档字节,出网面为空(webRequest 另有一道)
worker-src 'self' blob:
default-src 'none'   ← 其余一律 none
```

关键在于 **`'self'` 下我们只服务一张固定文件表**(`OFFICE_PREVIEW_ASSETS`:`host.html` /
`app.js` / 两个 worker)。文档字节走 `application/octet-stream`、只在一个定长地址上供给,
**永远不会成为可执行来源**。并且 Office 载体**不服务工作区里的任何同伴文件**(与 html 载体的
关键差别 —— 版式所需的图片/字体都在容器内部,渲染库自己解)。

## 顺带收紧的两处

**工作区路径不进 URL。** html / pdf 载体直接装载那份文档本身,URL 里带着文件名;Office 载体
装的是宿主页,文档在 `__alpha_office__/document` 这个定长地址上供给,由 main 按记录解析回
工作区文件(身份 + 尺寸复核照旧,盘上被换即 409)。叠放层的地址因此不泄露工作区内容。

**结构闸仍在渲染库之前。** `detectOoxmlContainer`(#1174)照旧先跑:畸形容器、加密包、
zip 炸弹、路径不安全的条目一律在**进第三方解析器之前**被拒。只有过闸的容器才拿得到版式画布;
没过的直接落诚实卡,连载体都不开。

**渲染失败有兜底。** 宿主页在另一个进程,画没画出来只能经 `railPreviewStatusRefreshed`
(IPC handler 调的同一个函数)回报。报 failed ⇒ 右栏换回 `#1227` 那条文字提取,并说明原因 ——
用户看到降级的内容,而不是对着一块空白等。

## 打包产物的位置为什么不用 `__dirname` 推

宿主页产物在 `out/office-preview/`。解析它的锚点是 `app.getAppPath()`,**不是** `__dirname`:
main 是 rollup 打包产物,本模块可能落在 `out/main/index.js`,也可能被拆进 `out/main/chunks/*.js`
——两者的 `__dirname` 差一层,而差错的表现是**运行时静默 404**(宿主页白屏),构建期一点声音
都没有。`getAppPath()` 在开发与打包(app.asar 根)两种形态下指向同一个锚点。

打包脚本产完会拿产物**逐条比对** `OFFICE_PREVIEW_ASSETS`:少了 = 装载 404;多了 = 有个文件
永远不会被服务,那是「打了但没接上」,同样判红。

## 押注记在案

`docx-preview` 每周约 147 万次下载;`@file-viewer/*` 约 3.1–3.4 万次,是前者的 1/45。
三者都是 Apache-2.0、都不出网(实测 `blockedPaths` 全程为空)。哪天 `@file-viewer` 不再维护,
要接手的是 pptx / xlsx 这两条;docx 那条风险低得多。这不是马上会发生的事,但选型时知道押了谁。

已知保真缺口:docx 里用 Wingdings 一类符号字体的项目符号,在本机缺该字体时显示成空框。
