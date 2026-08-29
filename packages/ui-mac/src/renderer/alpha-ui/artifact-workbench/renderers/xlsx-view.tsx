// REQ-123(#1176)—— xlsx 表格呈现(AC2)。铁律与 content-views 相同:
// 一切内容只经 Solid 文本节点呈现,零 innerHTML、零 iframe;公式格显示缓存值或公式原文,
// 永不求值(title 里带 = 前缀展示 <f> 原文);多工作表给出清单并可切换。

import { createSignal, For, Show } from "solid-js"
import { t } from "../../../i18n"
import {
  columnLabel,
  XLSX_MAX_COLUMNS,
  XLSX_MAX_ROWS,
  type XlsxSheetGrid,
  type XlsxWorkbook,
} from "./xlsx-model"

export function XlsxWorkbookView(props: { workbook: XlsxWorkbook }) {
  const [active, setActive] = createSignal(0)
  const sheets = () => props.workbook.sheets
  const activeSheet = () => sheets()[Math.min(active(), sheets().length - 1)]
  return (
    <div class="a-wb-xlsx">
      <Show when={sheets().length > 1}>
        <div class="a-wb-xlsx-tabs" role="tablist" aria-label={t("alpha.wb.xlsxSheets")}>
          <For each={sheets()}>
            {(sheet, i) => (
              <button
                type="button"
                role="tab"
                class="a-wb-xlsx-tab"
                data-alpha-xlsx-tab={sheet.name}
                aria-selected={i() === active()}
                onClick={() => setActive(i())}
              >
                {sheet.name}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={activeSheet()} keyed>
        {(sheet) =>
          sheet.status === "ok" ? (
            <SheetGridView grid={sheet.grid} name={sheet.name} />
          ) : (
            <div class="a-wb-notice" data-kind="error">
              {t("alpha.wb.xlsxSheetMissing", { name: sheet.name })}
            </div>
          )
        }
      </Show>
    </div>
  )
}

function SheetGridView(props: { grid: XlsxSheetGrid; name: string }) {
  return (
    <>
      <Show when={props.grid.truncatedRows}>
        <div class="a-wb-notice" data-kind="warn">{t("alpha.wb.xlsxRowsCapped", { cap: XLSX_MAX_ROWS })}</div>
      </Show>
      <Show when={props.grid.truncatedColumns}>
        <div class="a-wb-notice" data-kind="warn">{t("alpha.wb.xlsxColsCapped", { cap: XLSX_MAX_COLUMNS })}</div>
      </Show>
      <Show
        when={props.grid.rows.length > 0}
        fallback={<div class="a-wb-notice">{t("alpha.wb.xlsxEmptySheet")}</div>}
      >
        <div class="a-wb-tablewrap" data-alpha-xlsx-sheet={props.name}>
          <table>
            <thead>
              <tr>
                <th aria-hidden="true" />
                <For each={Array.from({ length: props.grid.columnCount }, (_, c) => c)}>
                  {(c) => <th scope="col">{columnLabel(c)}</th>}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={props.grid.rows}>
                {(row, r) => (
                  <tr>
                    <th scope="row">{r() + 1}</th>
                    <For each={row}>
                      {(cell) => (
                        <td
                          data-cellkind={cell.kind === "empty" ? undefined : cell.kind}
                          title={cell.kind === "formula" && cell.formula ? `=${cell.formula}` : undefined}
                        >
                          {cell.kind === "unresolved" ? t("alpha.wb.xlsxUnresolved") : cell.text}
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </>
  )
}
