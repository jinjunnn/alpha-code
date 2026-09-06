#!/usr/bin/env python3
"""Alpha first-party Office MCP server (stdio only).

One bundled server exposes a narrow tool pair for the selected file format. The
host supplies both the format and a canonical workspace directory on argv; tool
callers can only pass absolute paths below that directory.
"""

from __future__ import annotations

from datetime import datetime, timezone
from html import escape
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any, Callable


PROTOCOL_VERSION = "2025-06-18"
SERVER_VERSION = "1.1.0"
FORMATS = {"word", "excel", "powerpoint", "pdf"}
EXTENSIONS = {"word": ".docx", "excel": ".xlsx", "powerpoint": ".pptx", "pdf": ".pdf"}

# REQ-155 #1245 — write_docx typography surface. Only layout fields: no path / command / URL inputs
# beyond the workspace-bound `path` every tool already takes (REQ-133 §3.6).
DOCX_PAGE_SIZES_MM: dict[str, tuple[float, float]] = {"A4": (210.0, 297.0), "Letter": (215.9, 279.4)}
DOCX_DEFAULT_PAGE_SIZE = "A4"
DOCX_DEFAULT_MARGIN_MM = 25.4
DOCX_MAX_MARGIN_MM = 100.0
# Owner writes Chinese documents; the python-docx template leaves the theme's East Asian typeface
# empty, so CJK text falls back to whatever the viewer picks. 宋体 is the template's own `Hans` script
# mapping, so it is consistent with what the theme already declares for that script.
DOCX_DEFAULT_EAST_ASIA_FONT = "宋体"
DOCX_MAX_HEADING_LEVEL = 9
DOCX_FONT_NAME_RE = re.compile(r"^[^\x00-\x1f\x7f<>&\"']{1,64}$")


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in FORMATS:
        print("usage: server.py <word|excel|powerpoint|pdf> <absolute-workspace>; stdio is the only transport", file=sys.stderr)
        return 2

    workspace_arg = argv[2]
    if not is_absolute_path(workspace_arg) or has_traversal(workspace_arg):
        print("workspace must be an absolute path without '..' segments", file=sys.stderr)
        return 2

    try:
        workspace = Path(workspace_arg).resolve(strict=True)
    except OSError:
        print("workspace must be an existing directory", file=sys.stderr)
        return 2
    if not workspace.is_dir():
        print("workspace must be an existing directory", file=sys.stderr)
        return 2

    for line in sys.stdin:
        if not line.strip():
            continue
        message: Any = None
        try:
            message = json.loads(line)
            response = handle_message(argv[1], workspace, message)
        except Exception as error:
            request_id = message.get("id") if isinstance(message, dict) else None
            response = error_response(request_id, -32603, str(error))
        if response is not None:
            print(json.dumps(response, ensure_ascii=False, default=str), flush=True)
    return 0


def handle_message(format_name: str, workspace: Path, message: Any) -> dict[str, Any] | None:
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return error_response(message.get("id") if isinstance(message, dict) else None, -32600, "invalid JSON-RPC request")

    method = message.get("method")
    request_id = message.get("id")
    if method == "notifications/initialized":
        return None
    if method == "initialize":
        return success_response(
            request_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": f"alpha-office-{format_name}", "version": SERVER_VERSION},
            },
        )
    if method == "ping":
        return success_response(request_id, {})
    if method == "tools/list":
        return success_response(request_id, {"tools": tools_for(format_name)})
    if method == "tools/call":
        params = message.get("params")
        if not isinstance(params, dict) or not isinstance(params.get("name"), str):
            return error_response(request_id, -32602, "tools/call requires a tool name")
        arguments = params.get("arguments", {})
        if not isinstance(arguments, dict):
            return error_response(request_id, -32602, "tool arguments must be an object")
        try:
            result = call_tool(format_name, workspace, params["name"], arguments)
            return success_response(
                request_id,
                {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, default=str)}]},
            )
        except Exception as error:
            return success_response(
                request_id,
                {"content": [{"type": "text", "text": str(error)}], "isError": True},
            )
    if request_id is None:
        return None
    return error_response(request_id, -32601, f"method not found: {method}")


