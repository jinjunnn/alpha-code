---
title: "cap:renderer-safety L2 矩阵 — #324 十格式五类路由 + 恶意 HTML/SVG fixture"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-19
review_after: 2026-10-19
---

# cap:renderer-safety L2 证据 — #324(2026-07-19)

归并 REQ-095/096 的 renderer 安全与恶意语料矩阵(capability = renderer safety)。证据分两层:
- **确定性单测**(routing / model-level sanitization / HTML preview 隔离契约)—— 逻辑面权威门,ui-mac
  全量 `2180 pass / 0 fail`(2026-07-19 复跑)。
- **真机 fixture**(CDP 9222,隔离 dev,基点 `a5613686`)—— 恶意 HTML/SVG/spoof 经生产 Workbench
  卡片路由,证 renderer 拒执行 + 主 renderer 零污染。

## 十格式 × 五类路由矩阵(确定性,`renderers/registry.test.ts`)

十 renderer 目标:markdown / json / csv / image / code / text / html / pdf / fallback(audio·video·office)/ svg→code。

| 类 | 覆盖 | 判定 | 证据 |
|---|---|---|---|
| 正常 | md/json/geojson/csv/tsv/png/webp/py/yaml/log/txt 各归其 renderer | PASS | `registry.test.ts:128`「常规格式覆盖」11 例 |
| 冲突(detected≠claimed) | detected 优先 + 诚实 warning chip | PASS | `registry.test.ts:29,77` |
| 冒充(spoof) | HTML 冒充 image → 检测 text/html 路由 html;检测无映射(zip)不回退 claimed/扩展名 | PASS | `registry.test.ts:50,85,91` |
| 恶意 | 带脚本 SVG 一律 code(源码只读,绝不 image-inline);text/html 所有来源终结 html 卡 | PASS | `registry.test.ts:97,107` |
| 未知/降级 | 无线索 → fallback 确定终点;audio/video/office → fallback 诚实外部打开 | PASS | `registry.test.ts:45,117` |

model 级净化(确定性):
- Markdown 恶意 corpus(script/SVG+foreignObject/事件属性/style 注入/mXSS 变体 → rawhtml 字面块零解释;
  javascript:/data:/相对 链接剥除;远程图默认不发请求)—— `markdown-model.test.ts:90`。
- CSV 公式字面保留(`=CMD`/`=HYPERLINK` 不求值不变形)—— `csv-model.test.ts:53`。
- JSON 原型污染防护(`__proto__`/constructor 为普通自有键,不污染原型)—— `json-model.test.ts:21`。
- HTML 预览门 `canPreviewHtml`(detected 唯一裁决;`text/html-evil` 前缀伪装不匹配)+ 静态 CSP 全 none 基线
  —— `shared/html-preview.test.ts`。
- HTML 隔离宿主(sandbox/contextIsolation/无 preload/一次性 in-memory partition/权限三面全拒/webRequest
  零网络/导航全拒/静态 CSP+nosniff/并发上限/关闭崩溃清理/零 token·URL 泄漏)—— `main/html-preview-host.test.ts`(30+ 例)。

## 真机恶意 fixture

| # | 项 | 判定 | 证据 |
|---|---|---|---|
| 1 | `page.html`(内联 `<script>`)→ html 卡片 + 隔离预览按钮,主 renderer 不执行脚本 | PASS | decisionChip=`html`、badge「隔离预览」、`activeScriptTags=0`、`mainPwned=null`、`mainTitle=alpha-code`(`324-safety.json` html);截图 `324-a-html-card.png` |
| 2 | `diagram.svg`(含 `<script>fetch(evil)`)→ 路由 code 源码只读,零活 SVG/script 元素 | PASS | decisionChip=`code`、面板显示 `<svg>…<script>` 字面文本、`liveScriptEls=0`(`324-safety.json` svg/svgSourceShown);截图 `324-b-svg-code.png` |
| 3 | `totally-a.png`(detected text/html 冒充 png)→ 路由 html + 冲突 warning,无 `<img>`,不执行 | PASS | decisionChip=`html`、warning「MIME 冲突:声明 image/png,检测 text/html —— 按检测结果路由」、`hasImgTag=false`、`mainPwned=null`(`324-safety.json` spoof);截图 `324-c-spoof-html.png` |
| 4 | 开隔离预览窗口 → opaque previewId,主 renderer 全程干净 | PASS | 「已在隔离窗口中打开」、无 error、`mainPwned=null`、`mainTitle=alpha-code`(`324-safety.json` openIsolated);截图 `324-d-isolated-open.png` |
| 5 | 全程主 renderer 完整性 | PASS | `__CAP_PWNED=null`、title 未改、URL 未变(`324-safety.json` mainRendererIntegrity) |

## 判定

十格式五类路由 + model 级净化 + HTML 隔离契约(单测权威门)与真机恶意 HTML/SVG/spoof fixture 全 PASS —— 
renderer-safety capability 在当前 alpha `a5613686` 成立。本票关闭(completed)。

注:REQ-095 父需求另有已开放 CODE 票承载尚未实现的 renderer 能力(PDF.js worker #296、image 预算 #297、
音视频原生 #295、可取消 range 流 #293、100MiB 虚拟化 #294),不在 renderer-**safety** 矩阵门内;大产物/内存/取消
基线由 #325 单独承载。
