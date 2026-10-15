#!/usr/bin/env bun
import assert from "node:assert/strict"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { CLOUD_MCP_TOOLS } from "../../../packages/ui-mac/src/main/fixtures/cloud-mcp-tools"
import snapshot from "./tool-snapshot.json"

type Route = "local" | "cloud" | "ask"
type Outcome = Route | "undecided" | "error"
type Case = { id: string; prompt: string; expected: Route; reason: string; counterexample: boolean; rows: string[]; localSearch?: boolean }
type Call = { input: number; output: number; usd: number; promptBytes: number; toolBytes: number; responseBytes: number; toolNames?: string[] }
type Row = Call & { variant: string; case: string; repeat: number; expected: Route; observed: Outcome | null; tool?: string; text?: string; error?: string; limitReached?: boolean; retries: number; failures: { code: string; attempt: number }[]; preflights: { tool: string; args: Record<string, unknown> }[]; calls: Call[]; instructions: { tool: string; name?: string; path?: string }[] }
const here = import.meta.dir
const repo = resolve(here, "../../..")
const variants = [{ name: "before", ref: "133f463d9", skill: "cloud-dispatch" }, { name: "after", ref: "HEAD", skill: "cloud-capabilities" }]
const priceBasis = { model: "deepseek-v4-flash", inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.28, source: "https://github.com/jinjunnn/alpha-platform/blob/d4a4b75755a07dcc583e1ba925579f0c01221997/packages/gateway/src/models.config.json#L13" }
const maxCalls = 4
const selfTest = process.argv.includes("--self-test")

function classify(tool?: string, text = ""): Route | null {
  if (tool === "invalid") return null
  if (tool === "question") return "ask"
  if (tool === "alpha_cloud_access" || CLOUD_MCP_TOOLS.some((name) => tool === name || tool?.endsWith(`_${name}`))) return "cloud"
  if (tool) return "local"
  if (!text.trim()) return null
  return /[?？]|请(?:确认|问|提供|选择|告知)|是否(?:允许|同意|授权)/u.test(text) ? "ask" : "local"
}

function freePreflight(tool: string, args: Record<string, unknown>) {
  if (tool === "alpha_cloud_access") return Object.keys(args).length === 0
  if (!["cloud_account_status", "cloud_cloud_account_status"].includes(tool)) return false
  return Object.entries(args).every(([key, value]) => key === "format" ? ["docx", "xlsx", "pptx"].includes(String(value)) : key === "task" && ["image-generation", "research", "code-review", "docs", "office-report", "html-generate", "data-analysis", "bugfix", "migration", "bounded-agent:openai_agents", "bounded-agent:claude_code"].includes(String(value)))
}

function score(rows: Row[], cases: Case[], repeats: number) {
  return Object.fromEntries(variants.map(({ name }) => {
    const selected = rows.filter((row) => row.variant === name)
    const perCase = cases.map((item) => {
      const runs = selected.filter((row) => row.case === item.id)
      const votes = (["local", "cloud", "ask", "undecided", "error"] as Outcome[]).map((route) => ({ route, count: runs.filter((r) => r.observed === route).length })).sort((a, b) => b.count - a.count)
      const complete = runs.length === repeats && runs.every((r) => r.observed)
      const majority = complete && repeats === 3 && votes[0].count >= 2 ? votes[0].route : null
      return { id: item.id, observed: runs.map((r) => r.observed), majority, majorityCorrect: majority === item.expected, consistency: complete ? votes[0].count / repeats : null, unanimous: complete && votes[0].count === repeats }
    })
    const complete = selected.length === cases.length * repeats && selected.every((r) => r.observed)
    const rates = Array.from({ length: repeats }, (_, i) => selected.filter((r) => r.repeat === i + 1 && r.observed === r.expected).length / cases.length)
    return [name, { runs: selected.length, correct: selected.filter((r) => r.observed === r.expected).length, accuracy: selected.length ? selected.filter((r) => r.observed === r.expected).length / selected.length : null, majorityAccuracy: complete && repeats === 3 ? perCase.filter((r) => r.majorityCorrect).length / cases.length : null, unanimousCases: perCase.filter((r) => r.unanimous).length, repeatAccuracy: complete ? rates : null, noiseRange: complete && repeats === 3 ? Math.max(...rates) - Math.min(...rates) : null, complete, perCase }]
  }))
}

