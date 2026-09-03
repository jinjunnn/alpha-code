// #1227 —— 真 Chromium 下判「右栏 PDF 叠放载体是否真的画出了页面」。
//
// 关键纪律:被测对象是 **生产模块本身**(src/main/rail-preview-host.ts 经 bun build 打成
// probe-bundle.cjs,electron 外置),不是一个手抄的替身 —— 本仓为「照着不是生产用的那个包
// 跑」付过学费,这里不再犯。
//
// 判据不走 DOM 探针(叠放层的内容在另一个进程的 WebContentsView 上,主文档 DOM 里没有它的
// 节点):抓 `webContents.capturePage()` 的位图,统计非暗像素占比,并列出 frame 树 ——
// 黑屏态是「2 个 frame、非暗像素 0%」,正常态是「3 个 frame(多出渲染页面的 plugin OOPIF)、
// 非暗像素 ≫ 0」。
const { app, protocol, BrowserWindow } = require("electron")
const fs = require("node:fs")
const path = require("node:path")

const HTML_PREVIEW_SCHEME = "alpha-artifact-preview"
const WS = process.argv.find((a) => a.startsWith("--ws="))?.split("=")[1]
const OUT = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1]
const REL = process.argv.find((a) => a.startsWith("--rel="))?.split("=")[1] ?? "probe.pdf"
if (!WS || !OUT) {
  console.error("usage: electron . --ws=<workspace dir> --out=<png path> [--rel=probe.pdf]")
  process.exit(2)
}

// 与生产 windows.ts 同一句注册(全应用只允许一次)。
protocol.registerSchemesAsPrivileged([{ scheme: HTML_PREVIEW_SCHEME, privileges: { standard: true } }])

const host = require("./probe-bundle.cjs")
const result = { rel: REL }
// 生产模块自己的日志面 —— 被拦的目标只在这里说得出名字。
const hostLog = []
host.__setRailPreviewLogSink((name, message, extra) => hostLog.push(`${name}: ${message} ${JSON.stringify(extra ?? {})}`))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 800, show: true, backgroundColor: "#ffffff" })
  await win.loadURL("data:text/html,<body style='background:%23eeeeee'>host</body>")

  const opened = host.openRailPreview(win.webContents, WS, REL, "pdf", { x: 20, y: 20, width: 860, height: 700 })
  result.open = opened
  if (!opened.ok) {
    fs.writeFileSync(OUT.replace(/\.png$/, ".json"), JSON.stringify(result, null, 2))
    app.exit(1)
    return
  }

  await new Promise((r) => setTimeout(r, 5000))

  // 叠放 view 是窗口的子 view;截它自己的位图。
  const view = win.contentView.children.find((c) => c.webContents && c.webContents.getURL().includes(HTML_PREVIEW_SCHEME))
  const wc = view.webContents
  const image = await wc.capturePage()
  fs.writeFileSync(OUT, image.toPNG())
  const bitmap = image.getBitmap()
  let nonDark = 0
  let sampled = 0
  for (let i = 0; i < bitmap.length; i += 4 * 37) {
    sampled++
    if (bitmap[i] + bitmap[i + 1] + bitmap[i + 2] > 200) nonDark++
  }
  result.size = image.getSize()
  result.sampledPixels = sampled
  result.nonDarkPixels = nonDark
  result.nonDarkPercent = Number(((100 * nonDark) / sampled).toFixed(1))
  result.frames = wc.mainFrame.framesInSubtree.map((f) => {
    const url = String(f.url)
    return url.startsWith(`${HTML_PREVIEW_SCHEME}://`) ? `${HTML_PREVIEW_SCHEME}://<token>/${REL}` : url
  })
  result.frameCount = result.frames.length
  result.partitionsOnDisk = (() => {
    try {
      return fs.readdirSync(path.join(app.getPath("userData"), "Partitions"))
    } catch {
      return []
    }
  })()
  result.status = host.railPreviewStatus(opened.previewId)
  result.hostLog = hostLog

  // 关闭后:分区目录必须被收掉(落盘是 persist: 的代价,close 要还回去)。
  host.closeRailPreview(opened.previewId)
  await new Promise((r) => setTimeout(r, 1500))
  result.partitionsAfterClose = (() => {
    try {
      return fs.readdirSync(path.join(app.getPath("userData"), "Partitions"))
    } catch {
      return []
    }
  })()

  // 判据:非暗像素 > 20%(黑屏态实测恒 0)且 frame 树里出现了渲染页面的 plugin OOPIF。
  result.verdict =
    result.nonDarkPercent > 20 && result.frameCount >= 3 && result.partitionsAfterClose.length === 0
      ? "PASS"
      : "FAIL"
  fs.writeFileSync(OUT.replace(/\.png$/, ".json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  app.exit(result.verdict === "PASS" ? 0 : 1)
})
