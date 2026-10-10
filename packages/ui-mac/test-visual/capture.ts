// 起 Vite(本目录 config)→ headless Chromium 逐场景截图 → 同时截已批帧 frame.html 各节。
// 运行:`bun test-visual/capture.ts [outDir]`(在 packages/ui-mac 下)。
import { createServer } from "vite"
import { chromium, type Page } from "playwright-core"
import { mkdirSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolve } from "node:path"

const here = fileURLToPath(new URL(".", import.meta.url))
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/evidence/2026-10-10-req229-230-visual/shots"))
const frameFile = resolve(here, "../../../docs/design/2026-10-10-timeline-process-fold/frame.html")
mkdirSync(out, { recursive: true })

const WIDTH = 1280
const HEIGHT = 860

type Scene = { name: string; height?: number; act?: (page: Page) => Promise<void>; dark?: boolean }

const openFold = async (page: Page) => {
  await page.click("[data-alpha-timeline-row='process'] .a-tl-pf-sum")
  await page.waitForTimeout(250)
}
const scenes: Scene[] = [
  { name: "fold-collapsed", dark: true },
  { name: "fold-expanded", height: 1100, act: openFold, dark: true },
  {
    name: "fold-step-detail",
    height: 1300,
    dark: true,
    act: async (page) => {
      await openFold(page)
      // 打开网页 2 次(失败)合并行 → 展开成每项一行 → 再点一项看详情(失败详情:人话在上、原文在下)。
      await page.locator(".a-tl-pf-step").filter({ hasText: "打开网页" }).first().click()
      await page.waitForTimeout(200)
      await page.locator("[data-alpha-process-step='tool-item']").first().click()
      await page.waitForTimeout(250)
    },
  },
  {
    name: "fold-search-detail",
    height: 1300,
    act: async (page) => {
      await openFold(page)
      // 搜索 4 次 合并行 → 每项一行 → 第一项的搜索结果详情。
      await page.locator(".a-tl-pf-step").filter({ hasText: "搜索 4 次" }).first().click()
      await page.waitForTimeout(200)
      await page.locator("[data-alpha-process-step='tool-item']").first().click()
      await page.waitForTimeout(250)
    },
  },
  { name: "provenance", height: 900, act: openFold },
  { name: "live-running", dark: true },
  { name: "live-waiting", dark: true },
  { name: "approval", dark: true },
  {
    name: "menu-perm",
    dark: true,
    act: async (page) => {
      await page.click(".a-chip-perm")
      await page.waitForTimeout(250)
    },
  },
  {
    name: "menu-model",
    dark: true,
    act: async (page) => {
      await page.waitForTimeout(600)
      await page.click(".a-pop-wrap[data-kind='model'] > button, [data-kind='model'] button.a-chip")
      await page.waitForTimeout(600)
    },
  },
  {
    name: "toast-tooltip",
    act: async (page) => {
      await page.waitForTimeout(400)
      // 悬停「+」按钮,等 Tooltip 的延迟后出现(右下角被通知压住,避开)。
      await page.hover(".a-chip-icon")
      await page.waitForTimeout(900)
    },
  },
]

const sections = ["compare", "expand", "live", "end", "steps", "overlays", "rules"]

const server = await createServer({ configFile: resolve(here, "vite.config.ts"), logLevel: "warn" })
await server.listen()
const base = `http://localhost:${server.config.server.port}/`
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" })
const report: string[] = []
try {
  for (const scene of scenes) {
    for (const theme of scene.dark ? ["light", "dark"] : ["light"]) {
      const page = await browser.newPage({ viewport: { width: WIDTH, height: scene.height ?? HEIGHT }, locale: "zh-CN" })
      const errors: string[] = []
      page.on("pageerror", (e) => errors.push(String(e)))
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
      await page.goto(`${base}?scene=${scene.name}&theme=${theme}`, { waitUntil: "networkidle" })
      await page.waitForFunction(() => (window as unknown as { __harnessReady?: boolean }).__harnessReady === true)
      await page.waitForTimeout(500)
      if (scene.act) await scene.act(page)
      if (scene.name === "approval" && theme === "light") {
        const facts = await page.evaluate(() => {
          const panel = document.querySelector(".a-permission-panel-root") as HTMLElement | null
          const tl = document.querySelector(".vh-timeline") as HTMLElement
          const scroller = [...tl.querySelectorAll<HTMLElement>("*")].find((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== "visible")
          const rect = panel?.firstElementChild?.getBoundingClientRect()
          const hit = document.elementFromPoint(640, 60)
          return {
            anchored: panel?.dataset.anchored,
            activeElement: (document.activeElement as HTMLElement | null)?.textContent?.trim(),
            inertAnywhere: document.querySelectorAll("[inert]").length,
            ariaModal: document.querySelectorAll("[aria-modal='true']").length,
            timelineTopHitIsTimeline: !!hit && tl.contains(hit),
            panelRect: rect && { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), width: Math.round(rect.width) },
            composerTop: Math.round(document.querySelector("[data-alpha-composer='session']")?.getBoundingClientRect().top ?? -1),
            timelineScrollable: !!scroller,
          }
        })
        report.push(`approval DOM facts: ${JSON.stringify(facts)}`)
      }
      const file = resolve(out, `app-${scene.name}-${theme}.png`)
      await page.screenshot({ path: file })
      report.push(`${scene.name} ${theme}: ${errors.length ? "ERRORS " + errors.slice(0, 3).join(" | ") : "ok"}`)
      await page.close()
    }
  }
  // 已批帧:frame.html 各节(浅色 + 深色)。
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, locale: "zh-CN" })
    await page.goto(pathToFileURL(frameFile).href, { waitUntil: "load" })
    if (theme === "dark") await page.click("#themeSeg button[data-theme='dark']")
    await page.waitForTimeout(300)
    for (const id of sections) {
      const box = await page.evaluate((sid) => {
        const h = document.getElementById(sid)!
        const all = [...document.querySelectorAll("h2.pf-h")]
        const next = all[all.indexOf(h) + 1] as HTMLElement | undefined
        const top = h.getBoundingClientRect().top + window.scrollY
        const bottom = next ? next.getBoundingClientRect().top + window.scrollY : document.documentElement.scrollHeight
        return { top, height: bottom - top }
      }, id)
      await page.screenshot({
        path: resolve(out, `frame-${id}-${theme}.png`),
        fullPage: true,
        clip: { x: 0, y: box.top, width: WIDTH, height: box.height },
      })
    }
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log(report.join("\n"))