function money(input: number, output: number, prices: number[]) {
  return (input * prices[0] + output * prices[1]) / 1_000_000
}

if (selfTest) {
  assert(freePreflight("alpha_cloud_access", {}))
  assert(freePreflight("cloud_cloud_account_status", { task: "office-report", format: "docx" }))
  assert(!freePreflight("alpha_cloud_access", { path: "/eval/private.docx" }))
  assert(!freePreflight("cloud_cloud_account_status", { task: "/eval/private.docx" }))
  assert(!freePreflight("cloud_cloud_dispatch", { input: { data: "private" } }))
  assert.equal(classify("cloud_cloud_dispatch"), "cloud")
  assert.equal(classify("alpha_cloud_access"), "cloud")
  assert.equal(classify("alpha_word_read_docx"), "local")
  assert.equal(classify("question"), "ask")
  assert.equal(classify(undefined, "允许把私有文件上传吗？"), "ask")
  assert.equal(classify(undefined, "答案是 42。"), "local")
  assert.equal(classify(undefined, ""), null)
  const cases = [{ id: "a", expected: "local" }, { id: "b", expected: "cloud" }] as Case[]
  const rows = ["local", "ask", "local", "cloud", "cloud", "ask"].map((route, i) => ({ variant: "before", case: i < 3 ? "a" : "b", repeat: i % 3 + 1, expected: i < 3 ? "local" : "cloud", observed: route })) as Row[]
  const result = score(rows, cases, 3).before
  assert.equal(result.accuracy, 4 / 6)
  assert.equal(result.majorityAccuracy, 1)
  assert.deepEqual(result.repeatAccuracy, [1, 0.5, 0.5])
  assert.equal(result.noiseRange, 0.5)
  assert.equal(result.perCase[0].consistency, 2 / 3)
  assert.equal(score([{ ...rows[0], observed: "undecided" }], cases.slice(0, 1), 1).before.accuracy, 0)
  assert.equal(score(rows.slice(0, 1), cases, 3).before.noiseRange, null)
  assert.equal(money(1_000_000, 500_000, [2, 4]), 4)
  assert.deepEqual([...snapshot.cloud.map((t) => t.name)].sort(), [...CLOUD_MCP_TOOLS].sort())
  console.log("self-test: classification, majority, consistency, noise, incomplete run, usage cost, tool inventory OK")
}

