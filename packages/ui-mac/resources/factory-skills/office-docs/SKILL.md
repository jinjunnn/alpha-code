---
name: office-docs
description: Create, edit, and read office documents — Excel (xlsx), Word (docx), PowerPoint (pptx), and PDF. Use when the user asks to build a spreadsheet, write a report or slide deck as a real document file, extract content from office files, or generate/merge/split PDFs.
license: Apache-2.0 (Code Puppy original — no Anthropic skill text)
---

# Office documents

You help the user produce and read real office files. The primary path is Alpha's four first-party
local stdio MCP connectors. Use a small local script only when a connector is unavailable or the
request is outside its deliberately narrow tool contract.

> Security note: the old community `mcp:word` and `mcp:powerpoint` connectors remain archived and
> unsupported; do not recommend or relabel them. The separate community `mcp:excel` /
> `excel-mcp-server` connector is retired and is not an install option. The primary cards are the
> distinct Alpha-authored ids below. They run over stdio, accept only absolute paths inside the
> granted workspace, and do not expose host, port, HTTP, or SSE modes.

## Which tool for which job

| Job | Primary connector and tools | Notes |
|---|---|---|
| **Read/write docx** | `mcp:alpha-word` (`read_docx`, `write_docx`) | `python-docx`; title, body paragraphs, `heading` blocks (levels 1–9), `table` blocks, `page` (A4 default or Letter, orientation, margins in mm), `font` (`eastAsia` defaults to 宋体; `latin`; `size` in pt). Put section titles such as 一、总体情况 in `heading` blocks, never as body text. Undeclared fields are refused, not dropped |
| **Read/write xlsx** | `mcp:alpha-excel` (`read_xlsx`, `write_xlsx`) | `openpyxl`; sheet/cell data without Microsoft Excel |
| **Read/write pptx** | `mcp:alpha-powerpoint` (`read_pptx`, `write_pptx`) | `python-pptx`; slide titles and text bodies |
| **Read/write PDF text pages** | `mcp:alpha-pdf` (`read_pdf`, `write_pdf`) | `pypdf` + `reportlab`; replace/generate or append text pages, not layout design |
| **Broad read/conversion** | markitdown (`convert_to_markdown`) | optional secondary path for formats outside the four focused tools |

All four Alpha connectors run with pinned Python libraries through `uv`; they need no Microsoft
Office installation. Hub Excel means `mcp:alpha-excel` only. Do not install, recommend, or fall back
to the retired community `excel-mcp-server`, and never present it as Alpha-authored.

## If the tool is not available

Check your tool list first. If the needed tools are absent:

1. Point the user to **Extension Hub (定制中心) → 连接器 → 办公** and the matching Alpha Word,
   Excel, PowerPoint, or PDF card (first run may download its pinned Python library).
2. As a fallback, only with the user's consent to run code, write a local Python script using
   `python-docx`, `openpyxl`, `python-pptx`, `pypdf`, or `reportlab`.
3. Never fake success: if you can neither use a connector nor run code, say exactly that.

## What each writer really accepts

These are the connectors' actual tool schemas (`additionalProperties: false` — anything else is
rejected or silently dropped). Read them before you promise a user any formatting.

| Tool | Accepts | Cannot do, at all |
|---|---|---|
| `write_docx` | `{path, title, paragraphs[], append}` | colours, bullet/numbered lists, explicit page breaks, headers/footers, page numbers, images, table of contents. Headings, tables, page geometry and fonts **are** supported since `#1245` — see the capability row above; undeclared fields are refused, not silently dropped |
| `write_xlsx` | `{path, sheets:[{name, cells}]}` where `cells` maps `"A1"` to a value | number formats, cell styles, column widths, merged cells, freeze panes, autofilter, charts, pivots, conditional formatting |
| `write_pptx` | `{path, slides:[{title, body}], append}` | layouts, themes, images, speaker notes, per-run formatting |
| `write_pdf` | `{path, pages[], mode}` | layout, fonts, images, headers/footers — it renders plain text pages |

Two consequences you must act on:

- **Never describe the file as styled when you did not style it.** Say plainly which parts of the
  requested formatting the connector cannot produce, and offer the fallback script (below) as the
  way to get them. Silently returning success on a request for "a formatted report" is the failure
  mode this section exists to prevent.
- Passing an unsupported key (`font`, `size`, `number_format`) does **not** raise — it is dropped.
  A "success" response is not evidence that formatting was applied.

## Spreadsheet conventions (xlsx)

