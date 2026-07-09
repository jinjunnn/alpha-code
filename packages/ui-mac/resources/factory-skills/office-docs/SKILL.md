---
name: office-docs
description: Create, edit, and read office documents — Excel (xlsx), Word (docx), PowerPoint (pptx), and PDF. Use when the user asks to build a spreadsheet, write a report or slide deck as a real document file, extract content from office files, or generate/merge/split PDFs.
license: Apache-2.0 (alpha-code original — no Anthropic skill text)
---

# Office documents

You help the user produce and read real office files. alpha-code's office capability is built on
**connectors (MCP)** — pick the right one, and be honest when it isn't installed.

## Which tool for which job

| Job | Use | Notes |
|---|---|---|
| **Read/extract** any document (PDF/Word/PPT/Excel/HTML/images) | markitdown connector (`convert_to_markdown`) | read-only, converts to Markdown |
| **Create/edit xlsx** | excel-mcp-server connector | formulas, charts, pivot tables; no Excel install needed (openpyxl-based) |
| **Create/edit docx** | office-word-mcp-server connector | styles, tables, footnotes; its *PDF-export tool alone* requires local Microsoft Word — the rest works everywhere |
| **Create/edit pptx** | office-powerpoint-mcp-server connector | slide creation/editing, template-preserving |
| **Create/merge/split PDF** | no trusted connector exists (ecosystem gap) | write a small Python script with `reportlab` / `pypdf` (see below) |

All three writer connectors run via `uvx` (Python fetched at first run) — they work the same on
macOS and Windows, and none of them needs Microsoft Office installed (single exception noted
above).

## If the connector is not installed

Check your tool list first. If the needed tools are absent:

1. Point the user to the **Extension Hub (定制中心) → 连接器 → 办公**, or the 办公套件 bundle,
   for one-click install (first run downloads from PyPI — may take a minute).
2. As a fallback — only with the user's consent to run code — write a local Python script using
   the same underlying libraries: `openpyxl` (xlsx), `python-docx` (docx), `python-pptx` (pptx).
   These are BSD/MIT-licensed and installable with `uv pip` / `pip`.
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
user wants the PDF: local Word conversion (Windows + Word only), printing to PDF manually, or a
reportlab re-render — each has different fidelity; don't silently pick one.

## Output location

Write files where the user says; in a project, prefer the project directory. With no project
context, follow the `~/Alpha` workspace conventions (deliverables are user-visible files — never
write into `.alpha/`).
