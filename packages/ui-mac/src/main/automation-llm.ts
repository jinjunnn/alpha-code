// REQ-024(A2)—— LLM 辅助解析:一句话 → {name, schedule, prompt}。只在确定性规则
// (shared/automation-nl.ts)解析不出时由用户显式点击触发(省 token);临时会话一次抽取后即删,
// 不污染会话列表。执行链只走 SDK(ADR-002);预览确认流不变 —— LLM 产物只是填表,存前仍过
// 存储层硬校验(interval 下限/档位白名单)。
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { AutomationSchedule } from "../shared/automation-types"
import type { AutomationServerInfo } from "./automation-scheduler"
import { getLogger } from "./logging"

let awaitServer: (() => Promise<AutomationServerInfo>) | null = null
export function initAutomationLlm(deps: { awaitServer: () => Promise<AutomationServerInfo> }): void {
  awaitServer = deps.awaitServer
}

export type LlmParseResult =
  | { ok: true; name: string; schedule: AutomationSchedule; prompt: string }
  | { ok: false; reason: string }

const EXTRACT_INSTRUCTION = `你是一个定时任务解析器。把用户的一句话拆成 JSON(只输出 JSON,不要任何其它文字/代码块围栏):
{"name":"<8字内任务名>","schedule":{"kind":"cron","expr":"<5字段 cron(分 时 日 月 周)>"} 或 {"kind":"interval","everyMinutes":<数字,≥5>},"prompt":"<给执行 agent 的任务指令,保留用户意图,不含时间信息>"}
规则:能用 cron 表达就用 cron;模糊时间取合理值(如「饭点前」= 11:30);解析不出周期就输出 {"error":"<一句原因>"}。
用户输入:`

function sane(parsed: unknown): parsed is { name: string; schedule: AutomationSchedule; prompt: string } {
  const p = parsed as Record<string, unknown>
  if (!p || typeof p.name !== "string" || typeof p.prompt !== "string" || !p.name.trim() || !p.prompt.trim()) return false
  const sc = p.schedule as Record<string, unknown> | undefined
  if (!sc) return false
  if (sc.kind === "cron") return typeof sc.expr === "string" && sc.expr.trim().split(/\s+/).length === 5
  if (sc.kind === "interval") return typeof sc.everyMinutes === "number" && sc.everyMinutes >= 5
  return false
}

export async function llmParseAutomation(text: string, projectDir: string): Promise<LlmParseResult> {
  if (!text.trim()) return { ok: false, reason: "输入为空" }
  if (!awaitServer) return { ok: false, reason: "引擎未就绪" }
  const server = await awaitServer()
  const headers =
    server.username || server.password
      ? { Authorization: `Basic ${Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString("base64")}` }
      : undefined
  const client = createOpencodeClient({ baseUrl: server.url, headers })
  const directory = projectDir
  let sessionID: string | undefined
  try {
    const created = await client.session.create({ directory, title: "⏱ 自动化解析(临时)" } as never)
    const createdData = (created as { data?: { id?: string }; error?: unknown }).data
    if ((created as { error?: unknown }).error || !createdData?.id) return { ok: false, reason: "临时会话创建失败" }
    sessionID = createdData.id
    const res = await client.session.prompt({
      sessionID,
      directory,
      parts: [{ type: "text", text: EXTRACT_INSTRUCTION + text }],
    } as never)
    if ((res as { error?: unknown }).error) return { ok: false, reason: "模型调用失败" }
    const parts = ((res as { data?: { parts?: { type?: string; text?: string }[] } }).data?.parts ?? []) as { type?: string; text?: string }[]
    const reply = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim()
    // 容错:剥代码围栏 / 取首个 {...} 块
    const m = reply.match(/\{[\s\S]*\}/)
    if (!m) return { ok: false, reason: "模型未返回可解析的 JSON" }
    let parsed: unknown
    try {
      parsed = JSON.parse(m[0])
    } catch {
      return { ok: false, reason: "模型返回的 JSON 无法解析" }
    }
    const err = (parsed as { error?: unknown }).error
    if (typeof err === "string") return { ok: false, reason: err }
    if (!sane(parsed)) return { ok: false, reason: "模型返回的结构不合法(缺 name/schedule/prompt 或周期过密)" }
    return { ok: true, name: parsed.name.trim().slice(0, 32), schedule: parsed.schedule, prompt: parsed.prompt.trim() }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : "解析失败" }
  } finally {
    // 临时会话即删(best-effort;失败只留一条日志,不影响结果)
    if (sessionID) {
      const del = () => (client.session as unknown as { delete(args: unknown): Promise<unknown> }).delete({ sessionID, directory })
      try {
        await del()
      } catch {
        // codex L:一次重试;仍失败留 loud 日志(残留会话含用户自动化文本,可手动删)
        await new Promise((r) => setTimeout(r, 1500))
        try {
          await del()
        } catch {
          getLogger().warn("automation-llm: temp session delete failed twice — manual cleanup may be needed", sessionID)
        }
      }
    }
  }
}
