// SessionQuestionCard —— 提问卡(question typed 通道;回答绑 sessionID+requestID)。
//
// 从 session-composer-dock 抽出:这一族是纯呈现,一切从 props 进来,不碰 ServerSDK/Router
// 上下文 —— 与 files-view / terminal-rail-panel 同形制,于是能被真 Solid 挂载测试直接驱动。
// C21 AC2 的 radiogroup 键盘契约(方向键、单一 Tab 落点、组名、单选不可取消)就靠那层测试咬住。

import type { createOpencodeClient, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import { t } from "../../i18n"
import { rovingKey, rovingTabIndex } from "../roving-focus"
import { questionAnswersComplete, sdkResultFailed } from "./session-dock-core"
import type { AlphaSessionIdentity } from "./session-workspace-core"

export function SessionQuestionCard(props: {
  request: QuestionRequest
  identity: () => AlphaSessionIdentity | undefined
  accepts: (identity: AlphaSessionIdentity) => boolean
  client: () => ReturnType<typeof createOpencodeClient> | undefined
}) {
  const [selections, setSelections] = createSignal<string[][]>(props.request.questions.map(() => []))
  const [custom, setCustom] = createSignal<string[]>(props.request.questions.map(() => ""))
  const [submitting, setSubmitting] = createSignal(false)
  const [failed, setFailed] = createSignal(false)

  // 多选组的 checkbox 语义:再点取消。单选组不走这里(见下方 select)。
  const toggle = (questionIndex: number, label: string) => {
    setSelections((previous) =>
      previous.map((picked, index) => {
        if (index !== questionIndex) return picked
        if (picked.includes(label)) return picked.filter((value) => value !== label)
        return [...picked, label]
      }),
    )
  }
  // C21 AC2:单选组是 radiogroup ——「选中即不可取消」是它的契约(APG:已选 radio 上的 Space
  // 不做任何事,只有移到另一项才换选)。所以单选的每一个激活入口(click / Space / Enter /
  // 方向键)都走 select;toggle 只留给多选的 checkbox 组,那里「再点取消」才是对的。
  const select = (questionIndex: number, label: string) =>
    setSelections((previous) => previous.map((picked, index) => (index === questionIndex ? [label] : picked)))
  const activeOption = (info: QuestionRequest["questions"][number], questionIndex: number) =>
    info.options.find((option) => (selections()[questionIndex] ?? []).includes(option.label)) ?? info.options[0]
  const optionID = (questionIndex: number, optionIndex: number) =>
    `alpha-question-${props.request.id}-${questionIndex}-${optionIndex}`
  // radiogroup 自身要有可读名称:一张卡里两道 Yes/No 题时,读屏进第二组只报「radio group, Yes」
  // 就分不清在答哪道题。名称取可见的问题文本,不新写一份隐藏文案。
  const questionLabelID = (questionIndex: number) => `alpha-question-${props.request.id}-${questionIndex}-label`

  const answers = createMemo(() =>
    props.request.questions.map((info, index) => {
      const picked = selections()[index] ?? []
      const written = info.custom ? (custom()[index] ?? "").trim() : ""
      return picked.length > 0 ? picked : written ? [written] : []
    }),
  )
  const complete = createMemo(() => questionAnswersComplete(props.request.questions, answers()))

  const submit = (kind: "reply" | "reject") => {
    if (submitting()) return
    const bound = props.identity()
    const client = props.client()
    // I8:提交绑定发起时刻的身份 + request ID;身份已切换/通道缺席的提交直接丢弃。
    if (!bound || !client || !props.accepts(bound) || props.request.sessionID !== bound.sessionID) return
    setSubmitting(true)
    setFailed(false)
    const call =
      kind === "reply"
        ? client.v2.session.question.reply({
            sessionID: bound.sessionID,
            requestID: props.request.id,
            questionV2Reply: { answers: answers() as string[][] },
          })
        : client.v2.session.question.reject({ sessionID: bound.sessionID, requestID: props.request.id })
    call.then(
      (result) => {
        // throwOnError:false 档位的 { error } 信封同样是失败(审计 minor:4xx 不装成功)。
        if (sdkResultFailed(result)) {
          setSubmitting(false)
          setFailed(true)
          return
        }
        setSubmitting(false)
      },
      () => {
        setSubmitting(false)
        setFailed(true)
      },
    )
  }

  return (
    <section
      class="a-swk-card a-swk-question"
      data-alpha-session-question={props.request.id}
      role="group"
      aria-label={t("alpha.session.questionTitle")}
    >
      <For each={props.request.questions}>
        {(info, index) => (
          <div class="a-swk-question-item">
            <header class="a-swk-question-head">
              <span class="a-swk-question-kicker">{info.header || t("alpha.session.questionTitle")}</span>
              <span class="a-swk-question-text" id={questionLabelID(index())}>
                {info.question}
              </span>
            </header>
            <div
              class="a-swk-question-options"
              role={info.multiple ? "group" : "radiogroup"}
              aria-labelledby={questionLabelID(index())}
            >
              <For each={info.options}>
                {(option, optionIndex) => (
                  <button
                    type="button"
                    id={optionID(index(), optionIndex())}
                    class="a-swk-option"
                    role={info.multiple ? "checkbox" : "radio"}
                    aria-checked={(selections()[index()] ?? []).includes(option.label)}
                    data-selected={(selections()[index()] ?? []).includes(option.label) ? "" : undefined}
                    title={option.description}
                    disabled={submitting()}
                    tabIndex={info.multiple ? undefined : rovingTabIndex(activeOption(info, index()) === option)}
                    onClick={() => (info.multiple ? toggle(index(), option.label) : select(index(), option.label))}
                    onKeyDown={(event) => {
                      // 多选组是 group/checkbox:每个 checkbox 都在 Tab 序列里,不欠方向键。
                      if (info.multiple) return
                      rovingKey(event, "radio", info.options, activeOption(info, index()), (next) => {
                        select(index(), next.label)
                        document.getElementById(optionID(index(), info.options.indexOf(next)))?.focus()
                      })
                    }}
                  >
                    {option.label}
                  </button>
                )}
              </For>
            </div>
            <Show when={info.custom}>
              <input
                class="a-swk-question-custom"
                type="text"
                placeholder={t("alpha.session.questionCustomPlaceholder")}
                value={custom()[index()] ?? ""}
                disabled={submitting()}
                onInput={(event) =>
                  setCustom((previous) =>
                    previous.map((value, valueIndex) => (valueIndex === index() ? event.currentTarget.value : value)),
                  )
                }
              />
            </Show>
          </div>
        )}
      </For>
      <div class="a-swk-question-actions">
        <button
          type="button"
          class="a-swk-btn a-swk-btn--primary"
          disabled={submitting() || !complete()}
          onClick={() => submit("reply")}
        >
          {t("alpha.session.questionSubmit")}
        </button>
        <button type="button" class="a-swk-btn" disabled={submitting()} onClick={() => submit("reject")}>
          {t("alpha.session.questionDismiss")}
        </button>
      </div>
      <Show when={failed()}>
        <p class="a-swk-approval-error" role="alert">
          {t("alpha.session.questionFailed")}
        </p>
      </Show>
    </section>
  )
}
