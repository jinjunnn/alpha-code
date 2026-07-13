---
name: office-docs
description: Create, edit, and read office documents — Excel (xlsx), Word (docx), PowerPoint (pptx), and PDF. Use when the user asks to build a spreadsheet, write a report or slide deck as a real document file, extract content from office files, or generate/merge/split PDFs.
license: Apache-2.0 (alpha-code original — no Anthropic skill text)
---

# Office documents

You help the user produce and read real office files. alpha-code's office capability is built on
**connectors (MCP)** where a trusted one exists, and **small local scripts** where it doesn't —
pick the right path, and be honest when neither is available.

> Security note (REQ-105, 2026-07): the Word and PowerPoint writer connectors formerly listed
> here were retired — their upstream repositories are archived and unmaintained (supply-chain
> risk). Do NOT recommend installing them. If the user already has them installed, the Extension
> Hub (定制中心 → 已安装) shows an archived advisory with disable/uninstall guidance — never
> remove anything on the user's behalf. The maintained path for docx/pptx creation is a local
> script (below).

## Which tool for which job

| Job | Use | Notes |
|---|---|---|
| **Read/extract** any document (PDF/Word/PPT/Excel/HTML/images) | markitdown connector (`convert_to_markdown`) | read-only, converts to Markdown |
| **Create/edit xlsx** | excel-mcp-server connector | formulas, charts, pivot tables; no Excel install needed (openpyxl-based). Security-audit pinned to an exact version (0.1.8); local stdio only |
| **Create/edit docx** | local Python script with `python-docx` | no maintained connector — write a small script (user consent to run code first) |
| **Create/edit pptx** | local Python script with `python-pptx` | no maintained connector — same script path |
| **Create/merge/split PDF** | no trusted connector exists (ecosystem gap) | write a small Python script with `reportlab` / `pypdf` (see below) |

The Excel connector runs via `uvx` (Python fetched at first run) — same on macOS and Windows, no
Microsoft Office needed. `python-docx` / `python-pptx` / `openpyxl` / `pypdf` / `reportlab` are
BSD/MIT-licensed and installable with `uv pip` / `pip`.

## If the tool is not available

Check your tool list first. If the needed tools are absent:

1. For **xlsx**: point the user to the **Extension Hub (定制中心) → 连接器 → 办公** for the Excel
   connector, or the 办公套件 bundle (first run downloads from PyPI — may take a minute).
2. For **docx/pptx** — and as an xlsx fallback, only with the user's consent to run code — write a
   local Python script using `python-docx` (docx), `python-pptx` (pptx), `openpyxl` (xlsx).
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

## docx / pptx script snippets

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

## PDF creation/manipulation snippets

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