Verified against the shipped connector (`openpyxl==3.1.5`, the pinned version), by writing a
workbook and reading the cells back:

- **Numbers stay numbers.** Send `3` or `4.5`, not `"3"` — they land as numeric cells.
- **Formulas work.** A string that starts with `=` (`"=SUM(B2:B3)"`) is stored as a real formula,
  so prefer formulas over precomputed constants whenever the sheet is meant to be edited later.
- **Dates do not.** `"2026-09-06"` lands as *text*, not a date cell, and there is no way to set a
  date format through this connector. If the user needs real date cells, say so and use the
  fallback script.
- **Every cell keeps `General` format.** Currency, percent, thousands separators and date formats
  are unreachable. If a column is a percentage, put that in the header text (`Share (%)`) rather
  than pretending the cell is formatted.

Layout habits that still apply, because they are about the data rather than the styling:

- One logical table per sheet; row 1 is the header row; give sheets meaningful names.
- Do not scatter a data range across merged-looking gaps — you cannot merge cells here anyway, and
  blank spacer rows break sorting and filtering for whoever opens the file.
- The connector works on **absolute paths inside the user's workspace** — never reach outside the
  workspace or use `..` path segments.

## Fallback docx / pptx script snippets

Create a simple report (`python-docx`, MIT):

```python
from docx import Document

doc = Document()
doc.add_heading("Title", level=0)
doc.add_paragraph("Body text …")
table = doc.add_table(rows=1, cols=2)
table.rows[0].cells[0].text = "Item"
table.rows[0].cells[1].text = "Value"
doc.save("report.docx")
```

Create a slide deck (`python-pptx`, MIT):

```python
from pptx import Presentation

prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = "Title"
slide.placeholders[1].text = "First bullet"
prs.save("deck.pptx")
```

## Fallback PDF creation/manipulation snippets

Create a simple PDF report (`reportlab`, BSD):

```python
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()
doc = SimpleDocTemplate("report.pdf", pagesize=A4)
doc.build([
    Paragraph("Title", styles["Title"]),
    Spacer(1, 12),
    Paragraph("Body text …", styles["BodyText"]),
])
```

Merge / split / extract pages (`pypdf`, BSD):

```python
from pypdf import PdfReader, PdfWriter

w = PdfWriter()
for src in ("a.pdf", "b.pdf"):
    for page in PdfReader(src).pages:
        w.add_page(page)
with open("merged.pdf", "wb") as f:
    w.write(f)
```

For "document → PDF" requests, prefer generating the document (docx/xlsx) first, then ask how the
user wants the PDF: printing to PDF manually, or a reportlab re-render — each has different
fidelity; don't silently pick one.

## What the document itself should look like

The connectors decide what you *can* render; this section decides whether the result is worth
reading. It applies to every office file you produce, and to the fallback-script path too.

- **Lead with the conclusion.** First paragraph (or first sheet, or first slide) answers the
  question that made the user ask for the document. Background comes after it, never before.
- **One idea per section, and let the section title say what it concludes** — "Costs rose because
  of retries", not "Cost analysis".
- **Depth follows the material, not a word count.** A number without its source is noise: give the
  date, the range, the query, or the file it came from.
- **Two heading levels at most.** Needing a third means the document should be split.
  `write_docx` accepts `heading` blocks at levels 1–9, but that is a capability, not a licence:
  keep to two levels and let the heading text state a conclusion, not a topic.
- **A table only when rows share fields and are meant to be compared.** Never leave a cell blank —
  write why it is blank. A list only for three or more peer items; two bullets are a sentence.
  Arguments and causal chains stay prose: bullets delete what made them an argument.
- **No emoji, no decorative separators, no whole-paragraph bolding.**
- **End with what is still open** — unknowns, risks, next step — when such things exist, and drop
  the section entirely when they do not.

When the document is in Chinese:

- Full-width punctuation (,。、;:?!) for the Chinese text; ASCII punctuation stays inside code,
  paths, commands, and identifiers.
- One space between Chinese characters and adjacent Latin letters or digits; no space next to
  full-width punctuation.
- Half-width digits, and a space between a number and its unit (12 ms, 3 GB, 45%).
- Headings take no trailing period; number them (一、/ 1.) only when the order matters.
- The connectors do not set an East Asian font — the generated files leave `eastAsia` empty and the
  reader's default applies. Do not tell the user you chose a Chinese typeface.

## Output location

Write files where the user says; in a project, prefer the project directory. With no project
context, follow the `~/code-puppy` workspace conventions (deliverables are user-visible files — never
write into `.code-puppy/`).