def tools_for(format_name: str) -> list[dict[str, Any]]:
    path_property = {"path": {"type": "string", "description": "Absolute path inside the granted workspace"}}
    if format_name == "word":
        return [
            tool("read_docx", "Read paragraphs and tables from a Word document", path_property, ["path"]),
            tool(
                "write_docx",
                "Create, replace, or append to a Word document: title, body paragraphs, multi-level "
                "headings, tables, page size/margins (A4 default) and fonts (East Asian font set by default). "
                "Unknown fields are refused, never silently dropped.",
                {
                    **path_property,
                    "title": {"type": "string", "description": "Document title (Title style), written before the blocks"},
                    "paragraphs": {
                        "type": "array",
                        "description": "Document body in order. A bare string is a body paragraph; use heading "
                        "blocks for section titles (e.g. 一、总体情况) instead of body text.",
                        "items": {
                            "oneOf": [
                                {"type": "string"},
                                {
                                    "type": "object",
                                    "properties": {"type": {"const": "paragraph"}, "text": {"type": "string"}},
                                    "required": ["type", "text"],
                                    "additionalProperties": False,
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "type": {"const": "heading"},
                                        "text": {"type": "string"},
                                        "level": {"type": "integer", "minimum": 1, "maximum": DOCX_MAX_HEADING_LEVEL},
                                    },
                                    "required": ["type", "text", "level"],
                                    "additionalProperties": False,
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "type": {"const": "table"},
                                        "rows": {
                                            "type": "array",
                                            "minItems": 1,
                                            "description": "Rectangular grid of cell strings; row 0 is the header when header=true",
                                            "items": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                                        },
                                        "header": {"type": "boolean", "default": True},
                                    },
                                    "required": ["type", "rows"],
                                    "additionalProperties": False,
                                },
                            ]
                        },
                    },
                    "append": {"type": "boolean", "default": False},
                    "page": {
                        "type": "object",
                        "description": "Page geometry. New documents default to A4 portrait with 25.4 mm margins; "
                        "when appending, page is only changed if this field is given (then unspecified margins reset to 25.4 mm).",
                        "properties": {
                            "size": {"type": "string", "enum": sorted(DOCX_PAGE_SIZES_MM), "default": DOCX_DEFAULT_PAGE_SIZE},
                            "orientation": {"type": "string", "enum": ["portrait", "landscape"], "default": "portrait"},
                            "margins": {
                                "type": "object",
                                "description": "Millimetres, 0–100",
                                "properties": {side: {"type": "number", "minimum": 0, "maximum": DOCX_MAX_MARGIN_MM} for side in ("top", "bottom", "left", "right")},
                                "additionalProperties": False,
                            },
                        },
                        "additionalProperties": False,
                    },
                    "font": {
                        "type": "object",
                        "description": "Document-default fonts. New documents always get an East Asian font "
                        f"({DOCX_DEFAULT_EAST_ASIA_FONT} unless eastAsia is given); when appending, fonts only change if this field is given.",
                        "properties": {
                            "eastAsia": {"type": "string", "description": "CJK font family, e.g. 宋体 / 黑体 / 微软雅黑"},
                            "latin": {"type": "string", "description": "Latin font family, e.g. Times New Roman"},
                            "size": {"type": "number", "minimum": 6, "maximum": 72, "description": "Body text size in points"},
                        },
                        "additionalProperties": False,
                    },
                },
                ["path", "paragraphs"],
            ),
        ]
    if format_name == "excel":
        return [
            tool("read_xlsx", "Read cell values from every worksheet in an Excel workbook", path_property, ["path"]),
            tool(
                "write_xlsx",
                "Create a workbook or update addressed cells in an existing workbook",
                {
                    **path_property,
                    "sheets": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "cells": {"type": "object", "additionalProperties": True},
                            },
                            "required": ["name", "cells"],
                            "additionalProperties": False,
                        },
                    },
                },
                ["path", "sheets"],
            ),
        ]
    if format_name == "powerpoint":
        return [
            tool("read_pptx", "Read text from every slide in a PowerPoint deck", path_property, ["path"]),
            tool(
                "write_pptx",
                "Create, replace, or append text slides in a PowerPoint deck",
                {
                    **path_property,
                    "slides": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "body": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]},
                            },
                            "required": ["title", "body"],
                            "additionalProperties": False,
                        },
                    },
                    "append": {"type": "boolean", "default": False},
                },
                ["path", "slides"],
            ),
        ]
    return [
        tool("read_pdf", "Extract the text layer from every PDF page", path_property, ["path"]),
        tool(
            "write_pdf",
            "Generate a text PDF, replace its text document, or append text pages",
            {
                **path_property,
                "pages": {"type": "array", "items": {"type": "string"}},
                "mode": {"type": "string", "enum": ["replace", "append"], "default": "replace"},
            },
            ["path", "pages"],
        ),
    ]


