#!/usr/bin/env python3
"""#1227 —— 把仓内真实生成器产出的 part 字节套上 OPC 外壳,打成可被 detectOoxmlContainer
消费的真容器。part 一个字符都不改;本脚本只负责装箱。

    python3 make-containers.py     # 就地重写三个 .bin 容器

不用 @zip.js 在测试里现打包的原因:渲染层用例跑在 happy-dom 全局下,zip.js 的 writer 会踩
happy-dom 的只读 TransformStream(`writable.size` 只读)。装箱是一次性的、与被测行为无关的
准备工作,放进夹具比放进测试运行时更诚实,也让用例只读字节。

⚠️ 装箱时对 part 做**两处 XML infoset 等价改写**,与 office-text.test.ts 的 compensateHappyDom
逐条相同、原因也相同 —— 都是 happy-dom(bun test 的 DOM)已探明的解析缺陷,生产 Chromium
两处都没有:
  1. XML 声明里的单引号(lxml/py-docx 的产物)被 happy-dom 判为 parsererror ⇒ 声明内引号归一;
  2. 同一元素上 localName 相同、未加前缀者在前的两个属性(真实 presentation.xml 的
     `<p:sldId id=".." r:id="..">`)会被 happy-dom 丢掉后者 ⇒ 交换属性序。
改写只动这两处,元素/文本/命名空间一律原样;真 Chromium 的实体与 DOCTYPE 行为证据归 #1177。
"""
import base64, io, os, re, zipfile, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

SPECS = {
    "report.docx.b64": ("office-text/py-docx", "word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"),
    "deck.pptx.b64": ("office-text/py-pptx", "ppt/presentation.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"),
    "book.xlsx.b64": ("xlsx/xlsxwriter", "xl/workbook.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"),
}

def content_types(main_part, ct):
    return ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="%s">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/%s" ContentType="%s"/></Types>' % (CT_NS, main_part, ct))

def root_rels(main_part):
    return ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="%s">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="%s"/></Relationships>' % (REL_NS, main_part))

def compensate_happy_dom(raw):
    text = raw.decode("utf-8")
    text = re.sub(r"^<\?xml[^?]*\?>", lambda m: m.group(0).replace("'", '"'), text)
    text = re.sub(r'<p:sldId id="([^"]+)" r:id="([^"]+)"', r'<p:sldId r:id="\2" id="\1"', text)
    return text.encode("utf-8")


for out_name, (src, main_part, ct) in SPECS.items():
    root = os.path.join(HERE, "..", src)
    names = []
    for dirpath, _dirs, files in os.walk(root):
        for f in sorted(files):
            if f.endswith(".xml") or f.endswith(".rels"):
                abs_p = os.path.join(dirpath, f)
                names.append((os.path.relpath(abs_p, root).replace(os.sep, "/"), abs_p))
    names.sort()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types(main_part, ct))
        z.writestr("_rels/.rels", root_rels(main_part))
        for rel, abs_p in names:
            with open(abs_p, "rb") as fh:
                z.writestr(rel, compensate_happy_dom(fh.read()))
    raw = buf.getvalue()
    # 落 base64 而不是裸 zip:仓里的 NUL 字节闸(scripts/assert-no-nul-bytes.py)默认拒绝
    # 未登记的二进制格式,而那道闸守的正是「grep 遇到 NUL 会静默返回空」这个观测缺陷。
    # 为三个夹具去登记一个 `.bin` 这种什么都能叫的扩展名,等于把门开得比需要的宽得多;
    # base64 让夹具是纯文本、可 grep、可 diff,代价只有 1/3 体积。
    out = os.path.join(HERE, out_name)
    with open(out, "w", encoding="ascii") as fh:
        fh.write("\n".join(base64.b64encode(raw).decode("ascii")[i:i + 76]
                            for i in range(0, len(base64.b64encode(raw)), 76)))
        fh.write("\n")
    print(out_name, len(raw), "zip bytes,", len(names) + 2, "entries ->", os.path.getsize(out), "b64 bytes")
