// #1130 deterministic capture driver — installed Chrome in true headless mode;
// never starts Electron or the Alpha Code application. Same pattern as the accepted
// 2026-08-12-583-584-586 driver.
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath, URL } from "node:url"
import playwright from "../../../../packages/ui-mac/node_modules/playwright-core/index.js"

const { chromium } = playwright

const here = fileURLToPath(new URL(".", import.meta.url))
const repo = fileURLToPath(new URL("../../../..", import.meta.url))
const shots = fileURLToPath(new URL("../shots", import.meta.url))
const baseURL = process.env.HARNESS_1130_URL ?? "http://127.0.0.1:4191/"
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

const states = ["default", "rebind", "quarantine", "savefail", "loading", "loadfail"]
// Settings 是全屏 overlay(position:fixed; inset:0),视口宽度决定布局:wide = 桌面常态,
// narrow = 触发 settings.css 的 840px 断点(导航折成横排)。
const widths = { narrow: 760, wide: 1280 }

await mkdir(shots, { recursive: true })
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run"],
})

const records = []
try {
  for (const [widthName, viewportWidth] of Object.entries(widths)) {
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: 900 }, deviceScaleFactor: 1 })
    for (const state of states) {
      for (const theme of ["light", "dark"]) {
        const url = `${baseURL}?state=${state}&theme=${theme}&width=${widthName}`
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.goto(url, { waitUntil: "networkidle" })
        await page.waitForFunction(() => document.documentElement.dataset.visualReady === "true")
        await page.waitForTimeout(120)
        const name = `${state}-${theme}-${widthName}.png`
        const path = `${shots}/${name}`
        // overlay 是 fixed 全屏,fullPage 抓不到滚动区;把 main 撑开成内容高度再整页抓。
        await page.evaluate(() => {
          const page = document.querySelector(".alpha-settings-page")
          const main = document.querySelector(".alpha-settings-main")
          if (!(page instanceof HTMLElement) || !(main instanceof HTMLElement)) return
          page.style.position = "static"
          page.style.height = "auto"
          page.style.minHeight = "900px"
          main.style.overflow = "visible"
        })
        await page.screenshot({ path, animations: "disabled", caret: "hide", fullPage: true })
        const bytes = await readFile(path)
        records.push({
          state,
          theme,
          width: widthName,
          file: `shots/${name}`,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })
      }
    }
    await page.close()
  }
} finally {
  await browser.close()
}

const metadata = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  productionBaselineCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  harness: "production AlphaSettings (tools section) via loopback Vite build + Chrome --headless=new",
  harnessSha256: createHash("sha256")
    .update(await readFile(`${here}/settings-tools-harness.tsx`))
    .digest("hex"),
  captureDriverSha256: createHash("sha256")
    .update(await readFile(`${here}/capture.mjs`))
    .digest("hex"),
  chrome: execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim(),
  viewports: widths,
  foregroundApplicationLaunches: 0,
  credentialsUsed: false,
  electronStarted: false,
  records,
}
await writeFile(`${here}/capture-metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`)
process.stdout.write(`captured ${records.length} frames from ${states.length} states\n`)