def tool(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
    }


def call_tool(format_name: str, workspace: Path, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    handlers: dict[str, dict[str, Callable[[Path, dict[str, Any]], dict[str, Any]]]] = {
        "word": {"read_docx": read_docx, "write_docx": write_docx},
        "excel": {"read_xlsx": read_xlsx, "write_xlsx": write_xlsx},
        "powerpoint": {"read_pptx": read_pptx, "write_pptx": write_pptx},
        "pdf": {"read_pdf": read_pdf, "write_pdf": write_pdf},
    }
    handler = handlers[format_name].get(name)
    if handler is None:
        raise ValueError(f"unknown {format_name} tool: {name}")
    declared = next(spec for spec in tools_for(format_name) if spec["name"] == name)
    # #1245: every tool schema declares additionalProperties:false; enforce it here so an argument
    # the tool cannot honour is refused instead of accepted-and-dropped (a success that lies).
    reject_unknown_keys(arguments, declared["inputSchema"]["properties"].keys(), name)
    path = require_workspace_path(workspace, arguments.get("path"), EXTENSIONS[format_name])
    return handler(path, arguments)


def require_workspace_path(workspace: Path, raw: Any, extension: str) -> Path:
    if not isinstance(raw, str) or not raw:
        raise ValueError("path must be a non-empty string")
    if not is_absolute_path(raw):
        raise ValueError("path must be absolute")
    if has_traversal(raw):
        raise ValueError("path traversal ('..') is not allowed")
    candidate = Path(raw)
    if candidate.suffix.lower() != extension:
        raise ValueError(f"path must end in {extension}")
    resolved = candidate.resolve(strict=False)
    if os.path.commonpath((str(workspace), str(resolved))) != str(workspace):
        raise ValueError("path is outside the granted workspace")
    return resolved


def is_absolute_path(value: str) -> bool:
    normalized = value.replace("\\", "/")
    return normalized.startswith("/") or (len(normalized) >= 3 and normalized[0].isalpha() and normalized[1:3] == ":/")


def has_traversal(value: str) -> bool:
    return ".." in value.replace("\\", "/").split("/")


def read_docx(path: Path, _: dict[str, Any]) -> dict[str, Any]:
    require_existing(path)
    from docx import Document

    document = Document(path)
    return {
        "path": str(path),
        "paragraphs": [paragraph.text for paragraph in document.paragraphs],
        "tables": [
            [[cell.text for cell in row.cells] for row in table.rows]
            for table in document.tables
        ],
    }


def write_docx(path: Path, arguments: dict[str, Any]) -> dict[str, Any]:
    from docx import Document

    # Validate everything before touching the file: a refused call must leave no product behind.
    blocks = parse_docx_blocks(arguments.get("paragraphs"))
    append = arguments.get("append", False)
    if not isinstance(append, bool):
        raise ValueError("append must be a boolean")
    title = arguments.get("title")
    if title is not None and not isinstance(title, str):
        raise ValueError("title must be a string")
    page = parse_docx_page(arguments.get("page"))
    font = parse_docx_font(arguments.get("font"))

    existing = append and path.exists()
    document = Document(path) if existing else Document()
    # New documents always get deterministic geometry and an East Asian font. An appended document keeps
    # whatever it had unless the caller asks explicitly.
    applied_page = apply_docx_page(document, page or {}) if (not existing or page is not None) else None
    applied_font = apply_docx_fonts(document, font or {}) if (not existing or font is not None) else None

    if title is not None:
        document.add_heading(title, level=0)
    counts = {"paragraph": 0, "heading": 0, "table": 0}
    for block in blocks:
        kind = block["type"]
        if kind == "paragraph":
            document.add_paragraph(block["text"])
        elif kind == "heading":
            document.add_heading(block["text"], level=block["level"])
        else:
            render_docx_table(document, block["rows"], block["header"])
        counts[kind] += 1

    now = datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None)
    if not existing:
        document.core_properties.created = now
    document.core_properties.modified = now
    replace_file(path, document.save)
    return {
        "path": str(path),
        "paragraphsWritten": counts["paragraph"],
        "headingsWritten": counts["heading"],
        "tablesWritten": counts["table"],
        "appended": append,
        "page": applied_page,
        "font": applied_font,
    }


