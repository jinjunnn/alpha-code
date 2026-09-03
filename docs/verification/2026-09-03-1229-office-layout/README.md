# `#1229` 右栏 Office 版式载体 —— 真 Chromium 证据

*2026-09-03 · Electron 42.3.3(Chromium 142)· macOS 15*

判的是一件事:**右栏点开一个 docx / pptx / xlsx,原来的版式到底画出来了没有。**
成因与设计取舍在 [`docs/architecture/2026-09-03-office-layout-isolation.md`](../../architecture/2026-09-03-office-layout-isolation.md)。

## 为什么必须是 Electron 判据

版式画在 main 持有的 `WebContentsView` 上,内容在**另一个进程**,发起它的 renderer 的 DOM 里
没有它的任何节点。单元/组件测试能判的只有「载体按对的子类型开了没有」;判不了「画出来没有」。

而这个缺陷类恰恰会在那一层全绿:见下面第二条发现。

## 判据(三条,缺一不可)

| 量 | PASS | 说明 |
| --- | --- | --- |
| `status.office.status` | `rendered` | 宿主页自己的结论,经 `railPreviewStatusRefreshed`(IPC handler 调的同一个函数)回来 |
| `inkPercent` | > 0.5 | 位图上真的有墨。宿主页报了 rendered 而画布是空的 —— 这不是假设,是本次实际发生过 |
| `status.blockedPaths` | 空 | 全程零对外请求。这是把 CSP 从 `script-src 'none'` 放宽到 `'self'` 的前提 |

## 结果(owner 的三个真实文件)

| 载体 | 宿主页结论 | inkPercent | blockedPaths | 结论 |
| --- | --- | --- | --- | --- |
| `office-docx`(`resume.docx`) | `rendered` · 1 page(s) | `2.84` | 空 | **PASS** |
| `office-pptx`(`test.pptx`) | `rendered` · 5 slide(s) | `57.92` | 空 | **PASS** |
| `office-xlsx`(`test.xlsx`) | `rendered` · workbook | `6.37` | 空 | **PASS** |

## 这次取证抓到的两件事(都只有真跑才看得见)

**一、宿主页报「渲染成功」而画布上只有外壳。** 第一版取证:xlsx 的 `status.office` 是
`rendered`、`blockedPaths` 为空、组件测试全绿 —— 而位图上只有底部的工作表标签条和状态栏,
**中间的网格一个像素都没画**(`inkPercent` 0.28)。根因是宿主页的 CSS:表格载体是 canvas
虚拟滚动,按**容器的确定高度**算画布尺寸,父链上只要有一处 `auto` / `min-height`,它算出来
就是 0;而 flex 外壳照常布局,所以「看起来渲染了」。修法是按 `?kind=` 给一条确定高度的链
(`host.html` 里的 `html[data-alpha-office-kind="xlsx"]`)。修完 `inkPercent` 0.28 → **6.37**。

> 这就是判据里为什么必须有 `inkPercent` 这一条:只信「渲染库说它成功了」会一路绿到用户面前。

**二、仓内 OOXML 夹具不能用来判版式。** `fixtures/office-containers/` 那三个容器是为**提取路**
造的最小 OPC 包(只有 `document.xml` / `slides` / `worksheets`),没有 `slideLayouts` /
`slideMasters` / `theme`。版式渲染库据此判定「这不是一份可渲染的演示文稿」,pptx 直接
`no slides rendered` —— 一个**与被测代码无关的红**。所以 `run.sh` 把三个真实文件设成必填,
不给默认值:宁可跑不了,也不给一个会被误读的结论。

## 为什么 results/ 里只有数字,没有截图

判据用的是 owner 工作区里的三个真实文件,截图上就是那些文件的内容。取证记录进仓 = 把这些
内容发出去,所以这里**只留 `*.json`(数值与结论),不留 `*.png`**。截图在本机跑一次 `run.sh`
就会重新生成在同一个目录下,判据一点没弱:`inkPercent` / `blockedPaths` / 宿主页结论三条
都在 json 里,而且都能复跑对照。

## 复跑

```bash
bash docs/verification/2026-09-03-1229-office-layout/run.sh <真实.docx> <真实.pptx> <真实.xlsx>
```

脚本会先跑生产那条打包步骤(`scripts/build-office-preview.ts`)产出宿主页,再把生产模块
`rail-preview-host.ts` 打成 CJS 交给 harness —— 被测的是生产件,不是替身。
