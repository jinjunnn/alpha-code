// attachment-reader-hooks — REQ-236 `#1553` AC3:给每个暂存附件追加读取指令(方案 §2.6「读取指令由 ext 写」)。
//
// composer 把 PDF / Word / Excel / PPT 存进会话实例目录的隐藏目录后,这条用户消息里只带一个 synthetic **空**文本 part,
// metadata 是 `codepuppy.attachment`(shared/attachment-path.ts 的冻结形状;空文本引擎不发给模型)。本钩子在 chat.message
// 识别它,紧跟着追加一个 synthetic 文本 part —— 这是模型唯一看到的附件文字,登记在 context-injection.ts(sink=attachment-block):
//   · 读取工具可用(或状态读不到)⇒ 叫模型调本机读取工具:工具 id = mcpEngineToolId(第一方 Office 服务名, 远端工具名)
//     (与 cloud-contract-hook 同一推导纪律),path = attachmentAbsolutePath(插件实例目录, metadata.path)—— renderer 判
//     「已读取」用的是同一个函数;
//   · 读取工具没装 / 停用 / 启动失败 ⇒ 叫模型如实告诉用户读不到以及原因。
// 宿主不自己调读取工具(插件 API 没有受支持的执行接缝,方案 §1.5),所以「读到没有」只由会话里的真实工具调用判定。
//
// 逐服务状态 = 引擎 `GET /mcp`(#1563 起不等全部服务)。围栏下 input.client 的 TCP 连不上自己,plugin.ts 优先走进程内引擎。
import path from "node:path"
import {
  ATTACHMENT_READ_TOOL,
  attachmentAbsolutePath,
  attachmentReaderServer,
  stagedAttachmentOf,
  type StagedAttachmentMeta,
} from "../../ui-mac/src/shared/attachment-path"
import { mcpEngineToolId } from "./cloud-websearch-kill"
import { ATTACHMENT_READ_ID, attachmentUnavailableId, renderTemplate, renderWrapper } from "./context-injection"

export type AttachmentReaderHookDeps = {
  /** 本插件实例的目录 = 引擎实例目录 = 本机读取工具的授权工作区。 */
  readonly directory: string
  /** 引擎 `GET /mcp`:hey-api 信封 `{ data }` 或裸 `Record<name, { status }>` 都认。 */
  readonly mcpStatus: () => Promise<unknown>
  readonly error?: (message: string) => void
}

type ChatMessageInput = { readonly sessionID: string }
type ChatMessageOutput = { readonly message: { readonly id?: string }; readonly parts: unknown[] }

/** 一条附件的指令文字。`services` 缺席 = 状态读不到:不替读取工具下「不可用」的结论,照常叫模型去读。 */
export function attachmentInstruction(meta: StagedAttachmentMeta, directory: string, services: Readonly<Record<string, unknown>> | undefined): string {
  const server = attachmentReaderServer(meta.reader)
  const status = services ? ((services[server] as { status?: unknown } | undefined)?.status ?? "absent") : "unknown"
  if (status === "absent" || status === "disabled")
    return renderTemplate(attachmentUnavailableId("missing"), { name: path.posix.basename(meta.path) })
  if (status === "failed" || status === "needs_auth" || status === "needs_client_registration")
    return renderTemplate(attachmentUnavailableId("failed"), { name: path.posix.basename(meta.path) })
  return renderWrapper(ATTACHMENT_READ_ID, {
    label: mcpEngineToolId(server, ATTACHMENT_READ_TOOL[meta.reader]),
    body: attachmentAbsolutePath(directory, meta.path),
  })
}

const stagedOf = (part: unknown): StagedAttachmentMeta | undefined => {
  const p = part as { type?: unknown; synthetic?: unknown; metadata?: unknown } | null
  return p && p.type === "text" && p.synthetic === true ? stagedAttachmentOf(p.metadata) : undefined
}

export function createAttachmentReaderHooks(deps: AttachmentReaderHookDeps) {
  return {
    /** 绝不抛(抛出会打死用户这条消息)。 */
    async chatMessage(input: ChatMessageInput, output: ChatMessageOutput): Promise<void> {
      try {
        const staged = output.parts.flatMap((part) => {
          const meta = stagedOf(part)
          return meta ? [{ part: part as { id?: string; messageID?: string }, meta }] : []
        })
        if (staged.length === 0) return
        let services: Record<string, unknown> | undefined
        try {
          const response = (await deps.mcpStatus()) as { data?: unknown; error?: unknown } | null
          const record = response && typeof response === "object" && ("data" in response || "error" in response) ? response.data : response
          if (record && typeof record === "object") services = record as Record<string, unknown>
        } catch (error) {
          deps.error?.(`[@alpha-code/ext] attachment reader: MCP status unavailable (${error instanceof Error ? error.message : String(error)})`)
        }
        for (const { part, meta } of staged) {
          output.parts.push({
            // 引擎按 id 排序读回 parts:后缀让指令紧跟它的附件记录(同 cloud-vision-hooks 的 `-vision`)。
            id: `${part.id}-read`,
            sessionID: input.sessionID,
            messageID: part.messageID ?? output.message?.id,
            type: "text",
            text: attachmentInstruction(meta, deps.directory, services),
            synthetic: true,
          })
        }
      } catch (error) {
        deps.error?.(`[@alpha-code/ext] attachment reader (chat.message) failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
