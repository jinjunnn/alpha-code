---
name: office-docs
description: Create, edit, and read office documents — Excel (xlsx), Word (docx), PowerPoint (pptx), and PDF. Use when the user asks to build a spreadsheet, write a report or slide deck as a real document file, extract content from office files, or generate/merge/split PDFs.
license: Apache-2.0 (alpha-code original — no Anthropic skill text)
---

# Office documents

You help the user produce and read real office files. The primary path is Alpha's four first-party
local stdio MCP connectors. Use a small local script only when a connector is unavailable or the
request is outside its deliberately narrow tool contract.

> Security note: the old community `mcp:word` and `mcp:powerpoint` connectors remain archived and
> unsupported; do not recommend or relabel them. The primary cards are the distinct Alpha-authored
> ids below. They run over stdio, accept only absolute paths inside the granted workspace, and do
> not expose host, port, HTTP, or SSE modes.

## Which tool for which job

| Job | Primary connector and tools | Notes |
|---|---|---|
| **Read/write docx** | `mcp:alpha-word` (`read_docx`, `write_docx`) | `python-docx`; text, headings, and paragraphs |
| **Read/write xlsx** | `mcp:alpha-excel` (`read_xlsx`, `write_xlsx`) | `openpyxl`; sheet/cell data without Microsoft Excel |
| **Read/write pptx** | `mcp:alpha-powerpoint` (`read_pptx`, `write_pptx`) | `python-pptx`; slide titles and text bodies |
| **Read/write PDF text pages** | `mcp:alpha-pdf` (`read_pdf`, `write_pdf`) | `pypdf` + `reportlab`; replace/generate or append text pages, not layout design |
| **Broad read/conversion** | markitdown (`convert_to_markdown`) | optional secondary path for formats outside the four focused tools |

All four Alpha connectors run with pinned Python libraries through `uv`; they need no Microsoft
Office installation. The old community `excel-mcp-server` is a separate REQ-105-governed connector,
not the implementation or authorship source for `mcp:alpha-excel`.

## If the tool is not available

Check your tool list first. If the needed tools are absent:

1. Point the user to **Extension Hub (定制中心) → 连接器 → 办公** and the matching Alpha Word,
   Excel, PowerPoint, or PDF card (first run may download its pinned Python library).
2. As a fallback, only with the user's consent to run code, write a local Python script using
   `python-docx`, `openpyxl`, `python-pptx`, `pypdf`, or `reportlab`.
3. Never fake success: if you can neither use a connector nor run code, say exactly that.

## Spreadsheet conventions (xlsx)

When you build workbooks, default to these habits unless the user says otherwise:

- One logical table per sheet; row 1 is the header row; give sheets meaningful names.
- Store real types: numbers as numbers, dates as dates — not preformatted strings. Apply number
  formats (currency, percent, date) via cell format, not by baking text.
- Don't merge cells inside a data range (it breaks sorting/filtering); merging is fine for titles
  above the table.
- Use formulas (`=SUM(...)` etc.) rather than precomputed constants when the sheet is meant to be
  edited later; recompute totals when source cells change.
- Charts and pivots should reference ranges, so they update when data changes.
- For large data dumps, freeze the header row and add an autofilter.
- The Excel connector works on **absolute paths inside the user's workspace** — never reach
  outside the workspace or use `..` path segments.

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

## Output location

Write files where the user says; in a project, prefer the project directory. With no project
context, follow the `~/Alpha` workspace conventions (deliverables are user-visible files — never
write into `.alpha/`).
