// dirgrid 取证种子:当前引擎已无 `list` 工具、read 渲染器不再渲染 output(见 30-p3-adapter.json
// readDom 取证)——dirgrid 装饰器的目标形态(tool-output 内 <entries> + "(N entries)")只能来自
// 历史 `list` 部件。这里向分支专属 dev DB(取证后清理)插入一条 legacy 形状的 list 轮次,
// 验证 dirgrid 装饰在 adapter/legacy 两模式下的一致性。ID 生成复刻 opencode/src/id/id.ts create()。
import { Database } from "bun:sqlite"
import { PROJ } from "./lib"

const DB = `${process.env.HOME}/.local/share/opencode/opencode-feat-181-req088-session-adapter.db`
const setup = JSON.parse(await Bun.file("../00-setup.json").text())
const SES = setup.sessionA as string

let lastTs = 0
let counter = 0
function createId(prefix: string, timestamp: number): string {
  if (timestamp !== lastTs) {
    lastTs = timestamp
    counter = 0
  }
  counter++
  let now = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter)
  const timeBytes = Buffer.alloc(6)
  for (let i = 0; i < 6; i++) timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let rand = ""
  for (const b of crypto.getRandomValues(new Uint8Array(14))) rand += chars[b % 62]
  return `${prefix}_${timeBytes.toString("hex")}${rand}`
}

const db = new Database(DB)
const T = Date.now()
const userId = createId("msg", T)
const asstId = createId("msg", T + 10)
const entries = [
  "alpha.md",
  "bravo.md",
  "charlie.md",
  "delta.md",
  "echo.md",
  "foxtrot.md",
  "golf.md",
  "hotel.md",
  "subfolder-one/",
  "subfolder-two/",
]
const listOutput = [
  `<path>${PROJ}/docs-dir</path>`,
  `<type>directory</type>`,
  `<entries>`,
  entries.join("\n"),
  `\n(${entries.length} entries)`,
  `</entries>`,
].join("\n")

const rows: Array<{ table: "message" | "part"; id: string; msg?: string; data: unknown; t: number }> = [
  {
    table: "message",
    id: userId,
    t: T,
    data: {
      role: "user",
      time: { created: T },
      agent: "build",
      model: { providerID: "scripted", modelID: "scripted-1" },
      summary: { diffs: [] },
    },
  },
  {
    table: "part",
    id: createId("prt", T + 1),
    msg: userId,
    t: T + 1,
    data: { type: "text", text: "查看目录清单(legacy list 部件 dirgrid 取证种子)" },
  },
  {
    table: "message",
    id: asstId,
    t: T + 10,
    data: {
      parentID: userId,
      role: "assistant",
      mode: "build",
      agent: "build",
      path: { cwd: PROJ, root: PROJ },
      cost: 0,
      tokens: { total: 10, input: 5, output: 5, reasoning: 0, cache: { write: 0, read: 0 } },
      modelID: "scripted-1",
      providerID: "scripted",
      time: { created: T + 10, completed: T + 20 },
      finish: "stop",
    },
  },
  {
    table: "part",
    id: createId("prt", T + 11),
    msg: asstId,
    t: T + 11,
    data: {
      type: "tool",
      tool: "list",
      callID: "call_req088_seed_list",
      state: {
        status: "completed",
        input: { path: `${PROJ}/docs-dir` },
        output: listOutput,
        title: `${PROJ}/docs-dir`,
        metadata: { preview: entries.slice(0, 5).join("\n"), truncated: false },
        time: { start: T + 11, end: T + 12 },
      },
    },
  },
  {
    table: "part",
    id: createId("prt", T + 13),
    msg: asstId,
    t: T + 13,
    data: { type: "text", text: "以上为目录清单(种子)。" },
  },
]

const insMsg = db.prepare(
  "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
)
const insPart = db.prepare(
  "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
)
for (const r of rows) {
  if (r.table === "message") insMsg.run(r.id, SES, r.t, r.t, JSON.stringify(r.data))
  else insPart.run(r.id, r.msg!, SES, r.t, r.t, JSON.stringify(r.data))
}
db.close()
console.log("seeded legacy list turn:", { userId, asstId, session: SES })
await Bun.write(
  "../35-dirgrid-seed.json",
  JSON.stringify({ userId, asstId, session: SES, listOutput }, null, 2),
)
