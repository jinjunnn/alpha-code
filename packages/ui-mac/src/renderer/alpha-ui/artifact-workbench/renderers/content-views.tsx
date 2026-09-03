// REQ-095/REQ-108 —— 可复用的内容视图积木(REQ-108 从 renderer-views.tsx 原样抽出)。
// artifact workbench 与右栏文件查看器共用:同一份净化模型渲染,零 innerHTML、零 iframe。
// 铁律与 renderer-views.tsx 相同:所有文本内容只经 Solid 文本节点呈现;链接一律经系统策略
// 外部打开;远程图默认不发请求。

import { createSignal, For, Show } from "solid-js"
import { t } from "../../../i18n"
import { highlightCode } from "./highlight"
import type { JsonNode } from "./json-model"
import type { MdBlock, MdInline } from "./markdown-model"
import type { OfficeTextModel } from "./office-text"

export const MAX_RENDER_LINES = 5000

export function LinesView(props: { text: string; lang: string | null }) {
  const lines = () => {
    const all = highlightCode(props.text, props.lang)
    return { shown: all.slice(0, MAX_RENDER_LINES), total: all.length }
  }
  return (
    <>
      <Show when={lines().total > MAX_RENDER_LINES}>
        <div class="a-wb-notice" data-kind="warn">{t("alpha.wb.linesCapped", { cap: MAX_RENDER_LINES, total: lines().total })}</div>
      </Show>
      <pre class="a-wb-code" tabIndex={0}>
        <For each={lines().shown}>
          {(tokens, i) => (
            <div class="a-wb-codeline">
              <span class="a-wb-lineno" aria-hidden="true">{i() + 1}</span>
              <span class="a-wb-linetext">
                <For each={tokens}>{(tok) => <span data-tok={tok.kind === "plain" ? undefined : tok.kind}>{tok.text}</span>}</For>
              </span>
            </div>
          )}
        </For>
      </pre>
    </>
  )
}


export function MdInlineView(props: { nodes: MdInline[] }) {
  return (
    <For each={props.nodes}>
      {(n) => {
        switch (n.kind) {
          case "text":
            return <>{n.text}</>
          case "strong":
            return <strong><MdInlineView nodes={n.children} /></strong>
          case "em":
            return <em><MdInlineView nodes={n.children} /></em>
          case "del":
            return <del><MdInlineView nodes={n.children} /></del>
          case "codespan":
            return <code>{n.text}</code>
          case "br":
            return <br />
          case "link":
            return n.href ? (
              <a
                href={n.href}
                rel="noopener noreferrer"
                onClick={(e) => {
                  // 链接一律经系统策略外部打开(REQ-095 AC#5 语义),绝不让预览面导航。
                  e.preventDefault()
                  if (n.href) window.api.openLink(n.href)
                }}
              >
                <MdInlineView nodes={n.children} />
              </a>
            ) : (
              <span class="a-wb-deadlink" title={t("alpha.wb.linkBlocked")}>
                <MdInlineView nodes={n.children} />
              </span>
            )
          case "image":
            return <MdImage src={n.src} alt={n.alt} blocked={n.blocked} />
        }
      }}
    </For>
  )
}

/** 远程图默认不发请求(REQ-095 AC#4);https 图可显式点击加载,其余永不可加载。 */
function MdImage(props: { src: string | null; alt: string; blocked: "remote" | "unsafe" }) {
  const [loaded, setLoaded] = createSignal(false)
  return (
    <Show
      when={loaded() && props.src}
      fallback={
        props.blocked === "remote" && props.src ? (
          <button type="button" class="a-wb-imgchip" onClick={() => setLoaded(true)}>
            {t("alpha.wb.imgLoad", { alt: props.alt || "image" })}
          </button>
        ) : (
          <span class="a-wb-imgchip" data-dead="">{t("alpha.wb.imgBlocked", { alt: props.alt || "image" })}</span>
        )
      }
    >
      <img class="a-wb-mdimg" src={props.src!} alt={props.alt} loading="lazy" referrerpolicy="no-referrer" />
    </Show>
  )
}

