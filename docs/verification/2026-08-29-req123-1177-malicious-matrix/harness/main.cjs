// REQ-123 / alpha-code#1177 — Electron main for the real-Chromium zero-egress probe.
//
// Owns TWO independent network observers so "zero egress" is not resting on one lens:
//   1. an HTTP sink on 127.0.0.1:38999 — records any request that actually reaches it
//      (proves reachability end to end; the probe's positive-control fetch must land here);
//   2. session.webRequest.onBeforeRequest with urls ["<all_urls>"] — Chromium's own view
//      of EVERY outbound request the renderer attempts, on any scheme/host, whether or not
//      it would succeed. A file:// XXE or an http entity fetch shows here even if the sink
//      never sees it.
// A run is only valid if the positive control appears in BOTH the sink and webRequest logs
// — that is the "prove the observer catches a known hit before trusting a zero" discipline.

const { app, BrowserWindow, session } = require("electron")
const http = require("http")
const fs = require("fs")
const path = require("path")

app.commandLine.appendSwitch("use-mock-keychain")

const BUNDLE = process.argv[2]
const OUT = process.argv[3]
const PORT = 38999

const sinkHits = []
const webRequestHits = []

const sink = http.createServer((req, res) => {
  sinkHits.push({ url: req.url, method: req.method, at: Date.now() })
  res.writeHead(200, { "content-type": "text/plain" })
  res.end("ok")
})

function pageHtml() {
  const bundle = fs.readFileSync(BUNDLE, "utf8")
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>" +
    "<script type=\"module\">" + bundle + "</script>" +
    "</body></html>"
  )
}

async function run() {
  await new Promise((r) => sink.listen(PORT, "127.0.0.1", r))

  // Observe EVERY outbound request the renderer makes, any scheme/host.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, cb) => {
    webRequestHits.push({ url: details.url, method: details.method, resourceType: details.resourceType })
    cb({ cancel: false })
  })

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false },
  })

  const consoleLines = []
  win.webContents.on("console-message", (_e, level, message) => consoleLines.push(message))

  // Load the probe page from an about:blank base via data URL is fragile for module
  // scripts; write a temp HTML next to the bundle and load it over file://.
  const htmlPath = path.join(path.dirname(BUNDLE), "probe-page.html")
  fs.writeFileSync(htmlPath, pageHtml())
  await win.loadFile(htmlPath)

  // Drive the probe and wait for completion (bounded).
  await win.webContents.executeJavaScript("window.__RUN_PROBE__ && window.__RUN_PROBE__()")
  const deadline = Date.now() + 20000
  let done = false
  while (Date.now() < deadline) {
    done = await win.webContents.executeJavaScript("window.__PROBE_DONE__ === true")
    if (done) break
    await new Promise((r) => setTimeout(r, 200))
  }

  // Give any lingering async external-entity fetch a moment to surface in the observers.
  await new Promise((r) => setTimeout(r, 1500))

  const probeResult = done
    ? await win.webContents.executeJavaScript("window.__PROBE_RESULT__")
    : { arms: [], error: "probe did not complete within 20s" }

  const result = {
    identity: {
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      pid: process.pid,
      bundlePath: BUNDLE,
      at: new Date().toISOString(),
    },
    probe: probeResult,
    observers: {
      sinkHits,
      webRequestHits,
    },
    consoleLines,
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2))
  sink.close()
  app.quit()
}

app.whenReady().then(run).catch((e) => {
  fs.writeFileSync(OUT, JSON.stringify({ fatal: String(e && e.stack || e) }, null, 2))
  app.quit()
})