const args = process.argv.slice(2).filter((arg) => arg !== "--self-test")
assert(args.every((v, i) => ["--real", "--sample", "--out"].includes(v) || ["--sample", "--out"].includes(args[i - 1])), "Unknown argument")
const sample = selfTest ? 1 : args.includes("--sample") ? Number(args[args.indexOf("--sample") + 1]) : undefined
assert(sample === undefined || (Number.isInteger(sample) && sample > 0), "--sample needs a positive integer")
const real = args.includes("--real")
const priorUsd = Number(process.env.EVAL_PRIOR_USD ?? 0)
const priorUnknownUsd = Number(process.env.EVAL_PRIOR_RESERVE_USD ?? 0)
const uncertain = { reserveUsd: 0, attempts: 0 }
const execution = { protocol: "round2-private-upload-v1", priorUsd, priorUnknownUsd, retryPolicy: "network/429/5xx: one retry per round; error counts wrong and continues", expiresAt: "2026-10-15T16:19:34Z" }
assert(!selfTest || !real, "Self-test never uses a real provider")
const model = real ? process.env.EVAL_MODEL_ID : "routing-fake"
const upstream = real ? process.env.EVAL_PROVIDER_BASE_URL : undefined
const keyFile = real ? process.env.EVAL_PROVIDER_KEY_FILE : undefined
const prices = ["EVAL_INPUT_USD_PER_MILLION", "EVAL_OUTPUT_USD_PER_MILLION"].map((name) => Number(process.env[name] ?? (real ? NaN : 0)))
const budget = Number(process.env.EVAL_BUDGET_USD ?? (real ? NaN : Infinity))
const maxAttemptUsd = money(128000, 1024, prices)
const overBudget = () => usage.usd + uncertain.reserveUsd + maxAttemptUsd > budget || priorUsd + priorUnknownUsd + usage.usd + uncertain.reserveUsd + maxAttemptUsd > 10
assert([priorUsd, priorUnknownUsd].every((n) => Number.isFinite(n) && n >= 0), "Invalid prior cost")
assert(prices.every((p) => Number.isFinite(p) && p >= 0), "Explicit nonnegative token prices required")
assert(budget > 0 && (!real || Number.isFinite(budget)), "Positive EVAL_BUDGET_USD required")
if (real) {
  assert(model && upstream && keyFile, "--real requires EVAL_MODEL_ID, EVAL_PROVIDER_BASE_URL, EVAL_PROVIDER_KEY_FILE")
  assert.equal(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo }).stdout.toString().trim(), "", "Commit criteria and skills before paid execution")
  const url = new URL(upstream)
  assert(["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search, "Invalid provider base URL")
}
const corpus = await Bun.file(join(here, "cases.json")).json() as Case[]
assert(corpus.length >= 22 && corpus.filter((c) => c.counterexample).length >= 6, "Corpus coverage below brief")
assert(["explicit-cloud", "local-office", "new-layout", "image", "fact-page", "research", "review", "private-upload", "paid-preflight"].every((tag) => corpus.some((c) => c.rows.includes(tag))), "Routing table row missing")
const cases = corpus.slice(0, sample)
assert(cases.length >= 1 && new Set(cases.map((c) => c.id)).size === cases.length)
assert(cases.every((c) => c.prompt && c.reason && ["local", "cloud", "ask"].includes(c.expected)))
assert.deepEqual(snapshot.cloud.map((t) => t.name).sort(), [...CLOUD_MCP_TOOLS].sort())
const repeats = sample ? 1 : 3
const out = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : join(here, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`))
const temp = await realpath(await mkdtemp(join(tmpdir(), "cloud-routing-eval-")))
const rows: Row[] = []
const usage = { input: 0, output: 0, usd: 0, calls: 0 }
const receipt = { loaded: 0, advertised: [] as string[], blockedFollowups: 0, rejectedForeignSessions: 0 }
const digests = Object.fromEntries(await Promise.all(["cases.json", "tool-snapshot.json", "run.ts", "plugin.ts", "mcp.ts", "preflight-fixtures.json", "README.md"].map(async (file) => [file, new Bun.CryptoHasher("sha256").update(await Bun.file(join(here, file)).bytes()).digest("hex")])))
const identity = { criteria: "round2-private-upload-v1", engine: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim(), digests, variants: [] as { name: string; commit: string; tree: string; skillBytes: number }[] }
const state = { stop: "", active: undefined as undefined | { row: Row; decision: Promise<void>; resolve: () => void; requests: number; sessionID: string; localSearch: boolean; skills: string } }

// Loopback model proxy: collect complete usage BEFORE replaying the response to the engine.
// Instruction loads may continue; a fifth request never reaches the model/provider.
const control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  if (path === "/loaded") { receipt.loaded++; return new Response("OK") }
  const active = state.active
  if (!active) return new Response("No active round", { status: 409 })
  if (path === "/instruction") {
    const { sessionID, ...loading } = await request.json() as { sessionID: string; tool: string; name?: string; path?: string }
    if (sessionID !== active.sessionID) return new Response("Wrong session", { status: 409 })
    active.row.instructions.push(loading)
    return new Response("OK")
  }
  if (path === "/decision") {
    const value = await request.json() as { tool: string; sessionID: string; args: Record<string, unknown>; phase: string }
    if (value.sessionID !== active.sessionID) return new Response("Wrong session", { status: 409 })
    if (active.row.expected === "ask" && freePreflight(value.tool, value.args)) {
      if (value.phase === "execute") active.row.preflights.push({ tool: value.tool, args: value.args })
      return new Response("CONTINUE")
    }
    if (!active.row.tool) {
      active.row.tool = value.tool
      active.row.observed = classify(value.tool)
      active.resolve()
    }
    return new Response("STOP")
  }
  if (path !== "/v1/chat/completions") return new Response("Unexpected endpoint", { status: 404 })
  if (request.headers.get("x-opencode-session-id") !== active.sessionID) { receipt.rejectedForeignSessions++; return new Response("EVAL_STALE_SESSION", { status: 400 }) }
  if (active.row.observed || state.stop) { receipt.blockedFollowups++; return new Response("EVAL_STOP", { status: 400 }) }
  if (active.requests >= maxCalls) {
    receipt.blockedFollowups++
    active.row.observed = "undecided"; active.row.limitReached = true; active.resolve()
    return new Response("EVAL_MODEL_CALL_LIMIT", { status: 400 })
  }
  active.requests++
  try {
    assert(receipt.loaded === identity.variants.length, "Real ext wrapper not loaded")
    const body = await request.json() as { messages: unknown[]; tools: { function: { name: string } }[]; model: string; stream: boolean; stream_options?: unknown }
    receipt.advertised = body.tools.map((t) => t.function.name)
    assert(CLOUD_MCP_TOOLS.every((name) => receipt.advertised.includes(`cloud_${name}`)), "Cloud stub inventory missing")
    assert(Object.entries(snapshot.office).every(([group, tools]) => tools.every((t) => receipt.advertised.includes(`alpha_${group}_${t.name}`))), "Office stub inventory missing")
    assert(active.localSearch ? ["websearch", "webfetch"].every((name) => receipt.advertised.includes(name)) : ["websearch", "webfetch"].every((name) => !receipt.advertised.includes(name)), "Local search availability mismatch")
    assert(receipt.advertised.includes("alpha_cloud_access"), "Ext cloud access tool missing")
    assert(JSON.stringify(body.messages).includes(active.row.variant === "before" ? "cloud-dispatch" : "cloud-capabilities"), "Factory routing skill catalog missing")
    if (!real && active.requests > 1) {
      assert(JSON.stringify(body.messages).includes(active.row.variant === "before" ? "# Cloud dispatch" : "# Code Puppy 本机与云端"), "Routing skill body missing from continuation")
      assert(JSON.stringify(body.messages).includes("# Office documents"), "Office instruction body missing from continuation")
    }
    const callUsage: Call = { input: 0, output: 0, usd: 0, promptBytes: Buffer.byteLength(JSON.stringify(body.messages)), toolBytes: Buffer.byteLength(JSON.stringify(body.tools)), responseBytes: 0 }
    if (overBudget()) {
      state.stop = "budget_headroom"; active.resolve(); return new Response("EVAL_BUDGET_HEADROOM", { status: 402 })
    }
    let response: Response | undefined
    let realWire: string | undefined
    if (real) {
      for (const attempt of [1, 2]) {
        if (overBudget()) { state.stop = "budget_headroom"; active.resolve(); return new Response("EVAL_BUDGET_HEADROOM", { status: 402 }) }
        response = undefined
        try {
          if (Date.now() >= Date.parse(execution.expiresAt)) { state.stop = "key_expired"; active.resolve(); return new Response("EVAL_KEY_EXPIRED", { status: 400 }) }
          response = await fetch(`${upstream!.replace(/\/$/, "")}/chat/completions`, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
            headers: { "content-type": "application/json", authorization: `Bearer ${(await Bun.file(keyFile!).text()).trim()}` },
            body: JSON.stringify({ ...body, model, stream: true, stream_options: { include_usage: true } }),
          })
          if (response.ok) { realWire = await response.text(); break }
          const code = `http_${response.status}`
          active.row.failures.push({ code, attempt })
          const retryable = response.status === 429 || response.status >= 500
          if (response.status >= 500) { uncertain.reserveUsd += maxAttemptUsd; uncertain.attempts++ }
          await response.body?.cancel()
          if (!retryable || active.row.retries || active.requests >= maxCalls) throw new Error(code)
        } catch {
          if (response && !response.ok) throw new Error(`http_${response.status}`)
          active.row.failures.push({ code: "network_error", attempt })
          uncertain.reserveUsd += maxAttemptUsd; uncertain.attempts++
          if (active.row.retries || active.requests >= maxCalls) throw new Error("network_error")
        }
        active.row.retries++; active.requests++
        await Bun.sleep(1000)
      }
    }
    const serial = (Number(active.row.case.replace(/\D/g, "")) - 1) * 3 + active.row.repeat - 1
    const action = serial % 6
    const decision = action === 0 ? { name: "alpha_word_read_docx", arguments: '{"path":"/eval/report.docx"}' }
      : action === 1 ? { name: "alpha_cloud_access", arguments: "{}" }
      : action === 2 ? { name: "question", arguments: '{"questions":[{"question":"是否允许上传？","header":"授权","options":[{"label":"允许","description":"上传"},{"label":"拒绝","description":"保持本机"}]}]}' }
      : action === 3 ? { name: "websearch", arguments: '{"query":"example"}' } : undefined
    const loads = [{ name: "skill", arguments: JSON.stringify({ name: active.row.variant === "before" ? "cloud-dispatch" : "cloud-capabilities" }) }, serial % 2 ? { name: "read", arguments: JSON.stringify({ filePath: join(active.skills, "office-docs/SKILL.md") }) } : { name: "skill", arguments: '{"name":"office-docs"}' }]
    const privacySteps = active.row.case >= "c25" && action === 1
    const next = active.row.case >= "c25" && action === 3 ? { name: "cloud_cloud_dispatch", arguments: '{"schema_version":1,"idempotency_key":"eval-stub-dispatch","autonomy":"pipeline","kind":"office-report","input":{"topic":"/eval/private.docx","format":"docx"}}' }
      : privacySteps && active.requests === 3 ? { name: "cloud_cloud_account_status", arguments: '{"task":"office-report","format":"docx"}' }
      : privacySteps && active.requests === 4 ? { name: "question", arguments: '{"questions":[{"question":"是否允许上传私有文件？","header":"授权","options":[{"label":"允许","description":"上传"},{"label":"拒绝","description":"保持本机"}]}]}' } : decision
    const tools = selfTest || active.requests === 1 ? loads : next ? [next] : []
    const delta = { role: "assistant", ...(tools.length ? { tool_calls: tools.map((fn, index) => ({ index, id: `call-${active.requests}-${index}`, type: "function", function: fn })) } : { content: action === 4 ? "结果是 42。" : "请确认是否允许上传？" }) }
    const chunk = (delta: unknown, finish_reason: string | null = null, tokens?: unknown) => `data: ${JSON.stringify({ id: "chatcmpl-eval", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...(tokens ? { usage: tokens } : {}) })}\n\n`
    // Script independent of expected labels AND variant; exercises wrong answers and repeat noise.
    const wire = realWire !== undefined ? realWire : chunk(delta) + chunk({}, tools.length ? "tool_calls" : "stop", { prompt_tokens: Math.ceil((callUsage.promptBytes + callUsage.toolBytes) / 3), completion_tokens: Math.ceil(Buffer.byteLength(JSON.stringify([delta, {}])) / 3) }) + "data: [DONE]\n\n"
    const chunks = wire.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)))
    const tokens = chunks.findLast((c) => c.usage)?.usage
    assert(tokens && [tokens.prompt_tokens, tokens.completion_tokens].every((n) => Number.isFinite(n) && n >= 0), "Missing/invalid provider usage; stopped")
    callUsage.toolNames = [...new Set(chunks.flatMap((c) => c.choices.flatMap((v: { delta: { tool_calls?: { function?: { name?: string } }[] } }) => (v.delta.tool_calls ?? []).map((t) => t.function?.name).filter(Boolean))))] as string[]
    callUsage.input = tokens.prompt_tokens
    callUsage.output = tokens.completion_tokens
    callUsage.usd = money(callUsage.input, callUsage.output, prices)
    callUsage.responseBytes = Buffer.byteLength(JSON.stringify(chunks.flatMap((c) => c.choices.map((v: { delta: unknown }) => v.delta))))
    active.row.calls.push(callUsage)
    active.row.input += callUsage.input; active.row.output += callUsage.output; active.row.usd += callUsage.usd
    active.row.promptBytes += callUsage.promptBytes; active.row.toolBytes += callUsage.toolBytes; active.row.responseBytes += callUsage.responseBytes
    usage.input += callUsage.input; usage.output += callUsage.output; usage.usd += callUsage.usd; usage.calls++
    await save()
    if (usage.usd + uncertain.reserveUsd > budget || priorUsd + priorUnknownUsd + usage.usd + uncertain.reserveUsd > 10) { state.stop = "budget_exceeded"; active.resolve(); return new Response("EVAL_BUDGET_EXCEEDED", { status: 402 }) }
    return new Response(wire, { headers: { "content-type": "text/event-stream" } })
  } catch (error) {
    if (!real) console.error(error instanceof Error ? error.message : "Fake provider failure")
    const code = error instanceof Error && /^http_\d+$/.test(error.message) ? error.message : "provider_or_usage_error"
    active.row.error = code; active.row.observed = "error"
    active.resolve()
    return new Response("EVAL_ROUND_ERROR", { status: 400 })
  }
} })

function save() {
  const summary = score(rows, cases, repeats)
  const noise = summary.before.noiseRange === null || summary.after.noiseRange === null ? null : Math.max(summary.before.noiseRange, summary.after.noiseRange)
  const delta = summary.before.accuracy === null || summary.after.accuracy === null ? null : summary.after.accuracy - summary.before.accuracy
  const comparison = { delta, noiseBand: noise, improvedBeyondNoise: noise === null || delta === null ? null : delta > 0 && delta > noise, ac3Evidence: real && !sample && !state.stop && noise !== null && delta !== null && delta > noise && delta > 0 }
  const pct = (n: number | null) => n === null ? "—" : `${(n * 100).toFixed(2)}%`
  const markdown = `模式：${real ? "真实 provider" : "假 provider（仅链路校验，不能证明 AC3 提升）"}；${cases.length} 例 × ${repeats} 次。\n\n| 变体 | 正确/次数 | 按次正确率 | 多数票正确率 | 三次全一致/例数 | 噪声极差 |\n|---|---:|---:|---:|---:|---:|\n${variants.map((v) => { const s = summary[v.name]; return `| ${v.name} | ${s.correct}/${s.runs} | ${pct(s.accuracy)} | ${pct(s.majorityAccuracy)} | ${repeats === 3 ? `${s.unanimousCases}/${cases.length}` : "—"} | ${pct(s.noiseRange)} |` }).join("\n")}\n\n改后−改前：${pct(delta)}；噪声带：${pct(noise)}；超出噪声：${comparison.improvedBeyondNoise ?? "未判定"}。\nusage：${usage.input} in / ${usage.output} out；累计 $${usage.usd.toFixed(6)}；停止原因：${state.stop || "completed"}。\n`
  const projection = real ? null : { ...priceBasis, estimatedUsd: money(usage.input, usage.output, [priceBasis.inputUsdPerMillion, priceBasis.outputUsdPerMillion]), basis: "UTF-8 JSON bytes / 3; cache-miss model USD rates, not wallet settlement" }
  return Promise.all([Bun.write(out, JSON.stringify({ schemaVersion: 4, execution, uncertain, maxCalls, mode: real ? "real" : "fake", createdAt: new Date().toISOString(), identity, model, sample: sample ?? null, caseCount: cases.length, repeats, pricesPerMillion: prices, budgetUsd: Number.isFinite(budget) ? budget : null, stopReason: state.stop || "completed", usage, projection, receipt, comparison, summary, rows, markdown }, null, 2) + "\n"), Bun.write(out.replace(/\.json$/, "") + ".md", markdown)]).then(() => markdown)
}

try {
  for (const variant of variants) {
    if (state.stop) break
    const dir = join(temp, variant.name)
    await mkdir(join(dir, "config"), { recursive: true })
    await mkdir(join(dir, "global"))
    await mkdir(join(dir, "workspace"))
    const archive = Bun.spawnSync(["git", "archive", variant.ref, "packages/ui-mac/resources/factory-skills"], { cwd: repo })
    assert.equal(archive.exitCode, 0)
    const extract = Bun.spawnSync(["tar", "-xf", "-", "-C", dir], { stdin: archive.stdout })
    assert.equal(extract.exitCode, 0)
    const skills = join(dir, "packages/ui-mac/resources/factory-skills")
    identity.variants.push({ name: variant.name, commit: Bun.spawnSync(["git", "rev-parse", variant.ref], { cwd: repo }).stdout.toString().trim(), tree: Bun.spawnSync(["git", "rev-parse", `${variant.ref}:packages/ui-mac/resources/factory-skills`], { cwd: repo }).stdout.toString().trim(), skillBytes: (await Promise.all([variant.skill, "office-docs"].map(async (n) => (await Bun.file(join(skills, n, "SKILL.md")).bytes()).length))).reduce((a, b) => a + b, 0) })
    const config = {
      plugin: [pathToFileURL(join(here, "plugin.ts")).href], snapshot: false, share: "disabled", enabled_providers: ["eval"],
      provider: { eval: { npm: "@ai-sdk/openai-compatible", name: "Routing evaluation", models: { [model!]: { name: model, limit: { context: 128000, output: 1024 } } }, options: { baseURL: `${control.url.origin}/v1`, apiKey: "eval-placeholder" } } },
      agent: { build: { permission: { "*": "allow" } }, title: { disable: true }, summary: { disable: true } },
      mcp: Object.fromEntries(["cloud", "word", "excel", "powerpoint", "pdf"].map((name) => [name === "cloud" ? name : `alpha_${name}`, { type: "local", command: [process.execPath, join(here, "mcp.ts"), name] }])),
    }
    await Bun.write(join(dir, "config/opencode.json"), JSON.stringify(config))
    const child = Bun.spawn([process.execPath, `--tsconfig-override=${join(repo, "packages/opencode/tsconfig.json")}`, join(repo, "packages/opencode/src/index.ts"), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: join(dir, "workspace"), stdout: "pipe", stderr: "pipe", env: {
        PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OPENCODE_TEST_HOME: dir,
        XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), XDG_STATE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "xdg"),
        OPENCODE_CONFIG_DIR: join(dir, "config"), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1", OPENCODE_ENABLE_EXA: "1", OPENCODE_ENABLE_QUESTION_TOOL: "1", OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "1024", npm_config_offline: "true",
        npm_config_userconfig: join(dir, "empty-user.npmrc"), npm_config_globalconfig: join(dir, "empty-global.npmrc"),
        ALPHA_GLOBAL_DIR: join(dir, "global"), ALPHA_FACTORY_SKILL_DIRS: JSON.stringify([skills]), EVAL_CONTROL_URL: control.url.origin,
      },
    })
    const stderr = new Response(child.stderr).text()
    try {
      const reader = child.stdout.getReader()
      const ready = (async () => {
        let log = ""
        while (true) {
          const read = await reader.read()
          if (read.done) throw new Error(`Engine exited before ready: ${log.slice(-2000)} ${(await stderr).slice(-1500)}`)
          log += new TextDecoder().decode(read.value)
          const match = log.match(/opencode server listening on (http:\/\/\S+)/)
          if (match) { void (async () => { while (!(await reader.read()).done) {} })(); return match[1] }
        }
      })()
      const timeout = Promise.withResolvers<never>()
      const timer = setTimeout(() => timeout.reject(new Error("Engine startup timeout")), 45_000)
      const base = await Promise.race([ready, timeout.promise]).finally(() => clearTimeout(timer))
      const api = async (path: string, body: unknown) => {
        const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-opencode-directory": join(dir, "workspace") }, body: JSON.stringify(body), signal: AbortSignal.timeout(390_000) })
        assert(response.ok, `Engine HTTP ${response.status} on ${path}`)
        return response.json()
      }
      for (const item of cases) {
        for (const repeat of Array.from({ length: repeats }, (_, i) => i + 1)) {
          if (state.stop) break
          const row: Row = { variant: variant.name, case: item.id, repeat, expected: item.expected, observed: null, retries: 0, failures: [], preflights: [], calls: [], instructions: [], input: 0, output: 0, usd: 0, promptBytes: 0, toolBytes: 0, responseBytes: 0 }
          rows.push(row)
          const session = await api("/session", { title: "routing-eval" }) as { id: string }
          const deferred = Promise.withResolvers<void>()
          state.active = { row, decision: deferred.promise, resolve: () => deferred.resolve(), requests: 0, sessionID: session.id, localSearch: item.localSearch !== false, skills }
          const pending = api(`/session/${session.id}/message`, { model: { providerID: "eval", modelID: model }, agent: "build", tools: item.localSearch === false ? { websearch: false, webfetch: false } : undefined, parts: [{ type: "text", text: item.prompt }] }).then((message) => ({ message }), () => ({ message: null }))
          const finished = await Promise.race([pending, deferred.promise.then(() => ({ message: null }))])
          if (row.observed || state.stop) await api(`/session/${session.id}/abort`, {}).catch(() => undefined)
          await pending
          const permits = await fetch(base + "/permission", { headers: { "x-opencode-directory": join(dir, "workspace") }, signal: AbortSignal.timeout(10_000) }).then((r) => r.json()) as { id: string }[]
          for (const permit of permits) await api(`/permission/${permit.id}/reply`, { reply: "reject" }).catch(() => undefined)
          if (!row.observed && finished.message) {
            row.text = (finished.message as { parts: { type: string; text?: string }[] }).parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n")
            row.observed = classify(undefined, row.text)
          }
          if (state.stop) row.error = state.stop
          if (!row.observed) { row.observed = "error"; row.error = "engine_or_empty_response" }
          await save()
          console.log(`${row.variant} ${row.case} #${repeat}: ${row.observed ?? row.error} (${row.input}/${row.output})`)
        }
      }
    } finally {
      child.kill("SIGKILL")
      await child.exited
      await stderr
    }
  }
} catch (error) {
  state.stop ||= "harness_error"
  console.error(error instanceof Error ? error.message : "Harness failure")
} finally {
  control.stop(true)
  console.log(await save())
  console.log(`Result: ${out}`)
  await rm(temp, { recursive: true, force: true })
}
if (state.stop && !["budget_exceeded", "budget_headroom"].includes(state.stop)) process.exitCode = 1
if (selfTest) {
  assert.equal(state.stop, "")
  assert.equal(rows.length, 2)
  assert(rows.every((row) => row.observed === "undecided" && row.calls.length === 4 && row.instructions.length === 8))
  assert.equal(usage.calls, 8)
  console.log("self-test: native skill contents, ignored skill/read calls, four-call cap and undecided scoring OK")
}
