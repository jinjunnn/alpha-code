// REQ-125 C6 — alpha 时间线卡片全集(呈现层)。
//
// 形态权威 = docs/design/current/conversation-timeline/design.html ②③④⑥⑧ 节帧:
// 各工具分支体(`#1473` 起作为工作过程某一步的详情,不再常驻)、task(打开子会话)、
// 回合级错误卡 / 工具级错误态 / 重试卡、媒体预览行、产物链接行。
// 数据全部经 store proxy 反应式读取(行对象引用稳定);内容一律纯文本节点(I3),
// 输出体有界(I7,tool-card-model 的双帽);CSS 只用 --a-* 令牌(I5)。
// 未知工具 fail-closed:有界纯文本通用卡。
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { t } from "../../../i18n"
import { routeArtifact } from "../../artifact-workbench/renderers/registry"
import { CopyButton } from "../../CopyButton"
import type { TimelineMediaSource, TimelineRow } from "../timeline-model"
import {
  basenameOf,
  bashDescriptionOf,
  diagnosticsOf,
  dirnameOf,
  mediaLabelOf,
  mediaThumbable,
  openTargetOf,
  questionStepInfoOf,
  taskCardInfoOf,
  toolCardBodyOf,
  toolCardHeadOf,
  toolDevDetailsOf,
  toolStepSourceOf,
  type ToolCardBody,
  type ToolCardHead,
  type ToolStepSourceKind,
} from "./tool-card-model"
import { diffViewOf } from "./tool-diff"
import { useTimelineIntents } from "./timeline-intents"
import "./cards.css"

// ── 图标(design.html 帧内路径的本地内联版) ─────────────────────────────────
/** 工具类图标(identity 分派出的 kind;未知 / 降级 = 立方体)。工作过程步骤行复用。 */
export function toolIcon(kind: string): JSX.Element {
  return icons(kind)
}

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

/**
 * `#1475` AC5 非我方来源的行内图标:插头 = 第三方连接(MCP),拼图 = 插件,问号 = 来源不明。
 * 只给非我方步骤用 —— 我方步骤永远不带这三种图标(防冒充)。
 */
export function stepSourceIcon(kind: ToolStepSourceKind): JSX.Element {
  switch (kind) {
    case "mcp":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5" />
        </svg>
      )
    case "plugin":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 3a2 2 0 0 1 4 0v2h4a1 1 0 0 1 1 1v4h-2a2 2 0 0 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 0 0-4 0v2H6a1 1 0 0 1-1-1v-4h2a2 2 0 0 0 0-4H5V6a1 1 0 0 1 1-1h4z" />
        </svg>
      )
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 0 1 4.8 1c0 1.7-2.3 2.2-2.3 3.6M12 17h.01" />
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

/**
 * `#1475` AC5 降级步骤详情里的那一句人话(原来常驻的「详情未展示」挪进详情):第三方 / 插件写出
 * 来源名,来源不明直说,还没有展示规则的我方工具只说「不在这里显示」。来源名是 dispatch 已净化
 * 有界的 origin;调用的输入 / 输出 / 错误零字符进文案。
 */
function safeSentence(head: ToolCardHead): string {
  const source = toolStepSourceOf(head)
  if (source?.kind === "mcp")
    return source.label
      ? t("alpha.timeline.stepHiddenMcp", { origin: source.label })
      : t("alpha.timeline.stepHiddenMcpAnon")
  if (source?.kind === "plugin")
    return source.label
      ? t("alpha.timeline.stepHiddenPlugin", { origin: source.label })
      : t("alpha.timeline.stepHiddenPluginAnon")
  if (source?.kind === "unknown") return t("alpha.timeline.stepHiddenUnknown")
  return t("alpha.timeline.stepHiddenOwn")
}

/** `#1475` AC6:审批超时对所有 kind、所有来源都是同一句人话(纯静态,错误原文零字符进 DOM)。 */
function AskTimeoutNote() {
  return (
    <>
      <b data-alpha-ask-timeout>{t("alpha.timeline.askTimeout")}</b>
      <span>{t("alpha.timeline.askTimeoutBody")}</span>
    </>
  )
}

