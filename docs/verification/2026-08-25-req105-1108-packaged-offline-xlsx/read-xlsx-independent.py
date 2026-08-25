#!/usr/bin/env python3
"""REQ-105 AC4 / alpha-code#1108 —— C2 的**独立读取路径**。

写入侧是产品的 Alpha Excel MCP(openpyxl 3.1.5)。本读取器**刻意不用 openpyxl**:
它只用 CPython 标准库 zipfile + xml.etree 直接解 OOXML,所以「写得对」与「读得对」
不共享任何实现。期望值全部来自 fixture/xlsx-contract.json(独立锚点文件),
**不从被测 xlsx 反推**。

用法:
  python3 read-xlsx-independent.py --xlsx <file> --contract <contract.json> [--json-out <path>]

退出码:0 = 全部断言通过;1 = 有断言失败;2 = 无法读取/不是 xlsx。
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

NS_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_REL_DOC = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
NS_PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"


class Unreadable(Exception):
    pass


def _text(node) -> str:
    return "".join(node.itertext())


def _as_number(raw):
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        try:
            return float(raw)
        except ValueError:
            return raw


def read_workbook(path: str) -> dict:
    """Return {"sheetNamesInOrder": [...], "worksheetParts": n, "cells": {"Sheet!A1": (kind, value)}}."""
    if "openpyxl" in sys.modules:
        raise Unreadable("openpyxl is loaded — this reader must stay independent of the write path")
    try:
        zf = zipfile.ZipFile(path)
    except Exception as exc:  # noqa: BLE001
        raise Unreadable(f"not a readable zip/xlsx container: {exc}") from exc
    with zf:
        names = set(zf.namelist())
        if "xl/workbook.xml" not in names:
            raise Unreadable("missing xl/workbook.xml — not a SpreadsheetML package")

        rels = {}
        if "xl/_rels/workbook.xml.rels" in names:
            for rel in ET.fromstring(zf.read("xl/_rels/workbook.xml.rels")):
                if rel.tag == f"{NS_PKG_REL}Relationship":
                    rels[rel.attrib["Id"]] = rel.attrib["Target"]

        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            for si in ET.fromstring(zf.read("xl/sharedStrings.xml")):
                if si.tag == f"{NS_MAIN}si":
                    shared.append(_text(si))

        wb = ET.fromstring(zf.read("xl/workbook.xml"))
        sheets = []
        for sheet in wb.iter(f"{NS_MAIN}sheet"):
            target = rels.get(sheet.attrib.get(f"{NS_REL_DOC}id", ""), "")
            # OOXML rel targets are either package-absolute ("/xl/worksheets/sheet1.xml") or
            # relative to xl/ ("worksheets/sheet1.xml"). Normalise both to a zip entry name.
            stripped = target.lstrip("/")
            part = stripped if stripped.startswith("xl/") else "xl/" + stripped
            sheets.append((sheet.attrib.get("name", ""), part))

        cells: dict[str, tuple[str, object]] = {}
        worksheet_parts = 0
        for name, part in sheets:
            if part not in names:
                continue
            worksheet_parts += 1
            ws = ET.fromstring(zf.read(part))
            for c in ws.iter(f"{NS_MAIN}c"):
                ref = c.attrib.get("r")
                if not ref:
                    continue
                ctype = c.attrib.get("t")
                v = c.find(f"{NS_MAIN}v")
                is_node = c.find(f"{NS_MAIN}is")
                if ctype == "s":
                    idx = int(v.text) if v is not None and v.text is not None else -1
                    kind, value = "string", (shared[idx] if 0 <= idx < len(shared) else None)
                elif ctype == "inlineStr":
                    kind, value = "string", (_text(is_node) if is_node is not None else None)
                elif ctype == "str":
                    kind, value = "string", (v.text if v is not None else None)
                elif ctype == "b":
                    kind, value = "boolean", (v is not None and v.text == "1")
                elif ctype == "n":
                    kind, value = "number", _as_number(v.text if v is not None else None)
                elif ctype == "e":
                    kind, value = "error", (v.text if v is not None else None)
                elif v is not None and v.text is not None:
                    raw = v.text
                    try:
                        num = int(raw)
                    except ValueError:
                        try:
                            num = float(raw)
                        except ValueError:
                            kind, value = "string", raw
                        else:
                            kind, value = "number", num
                    else:
                        kind, value = "number", num
                else:
                    continue
                cells[f"{name}!{ref}"] = (kind, value)

        return {
            "sheetNamesInOrder": [name for name, _ in sheets],
            "worksheetParts": worksheet_parts,
            "zipEntries": sorted(names),
            "cells": cells,
        }


def check(xlsx: str, contract: dict) -> dict:
    checks: list[dict] = []

    def record(cid: str, ok: bool, detail: str) -> None:
        checks.append({"id": cid, "ok": bool(ok), "detail": detail})

    try:
        wb = read_workbook(xlsx)
    except Unreadable as exc:
        record("readable", False, str(exc))
        return {"xlsx": xlsx, "ok": False, "checks": checks}
    record("readable", True, f"{wb['worksheetParts']} worksheet part(s), {len(wb['cells'])} populated cell(s)")

    expect = contract["expect"]

    got_names = wb["sheetNamesInOrder"]
    want_names = expect["sheetNamesInOrder"]
    record("sheetNamesInOrder", got_names == want_names, f"want={want_names} got={got_names}")

    absent = [n for n in expect["absentSheetNames"] if n in got_names]
    record("absentSheetNames", not absent, f"unexpectedly present={absent}")

    record(
        "worksheetPartCount",
        wb["worksheetParts"] == expect["worksheetPartCount"],
        f"want={expect['worksheetPartCount']} got={wb['worksheetParts']}",
    )

    missing_entries = [e for e in expect["zipEntriesPresent"] if e not in wb["zipEntries"]]
    record("zipEntriesPresent", not missing_entries, f"missing={missing_entries}")

    for ref, want in expect["cellValues"].items():
        got = wb["cells"].get(ref)
        got_value = got[1] if got else None
        # bool must not be satisfied by 1/0, and numbers must not be satisfied by "1108"
        ok = got is not None and type(got_value) is type(want) and got_value == want
        record(f"cell:{ref}", ok, f"want={want!r}({type(want).__name__}) got={got_value!r}({type(got_value).__name__})")

    for ref, want_kind in expect["cellKinds"].items():
        got = wb["cells"].get(ref)
        got_kind = got[0] if got else None
        record(f"kind:{ref}", got_kind == want_kind, f"want={want_kind} got={got_kind}")

    return {"xlsx": xlsx, "ok": all(c["ok"] for c in checks), "checks": checks}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--json-out")
    args = ap.parse_args()

    with open(args.contract, encoding="utf-8") as fh:
        contract = json.load(fh)

    result = check(args.xlsx, contract)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            fh.write(payload + "\n")
    print(payload)
    failed = [c["id"] for c in result["checks"] if not c["ok"]]
    if not result["ok"]:
        print(f"FAIL: {len(failed)} check(s) red: {failed}", file=sys.stderr)
        return 1
    print(f"PASS: {len(result['checks'])} check(s) green", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