def reject_unknown_keys(arguments: dict[str, Any], allowed: Any, label: str) -> None:
    unknown = sorted(str(key) for key in arguments if key not in allowed)
    if unknown:
        raise ValueError(f"{label} does not accept: {', '.join(unknown)} (accepted: {', '.join(sorted(allowed))})")


def parse_docx_blocks(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("paragraphs must be an array of strings or block objects")
    blocks: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        label = f"paragraphs[{index}]"
        if isinstance(item, str):
            blocks.append({"type": "paragraph", "text": item})
            continue
        if not isinstance(item, dict):
            raise ValueError(f"{label} must be a string or a block object")
        kind = item.get("type")
        if kind == "paragraph":
            reject_unknown_keys(item, {"type", "text"}, label)
            blocks.append({"type": "paragraph", "text": require_string(item.get("text"), f"{label}.text")})
        elif kind == "heading":
            reject_unknown_keys(item, {"type", "text", "level"}, label)
            level = item.get("level")
            if isinstance(level, bool) or not isinstance(level, int) or not 1 <= level <= DOCX_MAX_HEADING_LEVEL:
                raise ValueError(f"{label}.level must be an integer from 1 to {DOCX_MAX_HEADING_LEVEL}")
            blocks.append({"type": "heading", "text": require_string(item.get("text"), f"{label}.text"), "level": level})
        elif kind == "table":
            reject_unknown_keys(item, {"type", "rows", "header"}, label)
            rows = item.get("rows")
            if not isinstance(rows, list) or not rows:
                raise ValueError(f"{label}.rows must be a non-empty array of rows")
            width: int | None = None
            for row_index, row in enumerate(rows):
                cells = require_string_list(row, f"{label}.rows[{row_index}]")
                if not cells:
                    raise ValueError(f"{label}.rows[{row_index}] must have at least one cell")
                if width is None:
                    width = len(cells)
                elif len(cells) != width:
                    raise ValueError(f"{label}.rows must be rectangular: row {row_index} has {len(cells)} cells, row 0 has {width}")
            header = item.get("header", True)
            if not isinstance(header, bool):
                raise ValueError(f"{label}.header must be a boolean")
            blocks.append({"type": "table", "rows": rows, "header": header})
        else:
            raise ValueError(f"{label}.type must be paragraph, heading, or table")
    return blocks


def parse_docx_page(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("page must be an object")
    reject_unknown_keys(value, {"size", "orientation", "margins"}, "page")
    size = value.get("size", DOCX_DEFAULT_PAGE_SIZE)
    if size not in DOCX_PAGE_SIZES_MM:
        raise ValueError(f"page.size must be one of {', '.join(sorted(DOCX_PAGE_SIZES_MM))}")
    orientation = value.get("orientation", "portrait")
    if orientation not in {"portrait", "landscape"}:
        raise ValueError("page.orientation must be portrait or landscape")
    margins_in = value.get("margins", {})
    if not isinstance(margins_in, dict):
        raise ValueError("page.margins must be an object")
    reject_unknown_keys(margins_in, {"top", "bottom", "left", "right"}, "page.margins")
    margins: dict[str, float] = {}
    for side in ("top", "bottom", "left", "right"):
        raw = margins_in.get(side, DOCX_DEFAULT_MARGIN_MM)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not 0 <= raw <= DOCX_MAX_MARGIN_MM:
            raise ValueError(f"page.margins.{side} must be a number of millimetres from 0 to {DOCX_MAX_MARGIN_MM:g}")
        margins[side] = float(raw)
    return {"size": size, "orientation": orientation, "margins": margins}


def parse_docx_font(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("font must be an object")
    reject_unknown_keys(value, {"eastAsia", "latin", "size"}, "font")
    font: dict[str, Any] = {}
    for key in ("eastAsia", "latin"):
        if key in value:
            name = value[key]
            if not isinstance(name, str) or not DOCX_FONT_NAME_RE.match(name):
                raise ValueError(f"font.{key} must be a font family name (1-64 printable characters)")
            font[key] = name
    if "size" in value:
        size = value["size"]
        if isinstance(size, bool) or not isinstance(size, (int, float)) or not 6 <= size <= 72:
            raise ValueError("font.size must be a number of points from 6 to 72")
        font["size"] = float(size)
    return font


def apply_docx_page(document: Any, page: dict[str, Any]) -> dict[str, Any]:
    from docx.enum.section import WD_ORIENT
    from docx.shared import Mm

    size = page.get("size", DOCX_DEFAULT_PAGE_SIZE)
    orientation = page.get("orientation", "portrait")
    margins = page.get("margins") or {side: DOCX_DEFAULT_MARGIN_MM for side in ("top", "bottom", "left", "right")}
    width_mm, height_mm = DOCX_PAGE_SIZES_MM[size]
    if orientation == "landscape":
        width_mm, height_mm = height_mm, width_mm
    section = document.sections[-1]
    section.orientation = WD_ORIENT.LANDSCAPE if orientation == "landscape" else WD_ORIENT.PORTRAIT
    section.page_width = Mm(width_mm)
    section.page_height = Mm(height_mm)
    for side, value in margins.items():
        setattr(section, f"{side}_margin", Mm(value))
    return {"size": size, "orientation": orientation, "marginsMm": margins}


def apply_docx_fonts(document: Any, font: dict[str, Any]) -> dict[str, Any]:
    """Set document-default fonts in the two places Word consults.

    1. theme1.xml: the template's major/minor `<a:ea typeface="">` is empty, and every style in the
       template references fonts by theme (`w:eastAsiaTheme`), so this is what leaves CJK text with no
       font at all. python-docx exposes the theme only as a raw part, so it is patched as XML text.
    2. styles.xml docDefaults: an explicit `w:eastAsia` (and `w:ascii`/`w:hAnsi` when latin is given).
       A theme attribute wins over its explicit sibling, so the theme attribute is removed when the
       explicit one is written.
    """
    from docx.oxml.ns import qn

    east_asia = font.get("eastAsia", DOCX_DEFAULT_EAST_ASIA_FONT)
    latin = font.get("latin")
    size = font.get("size")

    theme = next((part for part in document.part.package.iter_parts() if str(part.partname).endswith("/theme/theme1.xml")), None)
    if theme is not None:
        xml = theme.blob.decode("utf-8")
        xml = re.sub(r'(<a:ea typeface=")[^"]*(")', lambda m: f"{m.group(1)}{escape(east_asia, quote=True)}{m.group(2)}", xml)
        if latin:
            xml = re.sub(r'(<a:latin typeface=")[^"]*(")', lambda m: f"{m.group(1)}{escape(latin, quote=True)}{m.group(2)}", xml)
        theme._blob = xml.encode("utf-8")

    styles = document.styles.element
    defaults = ensure_child(styles, "w:docDefaults")
    rpr_default = ensure_child(defaults, "w:rPrDefault")
    rpr = ensure_child(rpr_default, "w:rPr")
    rfonts = ensure_child(rpr, "w:rFonts")
    for attribute in ("w:eastAsiaTheme",):
        if rfonts.get(qn(attribute)) is not None:
            del rfonts.attrib[qn(attribute)]
    rfonts.set(qn("w:eastAsia"), east_asia)
    if latin:
        for attribute in ("w:asciiTheme", "w:hAnsiTheme"):
            if rfonts.get(qn(attribute)) is not None:
                del rfonts.attrib[qn(attribute)]
        rfonts.set(qn("w:ascii"), latin)
        rfonts.set(qn("w:hAnsi"), latin)
    lang = ensure_child(rpr, "w:lang")
    lang.set(qn("w:eastAsia"), "zh-CN")
    if size is not None:
        half_points = str(int(round(size * 2)))
        for tag in ("w:sz", "w:szCs"):
            ensure_child(rpr, tag).set(qn("w:val"), half_points)

    applied: dict[str, Any] = {"eastAsia": east_asia}
    if latin:
        applied["latin"] = latin
    if size is not None:
        applied["size"] = size
    return applied


def ensure_child(parent: Any, tag: str) -> Any:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    child = parent.find(qn(tag))
    if child is None:
        child = OxmlElement(tag)
        parent.append(child)
    return child


def render_docx_table(document: Any, rows: list[list[str]], header: bool) -> None:
    table = document.add_table(rows=len(rows), cols=len(rows[0]))
    try:
        table.style = document.styles["Table Grid"]
    except KeyError:
        pass  # a foreign document being appended to may lack the template style; the grid is still a table
    for row_index, row in enumerate(rows):
        for column_index, value in enumerate(row):
            cell = table.cell(row_index, column_index)
            cell.text = value
            if header and row_index == 0:
                for paragraph in cell.paragraphs:
                    for run in paragraph.runs:
                        run.font.bold = True


def require_string(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string")
    return value


def read_xlsx(path: Path, _: dict[str, Any]) -> dict[str, Any]:
    require_existing(path)
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=False)
    return {
        "path": str(path),
        "sheets": [
            {"name": sheet.title, "rows": [list(row) for row in sheet.iter_rows(values_only=True)]}
            for sheet in workbook.worksheets
        ],
    }


def write_xlsx(path: Path, arguments: dict[str, Any]) -> dict[str, Any]:
    from openpyxl import Workbook, load_workbook

    sheets = arguments.get("sheets")
    if not isinstance(sheets, list) or not sheets:
        raise ValueError("sheets must be a non-empty array")
    workbook = load_workbook(path) if path.exists() else Workbook()
    created = not path.exists()
    touched: list[str] = []
    for item in sheets:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"]:
            raise ValueError("each sheet requires a non-empty name")
        cells = item.get("cells")
        if not isinstance(cells, dict):
            raise ValueError("each sheet requires a cells object")
        sheet = workbook[item["name"]] if item["name"] in workbook.sheetnames else workbook.create_sheet(item["name"])
        for coordinate, value in cells.items():
            if not isinstance(coordinate, str):
                raise ValueError("cell addresses must be strings")
            sheet[coordinate] = value
        touched.append(item["name"])
    if created and "Sheet" in workbook.sheetnames and "Sheet" not in touched and len(workbook.sheetnames) > 1:
        workbook.remove(workbook["Sheet"])
    replace_file(path, workbook.save)
    return {"path": str(path), "sheetsUpdated": touched}


def read_pptx(path: Path, _: dict[str, Any]) -> dict[str, Any]:
    require_existing(path)
    from pptx import Presentation

    presentation = Presentation(path)
    return {
        "path": str(path),
        "slides": [
            {
                "number": index,
                "text": [shape.text for shape in slide.shapes if hasattr(shape, "text") and shape.text],
            }
            for index, slide in enumerate(presentation.slides, start=1)
        ],
    }


def write_pptx(path: Path, arguments: dict[str, Any]) -> dict[str, Any]:
    from pptx import Presentation

    slides = arguments.get("slides")
    if not isinstance(slides, list) or not slides:
        raise ValueError("slides must be a non-empty array")
    append = arguments.get("append", False)
    if not isinstance(append, bool):
        raise ValueError("append must be a boolean")
    presentation = Presentation(path) if append and path.exists() else Presentation()
    for item in slides:
        if not isinstance(item, dict) or not isinstance(item.get("title"), str):
            raise ValueError("each slide requires a string title")
        body = item.get("body")
        if isinstance(body, list):
            body = "\n".join(require_string_list(body, "slide body"))
        if not isinstance(body, str):
            raise ValueError("each slide body must be a string or string array")
        slide = presentation.slides.add_slide(presentation.slide_layouts[1])
        slide.shapes.title.text = item["title"]
        slide.placeholders[1].text = body
    replace_file(path, presentation.save)
    return {"path": str(path), "slidesWritten": len(slides), "appended": append}


def read_pdf(path: Path, _: dict[str, Any]) -> dict[str, Any]:
    require_existing(path)
    from pypdf import PdfReader

    reader = PdfReader(path)
    return {"path": str(path), "pages": [page.extract_text() or "" for page in reader.pages]}


def write_pdf(path: Path, arguments: dict[str, Any]) -> dict[str, Any]:
    from pypdf import PdfWriter

    pages = require_string_list(arguments.get("pages"), "pages")
    if not pages:
        raise ValueError("pages must be non-empty")
    mode = arguments.get("mode", "replace")
    if mode not in {"replace", "append"}:
        raise ValueError("mode must be replace or append")
    if mode == "append":
        require_existing(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".pdf", dir=path.parent, delete=False) as temporary:
        generated = Path(temporary.name)
    merged: Path | None = None
    try:
        render_text_pdf(generated, pages)
        if mode == "replace":
            os.replace(generated, path)
        else:
            writer = PdfWriter()
            writer.append(path)
            writer.append(generated)
            with tempfile.NamedTemporaryFile(suffix=".pdf", dir=path.parent, delete=False) as output:
                merged = Path(output.name)
                writer.write(output)
            os.replace(merged, path)
    finally:
        generated.unlink(missing_ok=True)
        if merged is not None:
            merged.unlink(missing_ok=True)
    return {"path": str(path), "pagesWritten": len(pages), "mode": mode}


def render_text_pdf(path: Path, pages: list[str]) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    pdf = canvas.Canvas(str(path), pagesize=A4)
    _, height = A4
    for page in pages:
        text = pdf.beginText(54, height - 54)
        text.setFont("Helvetica", 11)
        for source_line in page.splitlines() or [""]:
            chunks = [source_line[index : index + 95] for index in range(0, len(source_line), 95)] or [""]
            for chunk in chunks:
                if text.getY() < 54:
                    pdf.drawText(text)
                    pdf.showPage()
                    text = pdf.beginText(54, height - 54)
                    text.setFont("Helvetica", 11)
                text.textLine(chunk)
        pdf.drawText(text)
        pdf.showPage()
    pdf.save()


def replace_file(path: Path, write: Callable[[Path], None]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=path.suffix, dir=path.parent, delete=False) as temporary:
        generated = Path(temporary.name)
    try:
        write(generated)
        os.replace(generated, path)
    except Exception:
        generated.unlink(missing_ok=True)
        raise


def require_string_list(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{name} must be an array of strings")
    return value


def require_existing(path: Path) -> None:
    if not path.is_file():
        raise ValueError(f"file does not exist: {path}")


def success_response(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
