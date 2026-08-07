// Deterministic #547 capture driver. It uses the installed Chrome binary in true headless
// mode and never starts Electron or the Alpha Code application.
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath, URL } from "node:url"
import playwright from "../../../../packages/ui-mac/node_modules/playwright-core/index.js"

const { chromium } = playwright

const here = fileURLToPath(new URL(".", import.meta.url))
const repo = fileURLToPath(new URL("../../../..", import.meta.url))
const shots = fileURLToPath(new URL("../shots", import.meta.url))
const baseURL = process.env.REQ125_HARNESS_URL ?? "http://127.0.0.1:4173/"
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

const states = [
  "A1",
  "A2",
  "A3",
  "A4",
  "B2",
  "C2",
  "C3",
  "D1",
  "D2",
  "D5",
  "D6",
  "D8",
  "D9",
  "E8",
  "I2",
  "I3",
  "J1",
  "J2",
  "J3",
  "J5",
  "J6",
]
const full = new Set(["A1", "A2", "A3", "A4", "C2", "C3", "I2", "I3", "J1"])
const selector = {
  B2: "[data-alpha-session-workspace-topbar]",
  D1: "[data-alpha-session-rail-host]",
  D2: "[data-alpha-session-rail-host]",
  D5: "[data-alpha-session-rail-host]",
  D6: "[data-alpha-session-rail-host]",
  D8: "[data-alpha-session-rail-host]",
  D9: "[data-alpha-session-rail-host]",
  E8: ".a-tl-column",
  J2: "[data-alpha-session-dock]",
  J3: "[data-alpha-session-dock]",
  J5: "[data-alpha-session-dock]",
  J6: "[data-alpha-session-dock]",
}

await mkdir(shots, { recursive: true })
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run"],
})

const records = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  for (const state of states) {
    for (const theme of ["light", "dark"]) {
      const url = `${baseURL}?state=${state}&theme=${theme}`
      await page.goto(url, { waitUntil: "networkidle" })
      await page.waitForFunction(() => document.documentElement.dataset.visualReady === "true")
      await page.waitForTimeout(150)
      if (state === "A2" || state === "D5") {
        for (const directory of await page.locator("[data-alpha-srf-dir]").all()) {
          if ((await directory.getAttribute("aria-expanded")) === "false") await directory.click()
        }
        await page.waitForTimeout(50)
      }
      if (state === "D1") await page.locator(".a-rvw-dl").first().hover()
      if (state === "D9") await page.locator(".a-swk-rail-grip").hover()
      const name = `${state}-${theme}-headless.png`
      const path = `${shots}/${name}`
      if (full.has(state)) {
        await page.screenshot({ path, animations: "disabled", caret: "hide" })
      } else {
        const target = page.locator(selector[state]).first()
        await target.waitFor({ state: "visible" })
        await target.screenshot({ path, animations: "disabled", caret: "hide" })
      }
      const bytes = await readFile(path)
      records.push({
        state,
        theme,
        file: `shots/${name}`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
    }
  }
} finally {
  await browser.close()
}

const metadata = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  productionBaselineCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  harness: "production Solid components via loopback Vite + Chrome --headless=new",
  harnessSha256: createHash("sha256")
    .update(await readFile(`${here}/visual-harness.tsx`))
    .digest("hex"),
  captureDriverSha256: createHash("sha256")
    .update(await readFile(`${here}/capture.mjs`))
    .digest("hex"),
  chrome: execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim(),
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  foregroundApplicationLaunches: 0,
  credentialsUsed: false,
  electronStarted: false,
  records,
}
await writeFile(`${here}/capture-metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`)
process.stdout.write(`captured ${records.length} frames from ${states.length} states\n`)
