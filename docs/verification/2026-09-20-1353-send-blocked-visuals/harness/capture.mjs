// `#1353` deterministic capture driver — installed Chrome in true headless mode;
// never starts Electron or the Alpha Code application. Same pattern as the accepted
// 2026-09-17-1130-settings-tools-visuals driver.
//
// 每一帧都要求页面先自证它处在它自称的状态(`data-blocked-present` 与该状态的期望相等 ⇒
// `data-visual-ready=true`)。少了这一条,反向格(`session-clean`)会退化成「什么都没渲染出来」
// 也照样过 —— 那正是本仓《断言的粒度不能比缺陷粗一格》点名的形态。
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath, URL } from "node:url"
import playwright from "../../../../packages/ui-mac/node_modules/playwright-core/index.js"

const { chromium } = playwright

const here = fileURLToPath(new URL(".", import.meta.url))
const repo = fileURLToPath(new URL("../../../..", import.meta.url))
const shots = fileURLToPath(new URL("../shots", import.meta.url))
const baseURL = process.env.HARNESS_1353_URL ?? "http://127.0.0.1:4193/"
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

/** `session-clean` 是反向格:同一段文字、同一次发送,只是词表没命中 ⇒ 槽里什么都不该有。
 *  `session-typed` 是版式对照组:同一段文字留在输入框里、没按发送 —— 窄宽下第二行照样被输入框
 *  自己截掉,证明那不是本增量引入的。 */
const states = ["session-blocked", "session-clean", "session-typed", "home-blocked"]
const expectBlocked = {
  "session-blocked": true,
  "session-clean": false,
  // 版式对照组:同一段文字,只打字不发送 ⇒ 不该有这个元素。
  "session-typed": false,
  "home-blocked": true,
}
// narrow = 会话页 + 右栏时的窄容器(次句换行到第二行);wide = 桌面常态。
const widths = { narrow: 420, wide: 760 }

await mkdir(shots, { recursive: true })
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run"],
})

const records = []
try {
  for (const [widthName, viewportWidth] of Object.entries(widths)) {
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: 520 }, deviceScaleFactor: 2 })
    for (const state of states) {
      for (const theme of ["light", "dark"]) {
        const url = `${baseURL}?state=${state}&theme=${theme}&width=${widthName}`
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.goto(url, { waitUntil: "networkidle" })
        await page.waitForFunction(() => document.documentElement.dataset.visualReady === "true", { timeout: 20_000 })
        const present = await page.evaluate(() => document.documentElement.dataset.blockedPresent)
        if (present !== String(expectBlocked[state])) {
          throw new Error(`${state}/${theme}/${widthName}: blockedPresent=${present}, expected ${expectBlocked[state]}`)
        }
        await page.waitForTimeout(120)
        const name = `${state}-${theme}-${widthName}.png`
        const path = `${shots}/${name}`
        await page.screenshot({ path, animations: "disabled", caret: "hide", fullPage: true })
        const bytes = await readFile(path)
        records.push({
          state,
          theme,
          width: widthName,
          blockedPresent: present === "true",
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
  harness: "production AlphaComposerRuntime via loopback Vite build + Chrome --headless=new",
  harnessSha256: createHash("sha256")
    .update(await readFile(`${here}/send-blocked-harness.tsx`))
    .digest("hex"),
  captureDriverSha256: createHash("sha256")
    .update(await readFile(`${here}/capture.mjs`))
    .digest("hex"),
  chrome: execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim(),
  viewports: widths,
  deviceScaleFactor: 2,
  foregroundApplicationLaunches: 0,
  credentialsUsed: false,
  electronStarted: false,
  records,
}
await writeFile(`${here}/capture-metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`)
process.stdout.write(`captured ${records.length} frames from ${states.length} states\n`)
