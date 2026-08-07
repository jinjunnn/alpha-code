#!/usr/bin/env bun
// #857 — make the fixed Electron sidecar listener share Default's routes and memo map.
//
// HttpApiApp.Default uses one singleton routes layer and the process-wide core memo map,
// while Server.listen normally creates a fresh routes layer and a fresh memo map. That
// means an in-process location prewarm cannot warm the socket listener. ADR-005 forbids
// editing upstream source, so Alpha patches only the freshly generated, gitignored
// embedded-server bundle for the one fixed Electron CORS shape. Other callers retain
// createRoutes(opts), and any compiled-shape drift aborts the build.
import path from "node:path"

const FILE = path.resolve(import.meta.dir, "../../opencode/dist/node/node.js")
const IDENTIFIER = "[A-Za-z_$][\\w$]*"
const LISTENER = new RegExp(`^function listenerLayer\\(opts, ${IDENTIFIER}\\) \\{$`)
const START = new RegExp(`^function startListener\\(opts, ${IDENTIFIER}\\) \\{$`)
const ROUTE_BEFORE = new RegExp(
  `^(\\s*)return\\s+(${IDENTIFIER})\\.serve\\((${IDENTIFIER})\\.createRoutes\\(opts\\),\\s*\\{\\s*$`,
)
const ROUTE_AFTER = new RegExp(
  `^(\\s*)return\\s+(${IDENTIFIER})\\.serve\\(opts\\.cors\\?\\.length === 1 && opts\\.cors\\[0\\] === "oc:\\/\\/renderer" \\? (${IDENTIFIER})\\.routes : \\3\\.createRoutes\\(opts\\),\\s*\\{\\s*$`,
)
const MEMO_BEFORE = new RegExp(
  `^(\\s*)return\\s+(${IDENTIFIER})\\.buildWithMemoMap\\(listenerLayer\\(opts,\\s*(${IDENTIFIER})\\),\\s*\\2\\.makeMemoMapUnsafe\\(\\),\\s*(${IDENTIFIER})\\)\\.pipe`,
)
const MEMO_AFTER = new RegExp(
  `^(\\s*)return\\s+(${IDENTIFIER})\\.buildWithMemoMap\\(listenerLayer\\(opts,\\s*(${IDENTIFIER})\\),\\s*(${IDENTIFIER}),\\s*(${IDENTIFIER})\\)\\.pipe`,
)

function oneIndex(lines: string[], pattern: RegExp, label: string) {
  const matches = lines.flatMap((line, index) => (pattern.test(line) ? [index] : []))
  if (matches.length !== 1) throw new Error(`expected one ${label}, found ${matches.length}`)
  return matches[0]!
}

function oneNear(lines: string[], start: number, pattern: RegExp, label: string) {
  const matches = lines.slice(start, start + 8).flatMap((line, offset) => (pattern.test(line) ? [start + offset] : []))
  if (matches.length !== 1) throw new Error(`expected one ${label}, found ${matches.length}`)
  return matches[0]!
}

function defaultMemoMap(lines: string[]) {
  const matches: string[] = []
  for (let index = 0; index < lines.length - 3; index++) {
    if (!lines[index]!.includes(".toWebHandler(")) continue
    const window = lines.slice(index, index + 8)
    if (!window.some((line) => line.trim() === "disableLogger: true,")) continue
    const middleware = window.findIndex((line) => /^\s*middleware:\s*[A-Za-z_$][\w$]*\s*$/.test(line))
    if (middleware <= 0) continue
    const memo = window[middleware - 1]!.match(/^\s*([A-Za-z_$][\w$]*),\s*$/)?.[1]
    if (memo) matches.push(memo)
  }
  if (matches.length !== 1) throw new Error(`expected one Default web-handler memo map, found ${matches.length}`)
  return matches[0]!
}

export function patchSidecarSharedRoutes(text: string) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.split(/\r?\n/)
  const listener = oneIndex(lines, LISTENER, "listenerLayer block")
  const start = oneIndex(lines, START, "startListener block")
  const memo = defaultMemoMap(lines)

  const routeBefore = lines.slice(listener, listener + 8).filter((line) => ROUTE_BEFORE.test(line)).length
  const routeAfter = lines.slice(listener, listener + 8).filter((line) => ROUTE_AFTER.test(line)).length
  const memoBefore = lines.slice(start, start + 8).filter((line) => MEMO_BEFORE.test(line)).length
  const memoAfter = lines.slice(start, start + 8).filter((line) => MEMO_AFTER.test(line)).length

  if (routeAfter === 1 && memoAfter === 1) {
    const patchedMemo = lines
      .slice(start, start + 8)
      .find((line) => MEMO_AFTER.test(line))!
      .match(MEMO_AFTER)![4]
    if (patchedMemo !== memo) throw new Error("sidecar listener uses a different memo map than Default")
    return text
  }
  if (routeAfter !== 0 || memoAfter !== 0) throw new Error("sidecar shared-routes patch is only partially applied")
  if (routeBefore !== 1) throw new Error(`expected one unpatched listener route, found ${routeBefore}`)
  if (memoBefore !== 1) throw new Error(`expected one unpatched listener memo map, found ${memoBefore}`)

  const routeIndex = oneNear(lines, listener, ROUTE_BEFORE, "unpatched listener route")
  const route = lines[routeIndex]!.match(ROUTE_BEFORE)!
  const server = route[3]!
  lines[routeIndex] = lines[routeIndex]!.replace(
    `${server}.createRoutes(opts)`,
    `opts.cors?.length === 1 && opts.cors[0] === "oc://renderer" ? ${server}.routes : ${server}.createRoutes(opts)`,
  )

  const memoIndex = oneNear(lines, start, MEMO_BEFORE, "unpatched listener memo map")
  const memoMatch = lines[memoIndex]!.match(MEMO_BEFORE)!
  lines[memoIndex] = lines[memoIndex]!.replace(`${memoMatch[2]}.makeMemoMapUnsafe()`, memo)
  return lines.join(newline)
}

if (import.meta.main) {
  const text = await Bun.file(FILE).text()
  const patched = patchSidecarSharedRoutes(text)
  if (patched === text) {
    console.log("[alpha:patch-sidecar-shared-routes] Electron listener already shares Default routes and memo map")
  } else {
    await Bun.write(FILE, patched)
    console.log("[alpha:patch-sidecar-shared-routes] Electron listener now shares Default routes and memo map (#857)")
  }
}