export function MdBlockView(props: { blocks: MdBlock[] }) {
  return (
    <For each={props.blocks}>
      {(b) => {
        switch (b.kind) {
          case "heading": {
            const inner = <MdInlineView nodes={b.children} />
            switch (b.depth) {
              case 1: return <h1>{inner}</h1>
              case 2: return <h2>{inner}</h2>
              case 3: return <h3>{inner}</h3>
              case 4: return <h4>{inner}</h4>
              case 5: return <h5>{inner}</h5>
              default: return <h6>{inner}</h6>
            }
          }
          case "paragraph":
            return <p><MdInlineView nodes={b.children} /></p>
          case "code":
            return <LinesView text={b.text} lang={b.lang} />
          case "blockquote":
            return <blockquote><MdBlockView blocks={b.children} /></blockquote>
          case "list":
            return b.ordered ? (
              <ol start={b.start ?? undefined}>
                <For each={b.items}>{(item) => <li><MdBlockView blocks={item} /></li>}</For>
              </ol>
            ) : (
              <ul>
                <For each={b.items}>{(item) => <li><MdBlockView blocks={item} /></li>}</For>
              </ul>
            )
          case "table":
            return (
              <div class="a-wb-tablewrap">
                <table>
                  <thead>
                    <tr><For each={b.header}>{(cell) => <th><MdInlineView nodes={cell} /></th>}</For></tr>
                  </thead>
                  <tbody>
                    <For each={b.rows}>
                      {(row) => <tr><For each={row}>{(cell) => <td><MdInlineView nodes={cell} /></td>}</For></tr>}
                    </For>
                  </tbody>
                </table>
              </div>
            )
          case "hr":
            return <hr />
          case "rawhtml":
            // 字面呈现内嵌 HTML(构造性净化 —— 显示原文,零解释)。
            return <pre class="a-wb-rawhtml">{b.text}</pre>
        }
      }}
    </For>
  )
}


export function JsonNodeView(props: { node: JsonNode; depth: number }) {
  const n = props.node
  if (n.kind === "value") {
    return (
      <div class="a-wb-jsonrow" style={{ "--depth": String(props.depth) }}>
        <Show when={n.key !== null}><span class="a-wb-jsonkey">{n.key}</span></Show>
        <span class="a-wb-jsonval" data-vtype={n.vtype}>
          {n.vtype === "string" ? `"${n.display}"` : n.display}
          <Show when={n.clipped}><span class="a-wb-clip" title={t("alpha.wb.jsonClipped")}>…</span></Show>
        </span>
      </div>
    )
  }
  return (
    <details class="a-wb-jsonnode" open={props.depth < 2} style={{ "--depth": String(props.depth) }}>
      <summary>
        <Show when={n.key !== null}><span class="a-wb-jsonkey">{n.key}</span></Show>
        <span class="a-wb-jsonmeta">{n.kind === "array" ? `[${n.count}]` : `{${n.count}}`}</span>
      </summary>
      <Show when={!n.depthCut} fallback={<div class="a-wb-notice" data-kind="warn">{t("alpha.wb.jsonDepthCut")}</div>}>
        <For each={n.children}>{(child) => <JsonNodeView node={child} depth={props.depth + 1} />}</For>
        <Show when={n.truncatedChildren}>
          <div class="a-wb-notice" data-kind="warn">{t("alpha.wb.jsonNodesCut")}</div>
        </Show>
      </Show>
    </details>
  )
}

// REQ-123(#1175)AC1/AC3/AC6:提取文本内容视图 —— pass 分支的默认呈现。
// 一切文本只经 Solid 文本节点(基线 ③ 类 3/5:纯数据文本,无 innerHTML 注入路径);
// 保真声明明写排版不保真(AC6);pptx 按权威页序分页呈现,备注独立成块。
export function OfficeTextContent(props: { model: OfficeTextModel }) {
  const nonEmpty = (lines: string[]) => lines.filter((line) => line.trim().length > 0)
  return (
    <div class="a-wb-office-content" data-office-content aria-label={t("alpha.wb.office.contentTitle")}>
      <p class="a-wb-office-fidelity" data-office-fidelity>{t("alpha.wb.office.fidelityNote")}</p>
      <Show when={props.model.kind === "docx" ? props.model : undefined} keyed>
        {(docx) => (
          <For each={nonEmpty(docx.paragraphs)}>
            {(paragraph) => <p class="a-wb-office-para">{paragraph}</p>}
          </For>
        )}
      </Show>
      <Show when={props.model.kind === "pptx" ? props.model : undefined} keyed>
        {(pptx) => (
          <For each={pptx.slides}>
            {(slide, index) => (
              <section class="a-wb-office-slide" data-office-slide={index() + 1}>
                <h4 class="a-wb-office-slide-h">{t("alpha.wb.office.slideLabel", { n: index() + 1 })}</h4>
                <For each={nonEmpty(slide.paragraphs)}>
                  {(paragraph) => <p class="a-wb-office-para">{paragraph}</p>}
                </For>
                <Show when={nonEmpty(slide.notes).length > 0}>
                  <div class="a-wb-office-notes" data-office-notes>
                    <b>{t("alpha.wb.office.notesLabel")}</b>
                    <For each={nonEmpty(slide.notes)}>
                      {(note) => <p class="a-wb-office-para">{note}</p>}
                    </For>
                  </div>
                </Show>
              </section>
            )}
          </For>
        )}
      </Show>
    </div>
  )
}
