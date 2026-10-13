import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { build, preview, type PreviewServer } from "vite"
import solid from "vite-plugin-solid"

const directory = await realpath(await mkdtemp(join(tmpdir(), "alpha-timeline-selection-")))
const packageRoot = resolve(import.meta.dir, "../../../..")
let server: PreviewServer
let browser: Browser
let baseURL: string

beforeAll(async () => {
  await Bun.write(
    join(directory, "index.html"),
    `<!doctype html><html><head><style>
      body { margin: 0; font: 14px sans-serif; }
      .select-none { -webkit-user-select: none; user-select: none; }
      #root { height: 360px; }
    </style></head><body class="select-none"><div id="root"></div>
    <output id="actions"></output><textarea id="paste" aria-label="Pasted text"></textarea>
    <script type="module" src="${join(packageRoot, "test-component/session-timeline-selection.browser.tsx")}"></script>
    </body></html>`,
  )
  const config = {
    configFile: false as const,
    root: directory,
    envDir: directory,
    logLevel: "warn" as const,
    plugins: [solid({ dev: false })],
    resolve: { alias: { "solid-js": join(packageRoot, "node_modules/solid-js") } },
    build: { outDir: join(directory, "dist") },
    preview: { host: "127.0.0.1", port: 0 },
    worker: { format: "es" as const },
  }
  await build(config)
  server = await preview(config)
  const address = server.httpServer.address()
  if (!address || typeof address === "string") throw new Error("Preview did not bind a TCP port")
  baseURL = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
  })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  await rm(directory, { recursive: true, force: true })
})

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
  page.setDefaultTimeout(10_000)
  page.on("pageerror", (error) => console.error(error.message))
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  )
  await page.goto(baseURL)
  await page.locator(".a-tl-ai").last().scrollIntoViewIfNeeded()
  await page.locator(".a-tl-ai pre code").waitFor()
  await page.evaluate(() => document.fonts.ready)
  return page
}

async function expandProcess(page: Page) {
  await page.locator(".a-tl-pf-sum").click()
  await page.locator('[data-alpha-process-step="reasoning"]').click()
  await page.locator("[data-alpha-tool-card] > .a-tl-pf-step").first().click()
}

// Ranges locate characters only; actual selection is made by mouse down/move/up.
// Walking every text node also covers Shiki code split across several token spans.
async function dragText(page: Page, selector: string, text: string) {
  const element = page.locator(selector).first()
  await element.scrollIntoViewIfNeeded()
  const points = await element.evaluate((element, text) => {
    window.getSelection()?.removeAllRanges()
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    const start = nodes
      .map((node) => node.data)
      .join("")
      .indexOf(text)
    if (start < 0) throw new Error(`Sample text missing: ${text}`)
    const character = (offset: number) => {
      const index = nodes.findIndex(
        (_, index) => offset < nodes.slice(0, index + 1).reduce((sum, node) => sum + node.length, 0),
      )
      const local = offset - nodes.slice(0, index).reduce((sum, node) => sum + node.length, 0)
      const range = document.createRange()
      range.setStart(nodes[index]!, local)
      range.setEnd(nodes[index]!, local + 1)
      return range.getBoundingClientRect()
    }
    const first = character(start)
    const last = character(start + text.length - 1)
    return {
      start: { x: first.left + 0.1, y: first.top + first.height / 2 },
      end: { x: last.right - 0.1, y: last.top + last.height / 2 },
    }
  }, text)
  await page.mouse.move(points.start.x, points.start.y)
  await page.mouse.down()
  await page.mouse.move(points.end.x, points.end.y, { steps: 20 })
  await page.mouse.up()
  return page.evaluate(() => window.getSelection()?.toString() ?? "")
}

const shortcut = process.platform === "darwin" ? "Meta" : "Control"
const samples = [
  ["用户正文", ".a-tl-bubble", "复制这一小段文字"],
  ["助手正文", ".a-tl-ai p", "保留标点、空格"],
  ["代码", ".a-tl-ai pre code", 'copied = "alpha β"'],
  ["展开的思考", ".a-tl-pf-think", "核对生成样本的字段"],
  ["展开的工具输出", ".a-tc-term", "工具输出：alpha β"],
] as const

