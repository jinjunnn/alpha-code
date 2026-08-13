// REQ-125 C6 — alpha 时间线卡片全集(呈现层)。
//
// 形态权威 = docs/design/current/conversation-timeline/design.html ②③④⑥ 节帧:
// 通用工具卡四态(运行扫线/呼吸)、各工具分支体、task v2(agent 色点+环形+打开子会话)、
// 回合级错误卡 / 工具级错误态 / 重试卡、「已探索」折叠组、媒体预览行、产物链接行。
// 数据全部经 store proxy 反应式读取(行对象引用稳定);内容一律纯文本节点(I3),
// 输出体有界(I7,tool-card-model 的双帽);CSS 只用 --a-* 令牌(I5)。
// 未知工具 fail-closed:有界纯文本通用卡。
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { t } from "../../../i18n"
import { routeArtifact } from "../../artifact-workbench/renderers/registry"
import type { TimelineMediaSource, TimelineRow } from "../timeline-model"
import {
  basenameOf,
  bashDescriptionOf,
  cappedItem,
  contextGroupSummaryOf,
  contextRowOf,
  diagnosticsOf,
  dirnameOf,
  mediaLabelOf,
  mediaThumbable,
  OPEN_DEFAULT_MAX_CHARS,
  openTargetOf,
  taskCardInfoOf,
  toolCardBodyOf,
  toolCardHeadOf,
  toolDevDetailsOf,
  type ToolCardBody,
  type ToolCardHead,
  type ToolSourceCategory,
} from "./tool-card-model"
import { diffViewOf } from "./tool-diff"
import { useTimelineIntents } from "./timeline-intents"
import "./cards.css"

// ── 图标(design.html 帧内路径的本地内联版) ─────────────────────────────────
function icons(kind: string): JSX.Element {
  switch (kind) {
    case "read":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      )
    case "list":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      )
    case "glob":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 7l2-3h5l2 3h7v11H3z" />
          <path d="M8 13h8" />
        </svg>
      )
    case "grep":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
      )
    case "webfetch":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </svg>
      )
    case "websearch":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
        </svg>
      )
    case "bash":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 17l6-6-6-6M12 19h8" />
        </svg>
      )
    case "edit":
    case "apply_patch":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      )
    case "write":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <path d="M14 3v6h6" />
        </svg>
      )
    case "skill":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" />
        </svg>
      )
    case "task":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      )
    case "cloud":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M17.5 19a4.5 4.5 0 0 0 .8-8.94 6 6 0 0 0-11.7 1.4A3.75 3.75 0 0 0 7 19z" />
        </svg>
      )
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7l8-4 8 4-8 4z" />
          <path d="M4 7v10l8 4 8-4V7" />
          <path d="M12 11v10" />
        </svg>
      )
  }
}