/** `#1475` AC6:答完的提问 —— 每个问题列出选项,高亮你选的那项;自己输入的答案单列。 */
function QuestionDetail(props: { part: ToolPart }) {
  const info = createMemo(() => questionStepInfoOf(props.part))
  return (
    <Show when={info()}>
      {(value) => (
        <div class="a-tc-qa" data-alpha-question-detail>
          <For each={value().items}>
            {(item) => (
              <div class="a-tc-qa-item">
                <Show
                  when={item.question}
                  fallback={
                    <Show when={item.questionHidden}>
                      <div class="a-tc-qa-q" data-alpha-details-hidden>
                        {t("alpha.timeline.detailsHidden")}
                      </div>
                    </Show>
                  }
                >
                  <div class="a-tc-qa-q">{item.question}</div>
                </Show>
                <div class="a-tc-qa-opts">
                  <For each={item.options}>
                    {(option) => (
                      <span class="a-tc-qa-opt" data-selected={option.selected ? "true" : undefined}>
                        {option.label}
                      </span>
                    )}
                  </For>
                  <For each={item.custom}>
                    {(answer) => (
                      <span class="a-tc-qa-opt" data-selected="true" data-custom="true">
                        {answer}
                      </span>
                    )}
                  </For>
                </div>
                <Show when={item.truncated}>
                  <TruncatedNote />
                </Show>
              </div>
            )}
          </For>
          <Show when={value().truncated}>
            <TruncatedNote />
          </Show>
        </div>
      )}
    </Show>
  )
}

