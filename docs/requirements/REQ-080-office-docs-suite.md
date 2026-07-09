---
id: REQ-080
title: 办公文档能力上架 — xlsx/docx/pptx 写作 MCP 三连 + office-docs 出厂引导技能 + office 套件收口
type: feature
priority: P1
repo: X
created: 2026-07-09
status: shipped
source: 用户议题④(2026-07-09)+ 生态实查;用户拍板(2026-07-09):①按推荐上架 ②office-docs 引导技能入出厂内置
---

## 背景 · 生态实查结论(2026-07-09,GitHub/npm/pypi 逐项核验)

1. **Anthropic 官方四件(docx/pdf/pptx/xlsx)不可用,红线维持**:license 为 Proprietary,**禁再分发、禁衍生**(anthropics/skills 逐文件夹 LICENSE.txt 核验,与 catalog `_disclaimers` 既有判断一致);且假定沙箱预装 LibreOffice/pandoc + python + node 多运行时(xlsx 技能明文「You can assume LibreOffice is installed」)→ 终端用户机器(尤其 Windows 小白)不可行,预检也无法诚实放行。
2. 生态**无可信 Apache/MIT 重实现**(awesome 列表均指回 Anthropic 官方四件);**Codex 已有官方 skills 体系**(developers.openai.com/codex/skills,较上次核查的新变化)但无官方文档技能。
3. **MCP(uvx/npx 运行时拉取)是对小白唯一诚实的跨平台通道**:单一 bootstrap(uv 或 node)与既有 runtimeDep 预检模型匹配,双平台同命令,零再分发负担(ADR-023 npm 正源纪律)。
4. **PDF 创建生态空缺**:无可信写向 PDF MCP(最好的是只读或 <15★ 玩具,或带 AGPL 依赖)。

## 拍板记录(2026-07-09)

- ① 按推荐上架(三连 + 引导技能);② office-docs 引导技能**入出厂内置**;③ paperjsx 未点名 → **不上架,留 watchlist**(npx 全格式 JSON→doc 含 PDF 创建,MIT,但 0★/freemium 待熟)。

## 交付物

**C 侧(catalog-src,ADR-023/REQ-046 作者真源)新增 3 条 mcp(全部钉版 + runtimeDep=uv)**:

| 条目 | 包 | license | 能力 | 详情页须如实标注 |
|---|---|---|---|---|
| excel-mcp-server | `uvx excel-mcp-server`(pypi,haris-musa)| MIT(4.0k★)| xlsx 创建/编辑/公式/图表/透视,**免装 Excel**(openpyxl),Windows 文档明示 | — |
| office-word-mcp-server | `uvx office-word-mcp-server`(pypi,GongRzhe)| MIT(2.1k★)| docx 创建/编辑/样式/表格/脚注 | **PDF 转换工具需本机 MS Word**(docx2pdf/COM),仅该工具降级 |
| office-powerpoint-mcp-server | `uvx`(pypi,GongRzhe)| MIT | pptx 创建/编辑,32 工具,模板保留 | — |

**A 侧出厂技能 `office-docs`(alpha 自写,Apache-2.0)**:教连接器选型(何时用哪个 MCP)、xlsx 惯例(**重表达,不可抄 Anthropic 技能文本**;底层库 openpyxl/pypdf/reportlab 为 BSD/MIT 可正常引用)、PDF 创建缺口的 pypdf/reportlab 片段引导;经 `skills.paths` 随包注入(REQ-065 纯度通道,不落 `.alpha`)。

**套件收口**:`bundle:office` 补齐 = markitdown(已在架)+ filesystem + 新三连;引导技能出厂已有、详情页说明不重复装——兑现条目内 `_verify` 既有意向(「再补 openpyxl 系 Excel-MCP + 一页自写办公引导技能后加入」)。

## 验收标准

1. C 端点下发 3 新条目,hub 连接器 tab 可见、依赖预检(uv)正确、一键安装成功;
2. 双平台真实调用各 ≥1 例(xlsx 创建为必测;mac 本批实测,Windows 随 REQ-076 真机批同场);
3. office-docs 出厂技能会话内可用(自动装载 + `/office-docs` 显式触发),内容零 Anthropic 文本抄袭(license 审查);
4. bundle:office 扇出安装含新三连,逐项 receipts 记账;
5. 来源/license/`_verify` 如实展示(钉钉供应链教训:可审计性写清);快照刷新随下次 A 发版(runbook 既有步骤)。

## 非目标

- Anthropic 四件任何形式引入(license 红线);
- paperjsx 上架(watchlist,待熟再议);
- 自建 PDF 写 MCP(生态空缺不自建,引导技能片段补位);
- LibreOffice/pandoc 类重依赖方案(小白不可装);
- doc(.doc 旧格式)/一切需本机 Office 的主路径能力。

## 关联

- [[ADR-014]] §5(办公套件原始意向)· [[ADR-023]](npm 正源 / 分发分层)· [[REQ-046]](C 仓作者真源流程)· [[REQ-065]](出厂件纯度通道)· [[REQ-079]](精选清单)· [[REQ-081]](同批 C 侧动作)
