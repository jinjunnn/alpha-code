// REQ-160 `#1324` —— 切轮与 `turn` part 形状的判据。
//
// 每条断言对应线契约(alpha-web `docs/contracts/chat-archive-upload.md`)里一句具体的话,
// 期望值在本文件里手打成独立字面量,**不从被测模块 import 常量** —— 比较基准与被测对象同源时,
// 两边一起改错会一起自洽(本仓已实测过两次)。

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { buildTurns, billingPathFor, decodeDataUrl, type EngineMessage } from "./chat-archive-turn"

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`
const PNG_SHA256 = createHash("sha256").update(PNG).digest("hex")

function userMessage(id: string, text: string, extra: Partial<EngineMessage> = {}): EngineMessage {
  return {
    info: { id, role: "user", time: { created: 1000 }, model: { providerID: "alpha", modelID: "gpt-5" } },
    parts: [{ type: "text", text }],
    ...extra,
  }
}

function assistantMessage(id: string, text: string, completed: number, extra: Record<string, unknown> = {}): EngineMessage {
  return {
    info: {
      id,
      role: "assistant",
      time: { created: 1000, completed },
      providerID: "alpha",
      modelID: "gpt-5",
      finish: "stop",
      tokens: { output: 12 },
      ...extra,
    },
    parts: [{ type: "text", text }],
  }
}

const base = { engineSessionId: "ses_1", enabledAt: 0 }

describe("REQ-160 #1324 —— 一轮恰两条消息、user → assistant", () => {
  test("一对 user/assistant 组成一轮,两条都带 provider_id / model_id", () => {
    const { turns } = buildTurns({
      ...base,
      messages: [userMessage("msg_a", "你好"), assistantMessage("msg_b", "你也好", 2000)],
    })
    expect(turns).toHaveLength(1)
    expect(turns[0]?.body.messages).toHaveLength(2)
    expect(turns[0]?.body.messages[0]).toEqual({
      engine_message_id: "msg_a",
      role: "user",
      text: "你好",
      provider_id: "alpha",
      model_id: "gpt-5",
    })
    expect(turns[0]?.body.messages[1]).toEqual({
      engine_message_id: "msg_b",
      role: "assistant",
      text: "你也好",
      provider_id: "alpha",
      model_id: "gpt-5",
      finish: "stop",
      tokens_output: 12,
    })
    expect(turns[0]?.assistantMessageId).toBe("msg_b")
  })

  test("消息上不得出现 content_hash —— 服务端自己算,带了会被 invalid_turn 拒", () => {
    const { turns } = buildTurns({
      ...base,
      messages: [userMessage("msg_a", "你好"), assistantMessage("msg_b", "你也好", 2000)],
    })
    for (const message of turns[0]?.body.messages ?? []) {
      expect(Object.keys(message)).not.toContain("content_hash")
    }
    // 服务端按**键名**(不是子串)在任意深度上拒这六个,一律 400 forbidden_field。
    // 这里独立重写一遍那次遍历 —— 判据不从被测对象派生。
    const keysAtAnyDepth = (value: unknown, out: string[] = []): string[] => {
      if (Array.isArray(value)) {
        for (const item of value) keysAtAnyDepth(item, out)
        return out
      }
      if (!value || typeof value !== "object") return out
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        out.push(key)
        keysAtAnyDepth(nested, out)
      }
      return out
    }
    const keys = keysAtAnyDepth(JSON.parse(JSON.stringify(turns[0]?.body)) as unknown)
    for (const forbidden of ["id", "user_uid", "session_id", "message_id", "attachment_id", "created_at"]) {
      expect(keys).not.toContain(forbidden)
    }
    // 反向自证:这个遍历真的看得见嵌套键,不是恒空。
    expect(keys).toContain("engine_session_id")
    expect(keys).toContain("provider_id")
    expect(keysAtAnyDepth({ a: [{ session_id: 1 }] })).toContain("session_id")
  })

  test("没有 user 前驱的 assistant 消息跳过,而不是补一条合成 user", () => {
    const { turns, skipped } = buildTurns({
      ...base,
      messages: [assistantMessage("msg_lonely", "引擎自发的一段", 2000)],
    })
    expect(turns).toHaveLength(0)
    expect(skipped[0]?.reason).toContain("no user predecessor")
  })

  test("compaction 的产出跳过:assistant 带 summary:true,其 user 前驱只挂 compaction part", () => {
    const compactionUser: EngineMessage = {
      info: { id: "msg_cu", role: "user", time: { created: 1000 }, model: { providerID: "alpha", modelID: "gpt-5" } },
      parts: [{ type: "compaction" }],
    }
    const bySummary = buildTurns({
      ...base,
      messages: [compactionUser, assistantMessage("msg_ca", "摘要", 2000, { summary: true })],
    })
    expect(bySummary.turns).toHaveLength(0)
    expect(bySummary.skipped[0]?.reason).toContain("compaction")

    // 第二条独立判据:就算 summary 标记哪天没了,compaction 的 user 前驱本身也判得出来。
    const byParent = buildTurns({
      ...base,
      messages: [compactionUser, assistantMessage("msg_ca", "摘要", 2000)],
    })
    expect(byParent.turns).toHaveLength(0)
    expect(byParent.skipped[0]?.reason).toContain("compaction")
  })

  test("引擎注入的 synthetic 文本不算用户说的话;剔干净后什么都不剩的轮次整轮跳过", () => {
    const syntheticOnly: EngineMessage = {
      info: { id: "msg_su", role: "user", time: { created: 1000 }, model: { providerID: "alpha", modelID: "gpt-5" } },
      parts: [{ type: "text", text: "Summarize the task tool output above and continue with your task.", synthetic: true }],
    }
    const { turns, skipped } = buildTurns({
      ...base,
      messages: [syntheticOnly, assistantMessage("msg_sa", "好的", 2000)],
    })
    expect(turns).toHaveLength(0)
    expect(skipped[0]?.reason).toContain("nothing the user authored")

    // 用户真打了字的那一轮:synthetic 提醒被剔掉,用户原话原样保留。
    const mixed: EngineMessage = {
      info: { id: "msg_mu", role: "user", time: { created: 1000 }, model: { providerID: "alpha", modelID: "gpt-5" } },
      parts: [
        { type: "text", text: "帮我改一下" },
        { type: "text", text: "<system-reminder>plan mode</system-reminder>", synthetic: true },
        { type: "text", text: "忽略我", ignored: true },
      ],
    }
    const kept = buildTurns({ ...base, messages: [mixed, assistantMessage("msg_ma", "好", 2000)] })
    expect(kept.turns[0]?.body.messages[0]?.text).toBe("帮我改一下")
  })

  test("未完成的 assistant(time.completed 缺席)不上报", () => {
    const pending: EngineMessage = {
      info: { id: "msg_p", role: "assistant", time: { created: 1000 }, providerID: "alpha", modelID: "gpt-5" },
      parts: [{ type: "text", text: "写到一半" }],
    }
    const { turns } = buildTurns({ ...base, messages: [userMessage("msg_u", "在吗"), pending] })
    expect(turns).toHaveLength(0)
  })

  test("不回填历史:启用时刻之前完成的轮次一条都不上报", () => {
    const messages = [
      userMessage("msg_old_u", "旧的"),
      assistantMessage("msg_old_a", "旧回答", 500),
      userMessage("msg_new_u", "新的"),
      assistantMessage("msg_new_a", "新回答", 1500),
    ]
    const { turns } = buildTurns({ engineSessionId: "ses_1", enabledAt: 1000, messages })
    expect(turns.map((t) => t.assistantMessageId)).toEqual(["msg_new_a"])
  })

  test("游标之后的才上报(id 是时间升序型,直接比大小)", () => {
    const messages = [
      userMessage("msg_0000000000010000000000", "一"),
      assistantMessage("msg_0000000000020000000000", "壹", 2000),
      userMessage("msg_0000000000030000000000", "二"),
      assistantMessage("msg_0000000000040000000000", "贰", 3000),
    ]
    const { turns } = buildTurns({ ...base, messages, after: "msg_0000000000020000000000" })
    expect(turns.map((t) => t.assistantMessageId)).toEqual(["msg_0000000000040000000000"])
  })

  test("BYOK 与自定义 provider 照样上报;billing_path 由 provider_id 派生", () => {
    const byokUser: EngineMessage = {
      info: { id: "msg_bu", role: "user", time: { created: 1 }, model: { providerID: "anthropic-byok", modelID: "claude" } },
      parts: [{ type: "text", text: "自带密钥" }],
    }
    const byokAssistant = assistantMessage("msg_ba", "收到", 2000, { providerID: "anthropic-byok", modelID: "claude" })
    const { turns } = buildTurns({ ...base, messages: [byokUser, byokAssistant] })
    expect(turns).toHaveLength(1)
    expect(turns[0]?.body.messages[1]?.provider_id).toBe("anthropic-byok")
    expect(billingPathFor("alpha")).toBe("platform")
    expect(billingPathFor("anthropic-byok")).toBe("byok")
    expect(billingPathFor("my-own-endpoint")).toBe("custom")
  })
})

describe("REQ-160 #1324 —— 附件", () => {
  test("data URL 附件:按位置声明 metadata,哈希由客户端算、字节与元数据同序", () => {
    const withFile: EngineMessage = {
      info: { id: "msg_fu", role: "user", time: { created: 1 }, model: { providerID: "alpha", modelID: "gpt-5" } },
      parts: [
        { type: "text", text: "看这张图" },
        { type: "file", mime: "image/png", filename: "shot.png", url: PNG_DATA_URL },
      ],
    }
    const { turns } = buildTurns({ ...base, messages: [withFile, assistantMessage("msg_fa", "看到了", 2000)] })
    expect(turns[0]?.body.attachments).toEqual([
      {
        message_index: 0,
        kind: "image",
        mime: "image/png",
        byte_size: PNG.byteLength,
        content_hash: PNG_SHA256,
        filename: "shot.png",
      },
    ])
    expect(turns[0]?.attachmentBytes).toHaveLength(1)
    expect(Buffer.from(turns[0]!.attachmentBytes[0]!).toString("hex")).toBe(PNG.toString("hex"))
  })

  test("`@` 引用的项目文件不是附件(url 不是 data URL),白名单外的 mime 丢掉但整轮照发", () => {
    const withRefs: EngineMessage = {
      info: { id: "msg_ru", role: "user", time: { created: 1 }, model: { providerID: "alpha", modelID: "gpt-5" } },
      parts: [
        { type: "text", text: "看这些" },
        { type: "file", mime: "text/plain", filename: "a.ts", url: "file:///repo/a.ts" },
        { type: "file", mime: "application/zip", filename: "x.zip", url: "data:application/zip;base64,UEsDBA==" },
      ],
    }
    const { turns, skipped } = buildTurns({ ...base, messages: [withRefs, assistantMessage("msg_ra", "好", 2000)] })
    expect(turns).toHaveLength(1)
    expect(turns[0]?.body.attachments).toEqual([])
    expect(skipped.some((s) => s.reason.includes("application/zip"))).toBe(true)
  })

  test("decodeDataUrl 只认 base64 data URL", () => {
    expect(decodeDataUrl(PNG_DATA_URL)?.mime).toBe("image/png")
    expect(decodeDataUrl("https://example.com/a.png")).toBeNull()
    expect(decodeDataUrl("data:image/png,notbase64")).toBeNull()
    expect(decodeDataUrl(undefined)).toBeNull()
  })

  test("超过 8 个附件时多出来的丢掉(服务端第 9 个一律 413 太多,那是终态)", () => {
    const parts = [{ type: "text", text: "一堆图" } as Record<string, unknown>]
    for (let i = 0; i < 10; i++) parts.push({ type: "file", mime: "image/png", filename: `f${i}.png`, url: PNG_DATA_URL })
    const many: EngineMessage = {
      info: { id: "msg_mu2", role: "user", time: { created: 1 }, model: { providerID: "alpha", modelID: "gpt-5" } },
      parts,
    }
    const { turns, skipped } = buildTurns({ ...base, messages: [many, assistantMessage("msg_ma2", "好", 2000)] })
    expect(turns[0]?.body.attachments).toHaveLength(8)
    expect(turns[0]?.attachmentBytes).toHaveLength(8)
    expect(skipped.filter((s) => s.reason.includes("over 8")).length).toBe(2)
  })
})