test.each(samples)(
  "AC1 鼠标局部选中并复制%s，逐字等于原文",
  async (label, selector, text) => {
    const page = await openPage()
    try {
      if (label === "展开的思考" || label === "展开的工具输出") await expandProcess(page)
      expect(await dragText(page, selector, text)).toBe(text)
      await page.keyboard.press(`${shortcut}+c`)
      await page.locator("#paste").focus()
      await page.keyboard.press(`${shortcut}+v`)
      expect(await page.locator("#paste").inputValue()).toBe(text)
      console.log(`AC1 ${label}: selection = copied = ${JSON.stringify(text)}`)
    } finally {
      await page.context().close()
    }
  },
  30_000,
)

test("AC2 选中文字后，折叠展开、文件/产物、复制/编辑及滚动仍可用，控制节点不被选中", async () => {
  const page = await openPage()
  try {
    expect(await dragText(page, ".a-tl-bubble", "复制这一小段文字")).toBe("复制这一小段文字")
    const process = page.locator(".a-tl-pf-sum")
    await process.click()
    expect(await process.getAttribute("aria-expanded")).toBe("true")
    const reasoning = page.locator('[data-alpha-process-step="reasoning"]')
    await reasoning.click()
    expect(await reasoning.getAttribute("aria-expanded")).toBe("true")
    await reasoning.click()
    expect(await reasoning.getAttribute("aria-expanded")).toBe("false")
    const tool = page.locator("[data-alpha-tool-card] > .a-tl-pf-step").first()
    await tool.click()
    expect(await tool.getAttribute("aria-expanded")).toBe("true")
    await tool.click()
    expect(await tool.getAttribute("aria-expanded")).toBe("false")
    await tool.click()
    const summary = page.locator(".a-tc-dev summary").first()
    const text = await summary.textContent()
    expect(await dragText(page, ".a-tc-dev summary", text!)).toBe("")
    const initiallyOpen = await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)
    await summary.click()
    expect(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)).toBe(!initiallyOpen)
    await summary.click()
    expect(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)).toBe(initiallyOpen)
    await page.locator("[data-alpha-tool-card] > .a-tl-pf-step").nth(1).click()
    await page.locator("[data-alpha-open-in-panel]").click()
    expect(await page.locator("#actions").textContent()).toBe("file:selection-sample.txt")
    await page.locator("button.a-media-row").click()
    expect(await page.locator("#actions").textContent()).toBe("artifact:image/png")
    await page.getByRole("button", { name: "复制消息", exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "用户正文：复制这一小段文字，不包括后面的内容。",
    )
    await page.getByRole("button", { name: "编辑重发", exact: true }).click()
    expect(await page.locator("#actions").textContent()).toBe("edit:用户正文：复制这一小段文字，不包括后面的内容。")
    expect(
      await page
        .locator(".a-tl-root button, .a-tl-root summary")
        .evaluateAll((elements) => elements.every((element) => getComputedStyle(element).userSelect === "none")),
    ).toBe(true)
    expect(await page.locator("body").evaluate((element) => getComputedStyle(element).userSelect)).toBe("none")
    const scroller = page.locator(".a-tl-scroll")
    await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight))
    const before = await scroller.evaluate((element) => element.scrollTop)
    expect(before).toBeGreaterThan(0)
    await scroller.hover()
    await page.mouse.wheel(0, -200)
    await page.waitForFunction((before) => document.querySelector(".a-tl-scroll")!.scrollTop < before, before)
    await process.click()
    expect(await process.getAttribute("aria-expanded")).toBe("false")
    console.log("AC2: process/reasoning/tool/summary, file/artifact, copy/edit, wheel scroll PASS")
  } finally {
    await page.context().close()
  }
}, 30_000)