function chevron() {
  return (
    <svg class="a-tc-chev" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

// ── 来源分类标签(#879:metadata-only 降级卡的主标题;视觉形态归 #587) ──────
const SOURCE_KEYS: Record<ToolSourceCategory, string> = {
  builtin: "alpha.timeline.sourceBuiltin",
  host: "alpha.timeline.sourceHost",
  "alpha-cloud": "alpha.timeline.sourceAlphaCloud",
  mcp: "alpha.timeline.sourceMcp",
  plugin: "alpha.timeline.sourcePlugin",
  unknown: "alpha.timeline.sourceUnknown",
}

// ── #587 来源徽标(主层级;只读 head.category = 持久化 identity+authority 投影)──
const SOURCE_BADGE_KEYS: Record<ToolSourceCategory, string> = {
  builtin: "alpha.timeline.srcBuiltin",
  host: "alpha.timeline.srcHost",
  "alpha-cloud": "alpha.timeline.srcCloud",
  mcp: "alpha.timeline.srcMcp",
  plugin: "alpha.timeline.srcPlugin",
  unknown: "alpha.timeline.srcUnknown",
}

function SourceBadge(props: { category: ToolSourceCategory }) {
  return (
    <span class="a-tc-srcbadge" data-alpha-source-badge data-category={props.category}>
      {t(SOURCE_BADGE_KEYS[props.category] as Parameters<typeof t>[0])}
    </span>
  )
}

// #587 安全通用卡的确定隐藏理由(AC2;静态文案,不携带任何调用数据)。
const HIDDEN_REASON_KEYS = {
  "no-snapshot": "alpha.timeline.hiddenNoSnapshot",
  "no-rule": "alpha.timeline.hiddenNoRule",
} as const

// ── 状态徽标 ────────────────────────────────────────────────────────────────
function StatusChip(props: { head: ToolCardHead }) {
  const label = () => {
    const head = props.head
    if (head.status === "pending") return t("alpha.timeline.toolPending")
    if (head.status === "running") return t("alpha.timeline.toolRunning")
    if (head.status === "error") return t("alpha.timeline.toolError")
    if (head.kind === "bash" && head.exit !== undefined) return t("alpha.timeline.exit", { code: head.exit })
    if (head.kind === "skill") return t("alpha.timeline.skillLoaded")
    if (head.count) {
      if (head.count.unit === "matches") return t("alpha.timeline.countMatches", { count: head.count.value })
      if (head.count.unit === "items") return t("alpha.timeline.countItems", { count: head.count.value })
      if (head.count.unit === "results") return t("alpha.timeline.countResults", { count: head.count.value })
      return t("alpha.timeline.countFiles", { count: head.count.value })
    }
    return t("alpha.timeline.toolCompleted")
  }
  const tone = () => {
    const head = props.head
    if (head.status === "running") return "running"
    if (head.status === "error") return "error"
    if (head.status === "pending") return "muted"
    if (head.kind === "bash" && head.exit !== undefined) return head.exit === 0 ? "ok" : "error"
    if (head.kind === "skill") return "ok"
    return "muted"
  }
  return (
    <span class="a-tc-status" data-tone={tone()}>
      <Show when={props.head.status === "running"}>
        <span class="a-tc-spin" aria-hidden="true" />
      </Show>
      {label()}
    </span>
  )
}

function StatBadge(props: { stat: { additions: number; deletions: number } }) {
  return (
    <span class="a-tc-stat">
      <Show when={props.stat.additions > 0}>
        <span class="a-tc-stat-add">+{props.stat.additions}</span>
      </Show>
      <Show when={props.stat.deletions > 0}>
        <span class="a-tc-stat-del">−{props.stat.deletions}</span>
      </Show>
    </span>
  )
}

// ── 输出体分支 ──────────────────────────────────────────────────────────────
function TruncatedNote() {
  return <div class="a-tc-truncated">{t("alpha.timeline.truncated")}</div>
}

function CardBody(props: { head: ToolCardHead; body: ToolCardBody }) {
  const term = () => (props.body.type === "term" ? props.body : undefined)
  const text = () => (props.body.type === "text" ? props.body : undefined)
  const files = () => (props.body.type === "files" ? props.body : undefined)
  const dir = () => (props.body.type === "dir" ? props.body : undefined)
  const grep = () => (props.body.type === "grep" ? props.body : undefined)
  const links = () => (props.body.type === "links" ? props.body : undefined)
  const diff = () => (props.body.type === "diff" ? props.body : undefined)
  const write = () => (props.body.type === "write" ? props.body : undefined)
  const patch = () => (props.body.type === "patch" ? props.body : undefined)
  return (
    <>
      <Show when={term()}>
        {(body) => (
          <div class="a-tc-term" data-streaming={body().streaming ? "true" : undefined}>
            <Show when={props.head.target}>
              <span class="a-tc-pmt">$ </span>
              {props.head.target}
              {"\n"}
            </Show>
            {body().output}
            <Show when={body().streaming}>
              <span class="a-tc-cursor" aria-hidden="true" />
            </Show>
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
      <Show when={text()}>
        {(body) => (
          <div class="a-tc-out">
            {body().text}
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
      <Show when={files()}>
        {(body) => (
          <div class="a-tc-files">
            <For each={body().files}>
              {(file) => (
                <div class="a-tc-file-row">
                  <Show
                    when={body().badge}
                    fallback={
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                        <path d="M14 3v6h6" />
                      </svg>
                    }
                  >
                    <FileBadge badge={body().badge!} />
                  </Show>
                  <span class="a-tc-file-dir">{dirnameOf(file)}</span>
                  <span class="a-tc-file-name">{basenameOf(file)}</span>
                </div>
              )}
            </For>
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
      <Show when={dir()}>
        {(body) => (
          <div class="a-tc-dir" data-alpha-dir-grid>
            <div class="a-tc-dirgrid">
              <For each={body().entries}>
                {(entry) => (
                  <span class="a-tc-dir-item" data-entry={entry.dir ? "dir" : "file"}>
                    <Show
                      when={entry.dir}
                      fallback={
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                          <path d="M14 3v6h6" />
                        </svg>
                      }
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 7l2-3h5l2 3h7v11H3z" />
                      </svg>
                    </Show>
                    {entry.name}
                  </span>
                )}
              </For>
            </div>
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
            {/* #583:footer 计数与头部(tool-card-model 的 list 分支)同一条规则 ——
                截断集的条数是**帽住的条数**,不是目录总量,直出即低报。诚实缺席,
                缺席提示由上方 TruncatedNote 承担;不截断才复述计数。 */}
            <Show when={!body().truncated}>
              <div class="a-tc-dircount">{t("alpha.timeline.countItems", { count: body().entries.length })}</div>
            </Show>
          </div>
        )}
      </Show>
      <Show when={grep()}>
        {(body) => (
          <div class="a-tc-grep" data-alpha-grep-body>
            <For each={body().rows}>
              {(row) => (
                <Show
                  when={row.kind === "match" ? row : undefined}
                  fallback={<div class="a-tc-grep-file">{row.kind === "file" ? row.path : ""}</div>}
                >
                  {(matchRow) => (
                    <div class="a-tc-grep-row">
                      <Show when={matchRow().line !== undefined}>
                        <span class="a-tc-grep-ln">:{matchRow().line}</span>
                      </Show>
                      <span class="a-tc-grep-text">
                        <For each={matchRow().spans}>
                          {(span) => (
                            <Show when={span.hit} fallback={span.text}>
                              <mark class="a-tc-grep-hit">{span.text}</mark>
                            </Show>
                          )}
                        </For>
                      </span>
                    </div>
                  )}
                </Show>
              )}
            </For>
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
      {/* #586 富链接列表(G17):字母徽(不是 favicon,不发远端请求)+ 标题 + 域名。
          title 只来自结构化 allowlist(已过 redactor);缺席时降回清洗后的 href。 */}
      <Show when={links()}>
        {(body) => (
          <div class="a-tc-links">
            <For each={body().links}>
              {(link) => (
                <a class="a-tc-wr" href={link.href} target="_blank" rel="noopener noreferrer">
                  <span class="a-tc-fav" aria-hidden="true">
                    {link.letter}
                  </span>
                  <span class="a-tc-wt" data-fallback={link.title === undefined ? "href" : undefined}>
                    {link.title ?? link.href}
                  </span>
                  <span class="a-tc-wu">{link.host}</span>
                </a>
              )}
            </For>
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
      <Show when={diff()}>{(body) => <DiffBody patch={body().patch} />}</Show>
      <Show when={write()}>
        {(body) => (
          <div class="a-tc-write">
            <Show when={body().path}>
              <div class="a-tc-file-row">
                <FileBadge badge="write" />
                <span class="a-tc-file-dir">{dirnameOf(body().path!)}</span>
                <span class="a-tc-file-name">{basenameOf(body().path!)}</span>
              </div>
            </Show>
            <div class="a-tc-out">
              {body().preview.join("\n")}
              <div class="a-tc-write-note">{t("alpha.timeline.writeLines", { count: body().totalLines })}</div>
              <Show when={body().approx}>
                <TruncatedNote />
              </Show>
            </div>
          </div>
        )}
      </Show>
      <Show when={patch()}>
        {(body) => (
          <div class="a-tc-patch">
            <For each={body().files}>
              {(file) => (
                <div class="a-tc-patch-row">
                  <FileBadge badge={file.badge} />
                  <span class="a-tc-file-dir">{dirnameOf(file.path)}</span>
                  <span class="a-tc-file-name">{basenameOf(file.path)}</span>
                  <StatBadge stat={{ additions: file.additions, deletions: file.deletions }} />
                </div>
              )}
            </For>
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
    </>
  )
}

// ── 工具级错误卡(#590,design §③ .errcard 帧) ─────────────────────────────
// 标题行 = 固定标题「工具执行失败」+ 复制,由 TimelineToolCard **常驻渲染**
// (R1 Major:超帽错误默认收起时也必须能看到标题、能复制,与设计稿的常驻卡片头
// 同口径);受开合控制的只有 mono 错误正文。error 体不走 CardBody 分支。
// 复制:剪贴板通道缺席即不渲染按钮(fail-closed),与回合末脚注同一口径。
//
// 「模型网关错误」分类:**登记不做**(R3 Blocker 裁决)。引擎侧没有 typed gateway
// provenance,而词面判据在 task 上被证明既无真阳性也有可达误报:
// ① 子会话的 provider 错误由 processor 写进 assistant error 并返回 stop
//   (packages/opencode/src/session/processor.ts:599),而 TaskTool.runTask 只取
//   最后一段 text、不检查 result.info.error(packages/opencode/src/tool/task.ts:200)
//   —— 后台任务照记 completed,模型网关失败根本到不了 task 工具错误卡;
// ② TaskTool 会把模型可控的 subagent_type 原样写进 unknown-agent 错误文本
//   (packages/opencode/src/tool/task.ts:131),"Unknown agent type: gateway" 这类
//   词面即成可达误报;
// ③ ToolPart.tool === "task" 也非可信来源:插件可注册同名自定义工具覆盖内建
//   (registry.ts:251 内建后接自定义、tools.ts:92 按 ID 后写覆盖)。
// 将来上游给 ToolPart 补了结构化的网关失败字段(typed provenance)后,才允许
// 基于**该 typed 字段**恢复分类标题;词面推断在任何情况下都不得回来。
// 代码副标(状态码/原因短语)同理不做:数据面没有状态字段,反推是把推测当事实。
//
// 重试 / 换模型:**登记跳过** —— 工具重跑没有 typed 通道,模型选择器的开合是
// composer 的私有状态(alpha-composer 的 useChip,无对外开启入口)。没有现成
// 会话命令入口就不接,不为它们新建链路、也不放只会假装可用的按钮。
function ToolErrorHead(props: { message: string }) {
  const canCopy = typeof navigator !== "undefined" && !!navigator.clipboard
  const copy = () => {
    try {
      void navigator.clipboard.writeText(props.message).catch(() => {})
    } catch {
      // 剪贴板拒绝(权限/环境)→ 静默;不阻断时间线。
    }
  }
  return (
    <div class="a-tc-err-head">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M4.9 4.9l14.2 14.2" />
      </svg>
      <b>{t("alpha.timeline.toolErrorGeneric")}</b>
      <Show when={canCopy}>
        <button
          type="button"
          class="a-tc-err-copy"
          data-alpha-tool-error-copy
          title={t("alpha.timeline.copyError")}
          aria-label={t("alpha.timeline.copyError")}
          onClick={copy}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        </button>
      </Show>
    </div>
  )
}

const BADGE_KEYS = {
  add: "alpha.timeline.badgeAdd",
  modify: "alpha.timeline.badgeModify",
  delete: "alpha.timeline.badgeDelete",
  move: "alpha.timeline.badgeMove",
  read: "alpha.timeline.badgeRead",
  write: "alpha.timeline.badgeWrite",
} as const

/** 文件行徽章六态(读取/写入/移动/新增/修改/删除)。 */
export function FileBadge(props: { badge: keyof typeof BADGE_KEYS }) {
  return (
    <span class="a-tc-badge" data-badge={props.badge}>
      {t(BADGE_KEYS[props.badge])}
    </span>
  )
}

function DiffBody(props: { patch: string }) {
  const view = createMemo(() => diffViewOf(props.patch))
  return (
    <Show when={!view().unavailable} fallback={<div class="a-tc-out">{t("alpha.timeline.diffUnavailable")}</div>}>
      <div class="a-tc-diff">
        <For each={view().rows}>
          {(row) => (
            <Show when={row.kind !== "gap"} fallback={<div class="a-tc-diff-gap" aria-hidden="true" />}>
              <div class="a-tc-diff-line" data-kind={row.kind}>
                <span class="a-tc-diff-gut">{row.kind === "add" ? row.newLine : row.oldLine}</span>
                <span class="a-tc-diff-sign">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
                <span class="a-tc-diff-text">{row.text}</span>
              </div>
            </Show>
          )}
        </For>
        <Show when={view().truncated}>
          <TruncatedNote />
        </Show>
      </div>
    </Show>
  )
}

// ── 通用工具卡(四态外壳 + 分派) ───────────────────────────────────────────
export function TimelineToolCard(props: { part: ToolPart }) {
  const head = createMemo(() => toolCardHeadOf(props.part))
  const body = createMemo(() => toolCardBodyOf(props.part))
  // hidden 体(AC5)不算可展开体:确定标记常驻显示,没有 raw 查看旁路。
  const hasBody = () => body().type !== "none" && body().type !== "hidden"
  // 默认展开:终端流(bash)/错误体,且**原始**体量在帽内 —— 被截断过(truncated)
  // 即视为超帽收起,不用截后长度比(I7:大输出体默认收起,防多卡累积常驻 DOM);
  // 其余折叠。用户显式选择永远优先。
  const [chosen, setChosen] = createSignal<boolean>()
  const defaultOpen = () => {
    const value = body()
    if (value.type === "term") return !value.truncated && value.output.length <= OPEN_DEFAULT_MAX_CHARS
    if (value.type === "error") return !value.truncated && value.message.length <= OPEN_DEFAULT_MAX_CHARS
    return false
  }
  const open = () => chosen() ?? defaultOpen()
  // #879:命令说明副行经模型层 identity 分派 + redactor(不再直读 input)。
  const description = createMemo(() => bashDescriptionOf(props.part))
  const task = createMemo(() => (head().kind === "task" ? taskCardInfoOf(props.part) : undefined))
  const intents = useTimelineIntents()
  // T8「在面板打开」pill:write/edit 的文件目标 + openFile intent 双在场才渲染(fail-closed)。
  const openPath = createMemo(() => openTargetOf(props.part))
  // T19 诊断行:edit/write 完成态的本文件 ERROR 级诊断(有界;缺席零渲染)。
  const diag = createMemo(() => diagnosticsOf(props.part))
  // #587 开发者详情:快照在场才有(无快照历史行没有可信 identity 可陈列)。
  const dev = createMemo(() => toolDevDetailsOf(props.part))
  // error 体单独出 CardBody:标题行 + 复制常驻,open() 只控 mono 正文(R1 Major)。
  const errorBody = () => {
    const value = body()
    return value.type === "error" ? value : undefined
  }

  const headInner = () => (
    <>
      <span class="a-tc-ico" data-kind={head().kind} aria-hidden="true">
        {icons(head().kind)}
      </span>
      <span class="a-tc-title">
        {/* #879 metadata-only 降级卡:来源分类 + 被动净化名称(+ origin),无参数。 */}
        <Show
          when={!head().metadataOnly}
          fallback={
            <>
              <b>{t(SOURCE_KEYS[head().category] as Parameters<typeof t>[0])}</b>
              <span class="a-tc-name">{head().toolName}</span>
              <Show when={head().origin}>
                <span class="a-tc-detail">{head().origin}</span>
              </Show>
            </>
          }
        >
          <Show when={head().titleKey} fallback={<b class="a-tc-name">{head().toolName}</b>}>
            <b>{t(head().titleKey! as Parameters<typeof t>[0])}</b>
          </Show>
          <Show when={head().target}>
            <span class="a-tc-target">{head().target}</span>
          </Show>
          {/* AC5:目标存在但 redactor 失败 → 确定的「详情已隐藏」,无 raw 旁路。 */}
          <Show when={head().targetHidden}>
            <span class="a-tc-detail" data-alpha-details-hidden>
              {t("alpha.timeline.detailsHidden")}
            </span>
          </Show>
          <Show when={head().detail}>
            <span class="a-tc-detail">{head().detail}</span>
          </Show>
          {/* #934 Minor(AC5 标记半边):次级细节(如 grep include)脱敏失败也出确定标记。 */}
          <Show when={head().detailHidden}>
            <span class="a-tc-detail" data-alpha-details-hidden>
              {t("alpha.timeline.detailsHidden")}
            </span>
          </Show>
          <Show when={task()?.agent}>
            <span class="a-tc-agent">
              <i aria-hidden="true" />
              {task()!.agent}
            </span>
          </Show>
          {/* #934 Minor:task agent 名脱敏失败 → 确定标记,chip 不凭空消失。 */}
          <Show when={task()?.agentHidden}>
            <span class="a-tc-agent" data-alpha-details-hidden>
              <i aria-hidden="true" />
              {t("alpha.timeline.detailsHidden")}
            </span>
          </Show>
        </Show>
      </span>
      <Show when={head().stat}>{(stat) => <StatBadge stat={stat()} />}</Show>
      <Show when={task() && head().status === "running"}>
        <span class="a-tc-ring" aria-hidden="true" />
      </Show>
      {/* #587 来源徽标:全来源常驻主层级,只读持久化快照的投影(T3/T7)。 */}
      <SourceBadge category={head().category} />
      <StatusChip head={head()} />
    </>
  )

  return (
    <section
      class="a-tl-row a-tc"
      data-alpha-timeline-row="tool"
      data-alpha-tool-card
      data-kind={head().kind}
      data-category={head().category}
      data-tool={cappedItem(props.part.tool)}
      data-status={head().status}
      data-open={hasBody() && open() ? "true" : undefined}
    >
      <div class="a-tc-headwrap">
        <Show when={hasBody()} fallback={<div class="a-tc-head">{headInner()}</div>}>
          <button type="button" class="a-tc-head" aria-expanded={open()} onClick={() => setChosen(!open())}>
            {headInner()}
          </button>
        </Show>
        <Show when={openPath() && intents.openFile}>
          <button
            type="button"
            class="a-tc-openp"
            data-alpha-open-in-panel
            onClick={() => intents.openFile!({ path: openPath()! })}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 3h6v6M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
            {t("alpha.timeline.openInPanel")}
          </button>
        </Show>
        <Show when={hasBody()}>
          {/* 装饰性开合指示;点击等效头部按钮(键盘路径在头部按钮上)。 */}
          <span class="a-tc-chevhit" aria-hidden="true" onClick={() => setChosen(!open())}>
            {chevron()}
          </span>
        </Show>
      </div>
      <Show when={task()?.childSessionID && intents.openSession}>
        <div class="a-tc-actions">
          <button type="button" class="a-tc-open" onClick={() => intents.openSession!(task()!.childSessionID!)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 3h6v6M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
            {t("alpha.timeline.openSubtask")}
          </button>
        </div>
      </Show>
      <Show when={description()?.value}>
        <div class="a-tc-subdesc">{description()!.value}</div>
      </Show>
      {/* #934 Minor:bash 命令说明脱敏失败 → 确定标记,副行不静默消失(AC5)。 */}
      <Show when={description()?.hidden}>
        <div class="a-tc-subdesc" data-alpha-details-hidden>
          {t("alpha.timeline.detailsHidden")}
        </div>
      </Show>
      {/* #587 安全通用卡(AC2):metadata-only 降级卡陈述确定的隐藏理由;
          纯静态文案,不携带参数/错误/输出,也没有任何展开入口。 */}
      <Show when={head().metadataOnly && head().hiddenReason}>
        {(reason) => (
          <div class="a-tc-body">
            <div class="a-tc-safe" data-alpha-safe-card>
              <b>{head().status === "error" ? t("alpha.timeline.safeHiddenError") : t("alpha.timeline.safeHidden")}</b>
              <span>{t(HIDDEN_REASON_KEYS[reason()] as Parameters<typeof t>[0])}</span>
            </div>
          </div>
        )}
      </Show>
      {/* AC5:redactor 失败的整字段 → 常驻的确定「详情已隐藏」,无展开、无 raw 旁路。 */}
      <Show when={body().type === "hidden"}>
        <div class="a-tc-body">
          <div class="a-tc-out" data-alpha-details-hidden>
            {t("alpha.timeline.detailsHidden")}
          </div>
        </div>
      </Show>
      <Show
        when={errorBody()}
        fallback={
          <Show when={hasBody() && open()}>
            <div class="a-tc-body">
              <CardBody head={head()} body={body()} />
            </div>
          </Show>
        }
      >
        {(err) => (
          <div class="a-tc-body">
            <div class="a-tc-err" role="alert">
              <ToolErrorHead message={err().message} />
              <Show when={open()}>
                <div class="a-tc-error-body">
                  {err().message}
                  <Show when={err().truncated}>
                    <TruncatedNote />
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        )}
      </Show>
      <Show when={diag().rows.length > 0}>
        <div class="a-tc-diag" data-alpha-tool-diagnostics>
          <For each={diag().rows}>
            {(row) => (
              <div class="a-tc-diag-row">
                <span class="a-tc-diag-lvl">{t("alpha.timeline.diagError")}</span>
                <span class="a-tc-diag-loc">{row.line === undefined ? row.file : `${row.file}:${row.line}`}</span>
                <span class="a-tc-diag-msg">{row.message}</span>
              </div>
            )}
          </For>
          <Show when={diag().truncated}>
            <TruncatedNote />
          </Show>
        </div>
      </Show>
      {/* #587 开发者详情(AC3/AC4):technical-id / canonical identity / authority
          证明只在这里;默认折叠(原生 details 无 open 属性),纯文本、已限长,
          不参与任何授权/策略/计费判定(cards-contract 的 import 面棘轮钉着)。 */}
      <Show when={dev()}>
        {(info) => (
          <details class="a-tc-dev" data-alpha-dev-details>
            <summary>{t("alpha.timeline.devDetails")}</summary>
            <div class="a-tc-dev-body">
              <div>{info().canonical}</div>
              <div>technical-id: {info().technicalId}</div>
              <div>authority: {info().authority}</div>
            </div>
          </details>
        )}
      </Show>
    </section>
  )
}

// ── 本回合改动汇总(S2,design §④ .diffsum 帧) ────────────────────────────
export function TurnDiffSummaryRow(props: { row: Extract<TimelineRow, { kind: "diffsum" }> }) {
  const intents = useTimelineIntents()
  const [open, setOpen] = createSignal(false)
  const fileInner = (file: { file: string; additions: number; deletions: number }) => (
    <>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6" />
      </svg>
      <span class="a-tc-file-dir">{dirnameOf(file.file)}</span>
      <span class="a-tc-file-name">{basenameOf(file.file)}</span>
      <StatBadge stat={{ additions: file.additions, deletions: file.deletions }} />
    </>
  )
  return (
    <section class="a-tl-row a-diffsum" data-alpha-timeline-row="diffsum" data-open={open() ? "true" : undefined}>
      <button type="button" class="a-diffsum-head" aria-expanded={open()} onClick={() => setOpen((value) => !value)}>
        <span class="a-diffsum-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <circle cx="6" cy="6" r="2.4" />
            <circle cx="6" cy="18" r="2.4" />
            <circle cx="18" cy="9" r="2.4" />
            <path d="M6 8.4v7.2M18 11.4a6 6 0 0 1-6 6H8.4" />
          </svg>
        </span>
        <b>{t("alpha.timeline.turnDiffs", { count: props.row.files.length })}</b>
        <StatBadge stat={{ additions: props.row.additions, deletions: props.row.deletions }} />
        {chevron()}
      </button>
      <Show when={open()}>
        <div class="a-diffsum-body">
          <For each={props.row.files}>
            {(file) => (
              <Show when={intents.openFile} fallback={<div class="a-diffsum-row">{fileInner(file)}</div>}>
                <button
                  type="button"
                  class="a-diffsum-row"
                  aria-label={t("alpha.session.filesOpenInReview")}
                  onClick={() => intents.openFile!({ path: file.file })}
                >
                  {fileInner(file)}
                  <svg class="a-diffsum-go" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M15 3h6v6M10 14L21 3" />
                  </svg>
                </button>
              </Show>
            )}
          </For>
          <Show when={props.row.truncated}>
            <TruncatedNote />
          </Show>
        </div>
      </Show>
    </section>
  )
}

// ── 「已探索」折叠组 ────────────────────────────────────────────────────────
export function ContextToolGroupCard(props: { parts: ToolPart[] }) {
  const [open, setOpen] = createSignal(false)
  const summary = createMemo(() => contextGroupSummaryOf(props.parts))
  const summaryText = () => {
    const value = summary()
    const segments: string[] = []
    if (value.reads > 0) segments.push(t("alpha.timeline.exploreReads", { count: value.reads }))
    if (value.searches > 0) segments.push(t("alpha.timeline.exploreSearches", { count: value.searches }))
    if (value.lists > 0) segments.push(t("alpha.timeline.exploreLists", { count: value.lists }))
    return segments.join(" · ")
  }
  return (
    <section class="a-tl-row a-explore" data-alpha-timeline-row="toolgroup" data-open={open() ? "true" : undefined}>
      <button type="button" class="a-explore-head" aria-expanded={open()} onClick={() => setOpen((value) => !value)}>
        <span class="a-explore-ico" aria-hidden="true">
          {icons("read")}
        </span>
        <span class="a-explore-label">{t("alpha.timeline.explored")}</span>
        <span class="a-explore-count">· {summaryText()}</span>
        {chevron()}
      </button>
      <Show when={open()}>
        <div class="a-explore-body">
          <For each={props.parts}>
            {(part) => {
              const row = () => contextRowOf(part)
              return (
                <div class="a-explore-row" data-tool={cappedItem(part.tool)}>
                  {/* #879:图标与动词按 identity 分派的 kind,不再按裸别名。 */}
                  <span class="a-explore-ri" data-kind={row().kind} aria-hidden="true">
                    {icons(row().kind)}
                  </span>
                  <span class="a-explore-verb" data-kind={row().kind}>
                    <Show when={row().titleKey} fallback={row().tool}>
                      {t(row().titleKey! as Parameters<typeof t>[0])}
                    </Show>
                  </span>
                  <Show when={row().target}>
                    <span class="a-explore-target">{row().target}</span>
                  </Show>
                  {/* #934 Minor:折叠组行的目标/include 脱敏失败 → 确定标记,不凭空消失(AC5)。 */}
                  <Show when={row().targetHidden}>
                    <span class="a-explore-arg" data-alpha-details-hidden>
                      {t("alpha.timeline.detailsHidden")}
                    </span>
                  </Show>
                  <Show when={row().args.length > 0}>
                    <span class="a-explore-arg">{row().args.join(" ")}</span>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </section>
  )
}

// ── 回合级错误卡(全宽,纯文本,无动作) ────────────────────────────────────
export function TurnErrorCard(props: { row: Extract<TimelineRow, { kind: "turnError" }> }) {
  return (
    <div class="a-tl-row a-turn-err" data-alpha-timeline-row="turn-error" role="alert">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" />
      </svg>
      <div class="a-turn-err-content">
        <b>{t("alpha.timeline.turnErrorTitle")}</b>
        <Show when={props.row.message}>
          <p>{props.row.message}</p>
        </Show>
        <span class="a-turn-err-code">{props.row.name}</span>
      </div>
    </div>
  )
}

// ── 重试卡 ──────────────────────────────────────────────────────────────────
export function RetryCard(props: { row: Extract<TimelineRow, { kind: "retry" }> }) {
  return (
    <div class="a-tl-row a-retry" data-alpha-timeline-row="retry" role="status">
      <span class="a-retry-spin" aria-hidden="true" />
      <span>{t("alpha.timeline.retrying", { attempt: props.row.attempt })}</span>
      <Show when={props.row.message}>
        <span class="a-retry-message">{props.row.message}</span>
      </Show>
    </div>
  )
}

// ── 助手侧媒体预览行(数据源 = 工具附件通道 / 顶层 file part 的快照) ────────
export function TimelineMediaRow(props: { media: TimelineMediaSource }) {
  const intents = useTimelineIntents()
  const inner = () => (
    <>
      <span class="a-media-thumb" aria-hidden="true">
        <Show
          when={mediaThumbable(props.media.url)}
          fallback={
            <svg viewBox="0 0 24 24">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="8.5" cy="10" r="1.6" />
              <path d="M21 16l-5-5L6 20" />
            </svg>
          }
        >
          <img src={props.media.url} alt="" loading="lazy" />
        </Show>
      </span>
      <span class="a-media-name">
        <b>{props.media.name}</b>
        <small>{mediaLabelOf(props.media.mime, props.media.name)}</small>
      </span>
    </>
  )
  return (
    <div class="a-tl-row a-media" data-alpha-timeline-row="media">
      <Show when={intents.focusArtifact} fallback={<div class="a-media-row">{inner()}</div>}>
        <button
          type="button"
          class="a-media-row"
          onClick={() =>
            intents.focusArtifact!({ name: props.media.name, partID: props.media.partID, mime: props.media.mime })
          }
        >
          {inner()}
        </button>
      </Show>
    </div>
  )
}

// ── 产物链接行(§⑥ 已批形态) ──────────────────────────────────────────────
export function TimelineArtifactRows(props: { row: Extract<TimelineRow, { kind: "artifacts" }> }) {
  const intents = useTimelineIntents()
  return (
    <div
      class="a-tl-row a-artrows"
      data-alpha-timeline-row="artifacts"
      role="list"
      aria-label={t("alpha.timeline.artifactsLabel")}
    >
      <For each={props.row.links}>
        {(link) => (
          <button
            type="button"
            class="a-artrow"
            role="listitem"
            data-previewable={routeArtifact({ name: link.name }).rendererId !== "fallback" ? "true" : "false"}
            disabled={!intents.focusArtifact}
            onClick={() => intents.focusArtifact?.({ name: link.name, runId: link.runId })}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
              <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
            </svg>
            <span class="a-artrow-name">{link.name}</span>
          </button>
        )}
      </For>
    </div>
  )
}
