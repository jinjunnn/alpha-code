// #1229 —— 真 Chromium 下判「右栏的 Office 版式载体到底画出了什么」。
//
// 被测对象是**生产模块本身**(src/main/rail-preview-host.ts 经 bun build 打成
// probe-bundle.cjs,electron 外置)+ **生产的宿主页产物**(out/office-preview/,由
// scripts/build-office-preview.ts 打出来的那一份)。不是替身,不是简化复刻。
//
// 三个判据缺一不可:
//   ① 宿主页自己报 rendered(它在另一个进程里,结论只能经 main 的 status 通道回来);
//   ② 位图上真的有墨(ink% —— 报了 rendered 但画布是空的,①会骗人);
//   ③ blockedPaths 为空 = 全程零对外请求(渲染库不出网,这是本次放宽 CSP 的前提)。
const { app, protocol, BrowserWindow } = require("electron")
const fs = require("node:fs")
const path = require("node:path")

const HTML_PREVIEW_SCHEME = "alpha-artifact-preview"
const WS = process.argv.find((a) => a.startsWith("--ws="))?.split("=")[1]
const REL = process.argv.find((a) => a.startsWith("--rel="))?.split("=")[1]
const KIND = process.argv.find((a) => a.startsWith("--kind="))?.split("=")[1]
const OUT = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1]
if (!WS || !REL || !KIND || !OUT) {
  console.error("usage: electron . --ws=<dir> --rel=<file> --kind=office-docx|office-pptx|office-xlsx --out=<png>")
  process.exit(2)
}

// 与生产 windows.ts 同一句(supportFetchAPI 是 #1229 加的;全应用只允许注册一次)。
protocol.registerSchemesAsPrivileged([
  { scheme: HTML_PREVIEW_SCHEME, privileges: { standard: true, supportFetchAPI: true } },
])

const host = require("./probe-bundle.cjs")
const result = { rel: REL, kind: KIND }
const hostLog = []
host.__setRailPreviewLogSink((name, message, extra) => hostLog.push(`${name}: ${message} ${JSON.stringify(extra ?? {})}`))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 1500, show: true, backgroundColor: "#ffffff" })
  await win.loadURL("data:text/html,<body style='background:%23ffffff'></body>")

  const opened = host.openRailPreview(win.webContents, WS, REL, KIND, { x: 0, y: 0, width: 1200, height: 1460 })
  result.open = opened
  const finish = (code) => {
    fs.writeFileSync(OUT.replace(/\.png$/, ".json"), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    app.exit(code)
  }
  if (!opened.ok) return finish(1)

  // 轮询 status —— 与右栏生产代码同一条通道(它每 1.5s 问一次)。
  // railPreviewStatusRefreshed 就是 IPC handler 调的那一个 —— 取证与用户走同一条路。
  let status = null
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    status = await host.railPreviewStatusRefreshed(opened.previewId)
    if (status.ok && status.office && status.office.status !== "pending") break
  }
  result.status = status

  const view = win.contentView.children.find((c) => c.webContents)
  const image = await Promise.race([
    view.webContents.capturePage(),
    new Promise((r) => setTimeout(() => r(null), 15000)),
  ])
  if (image) {
    fs.writeFileSync(OUT, image.toPNG())
    const bmp = image.getBitmap()
    let ink = 0
    let sampled = 0
    for (let i = 0; i < bmp.length; i += 4 * 31) {
      sampled++
      // 「有墨」= 明显偏离纯白/纯黑底的像素。空白画布恒 0。
      const sum = bmp[i] + bmp[i + 1] + bmp[i + 2]
      if (sum > 60 && sum < 700) ink++
    }
    result.sampledPixels = sampled
    result.inkPercent = Number(((100 * ink) / sampled).toFixed(2))
  } else {
    result.inkPercent = null
    result.captureNote = "capturePage timed out"
  }
  result.hostLog = hostLog

  host.closeRailPreview(opened.previewId)
  await new Promise((r) => setTimeout(r, 800))

  const rendered = status && status.ok && status.office && status.office.status === "rendered"
  const noNetwork = status && status.ok && status.blockedPaths.length === 0
  const hasInk = result.inkPercent !== null && result.inkPercent > 0.5
  result.verdict = rendered && noNetwork && hasInk ? "PASS" : "FAIL"
  result.checks = { rendered: !!rendered, noNetwork: !!noNetwork, hasInk }
  finish(result.verdict === "PASS" ? 0 : 1)
})