export function StatBadge(props: { stat: { additions: number; deletions: number } }) {
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
// 标题行 = 固定标题「工具执行失败」+ 复制,由 ToolStepDetail **常驻渲染**
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
  return (
    <div class="a-tc-err-head">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M4.9 4.9l14.2 14.2" />
      </svg>
      <b>{t("alpha.timeline.toolErrorGeneric")}</b>
      <Show when={canCopy}>
        <CopyButton
          class="a-tc-err-copy"
          dataAttr="data-alpha-tool-error-copy"
          label={t("alpha.timeline.copyError")}
          text={() => props.message}
        />
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

// ── `#1473` 工作过程某一步的详情(复用各类卡片正文,不再常驻) ─────────────
// 头部信息(动作 / 对象 / 失败)已在步骤行上说过一遍,这里不重复(design §6「每样信息只出现
// 一次」);成功不挂状态;「开发者详情」只在详情底部。来源安全规则不变:metadata-only 降级
// 只有确定的隐藏理由与开发者详情,input / output / error 的内容零字符进 DOM。
export function ToolStepDetail(props: { part: ToolPart }) {
  const head = createMemo(() => toolCardHeadOf(props.part))
  const body = createMemo(() => toolCardBodyOf(props.part))
  const hasBody = () => body().type !== "none" && body().type !== "hidden" && body().type !== "error"
  // #879:命令说明副行经模型层 identity 分派 + redactor(不再直读 input)。
  const description = createMemo(() => bashDescriptionOf(props.part))
  const task = createMemo(() => (head().kind === "task" ? taskCardInfoOf(props.part) : undefined))
  const intents = useTimelineIntents()
  // T8「在面板打开」:write/edit 的文件目标 + openFile intent 双在场才渲染(fail-closed)。
  const openPath = createMemo(() => openTargetOf(props.part))
  // T19 诊断行:edit/write 完成态的本文件 ERROR 级诊断(有界;缺席零渲染)。
  const diag = createMemo(() => diagnosticsOf(props.part))
  // #587 开发者详情:快照在场才有(无快照历史行没有可信 identity 可陈列)。
  const dev = createMemo(() => toolDevDetailsOf(props.part))
  // `#1475` AC6:审批超时只说人话,不再显示引擎原文(所有 kind 同一句)。
  const errorBody = () => {
    const value = body()
    return value.type === "error" && !head().askTimedOut ? value : undefined
  }
  return (
    <div class="a-tl-pf-detail" data-alpha-step-detail>
      {/* 次级事实(原卡头的第二行):目录 / include、子任务 agent。脱敏失败出确定标记(AC5)。 */}
      <Show when={head().detail || head().detailHidden || task()?.agent || task()?.agentHidden}>
        <div class="a-tc-facts">
          <Show when={head().detail}>
            <span class="a-tc-detail">{head().detail}</span>
          </Show>
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
          <Show when={task()?.agentHidden}>
            <span class="a-tc-agent" data-alpha-details-hidden>
              <i aria-hidden="true" />
              {t("alpha.timeline.detailsHidden")}
            </span>
          </Show>
        </div>
      </Show>
      {/* `#1475`:命令说明已是步骤行的对象(每样信息只出现一次),命令原文是终端正文首行。
          #934 Minor:说明脱敏失败 → 步骤行退回命令,确定标记留在这里(AC5)。 */}
      <Show when={description()?.hidden}>
        <div class="a-tc-subdesc" data-alpha-details-hidden>
          {t("alpha.timeline.detailsHidden")}
        </div>
      </Show>
      <Show when={(task()?.childSessionID && intents.openSession) || (openPath() && intents.openFile)}>
        <div class="a-tc-actions">
          <Show when={task()?.childSessionID && intents.openSession}>
            <button type="button" class="a-tc-open" onClick={() => intents.openSession!(task()!.childSessionID!)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15 3h6v6M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
              </svg>
              {t("alpha.timeline.openSubtask")}
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
        </div>
      </Show>
      {/* #587 安全通用卡(AC2):metadata-only 降级陈述确定的隐藏理由;纯静态文案,
          不携带参数/错误/输出,也没有任何展开入口。#1214 AC2:审批超时是确定结局,
          文案仍纯静态,错误原文零字符进 DOM。 */}
      <Show when={head().metadataOnly}>
        <div class="a-tc-safe" data-alpha-safe-card>
          <Show when={head().askTimedOut} fallback={<span>{safeSentence(head())}</span>}>
            <AskTimeoutNote />
          </Show>
        </div>
      </Show>
      <Show when={!head().metadataOnly && head().askTimedOut}>
        <div class="a-tc-safe" data-alpha-ask-timeout-card>
          <AskTimeoutNote />
        </div>
      </Show>
      <Show when={head().kind === "question"}>
        <QuestionDetail part={props.part} />
      </Show>
      {/* AC5:redactor 失败的整字段 → 确定「详情已隐藏」,无 raw 旁路。 */}
      <Show when={body().type === "hidden"}>
        <div class="a-tc-out" data-alpha-details-hidden>
          {t("alpha.timeline.detailsHidden")}
        </div>
      </Show>
      <Show when={hasBody()}>
        <CardBody head={head()} body={body()} />
      </Show>
      <Show when={errorBody()}>
        {(err) => (
          <div class="a-tc-err" role="alert">
            <ToolErrorHead message={err().message} />
            <div class="a-tc-error-body">
              {err().message}
              <Show when={err().truncated}>
                <TruncatedNote />
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
      {/* #587 开发者详情(AC3/AC4):technical-id / canonical identity / authority 证明只在这里,
          且只在详情底部;默认折叠(原生 details 无 open 属性),纯文本、已限长,不参与任何
          授权/策略/计费判定(cards-contract 的 import 面棘轮钉着)。 */}
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
    </div>
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
        {/* `#1382`:围栏拒绝时换的是**这一句**,卡的形态不变(已批帧 2026-07-23:图标 + 固定
            标题 + 一段正文 + mono 错误码)。换掉而不是追加,是因为被换掉的那段正文正是
            `Forbidden: alpha egress policy: …` 这串英文工程话 —— 它今天就在这里,而用户读不出
            「是自己这台电脑拦的」。归因只在认出 reason=unregistered 时给;认不出一律走原文案。 */}
        <Show
          when={props.row.egressDenied}
          fallback={
            <Show when={props.row.message}>
              <p>{props.row.message}</p>
            </Show>
          }
        >
          {(denied) => <p>{t("alpha.timeline.turnErrorEgressBlocked", { authority: denied().authority })}</p>}
        </Show>
        <span class="a-turn-err-code">{props.row.name}</span>
      </div>
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
            onClick={() => intents.focusArtifact?.({ id: link.id, name: link.name, runId: link.runId })}
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
