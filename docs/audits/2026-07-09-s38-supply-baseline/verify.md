# S38 供给面基线批 — 自验证据(2026-07-09)

> 契约:[sprints/2026-07-09-s38-supply-baseline](../../sprints/2026-07-09-s38-supply-baseline/sprint.md)
> 载体:REQ-082(PR #170)· REQ-080(PR #170 + alpha-web PR #17)· REQ-079(PR #171,UI 亲验门待 GO)
> 环境:dev 窗口(vite localhost:5173,非陈旧 bundle;CDP 9222)+ 线上 catalog 端点 + 本机 uvx

## REQ-079 — Agent tab 撤原生平铺(CDP,dev)

| 图 | 断言 |
|---|---|
| 02-agents-tab-curated.png | 浏览面卡片 = `["问题定位(只读)","代码审查(只读)"]`,**hasNative=false**(build/plan/general/explore 零出现);callout 指路「已安装 → 内置」如实 |
| 03-search-build-no-native.png | 全局搜索 "build" 零 agent 卡命中(搜索面同口径) |
| 04-installed-governance.png | 治理面板 build/general/plan(agent)+ customize-opencode(skill,已禁)+ /init /review(command)行俱在 —— 原生管理入口零损失;已装退役三件套(dingtalk/feishu/yuque)仍可启停/卸载(REQ-081 语义不受影响) |

DOM 断言注记:脚本 `hasBuild` 正则跑在 body 全文上误报 false,以截图 04 为准(build 行可见)。

**观察(非本批引入,不阻塞)**:精选 agent 卡的来源 chip 显示「自建」(`source:"alpha"` → sourceAlpha 键复用),与「官方精选」心智有歧义;是否改文案随 curation-proposal 拍板一并定。

## REQ-080 — 办公三连(线上 + hub + 冒烟)

1. **线上端点实证**:`alphacodeone.com/catalog/v1/catalog.json` = v2026-07-09.2 / 27 条;
   mcp:excel(`uvx excel-mcp-server@0.1.8 stdio`)/ mcp:word(`uvx --from office-word-mcp-server@1.1.11 word_mcp_server`)/ mcp:powerpoint(`uvx --from office-powerpoint-mcp-server@2.0.7 ppt_mcp_server`);
   bundle:office v1.1.0 五件;**签名对 A 内置公钥 verify=true**。
2. **hub 可见 + 预检**(06-connectors-office-trio.png):连接器 tab「办公文档」组 4 卡(markitdown + 三连),三连带「社区 / 待核实 / 需 uv」chip —— 远程 catalog 下发→验签→渲染端到端通。
3. **钉版命令 stdio 冒烟 3/3**(本机 uvx,MCP initialize 握手):excel-mcp 1.28.1 / Word Document Server 3.4.4 / ppt-mcp-server 1.28.1 —— 上架命令均真实可跑(word/ppt 的 `--from` + entry point、excel 的 `stdio` 子命令为 README/pypi 实证,直接用包名会起不来)。

## REQ-082 — 出厂技能(旁证)

05-skills-tab.png / 01-hub-featured.png:hub 正常;cloud-dispatch/office-docs 为 skills.paths 注入的出厂件,dev 下随 reconcile 生效,factory-skills 单测 12/12(夹具自名单派生)。技能文案与 B 侧 schema 逐项对照源码(cloud-mcp.ts / cloud-contract.ts / pipelines.ts / schedules.ts),见 sprint 契约 gates。

## 真机批残单(BACKLOG 行内同账)

- REQ-082:登录态会话真派发一单 research(contract 过 B 侧 schema)+ 登出态诚实引导实测;
- REQ-080:hub 一键安装三连 + xlsx 真实创建一例(mac 必测);Windows 随 REQ-076 真机批同场;
- REQ-079:Agent tab 像素亲验(UI 亲验门,合并前用户 GO)。

## 拍板补丁(PR #172)— 来源 chip 消歧(2026-07-09 当日,用户拍板)

- 07-agents-chip-alpha-made.png:精选两卡 chip =「alpha 出品」(DOM 断言 `["alpha 出品","alpha 出品"]`);
- 08-connectors-filter-alpha-made.png:来源筛选 = 全部/官方/社区/**alpha 出品**;
- 「自建」收窄到用户自建 agent 用点(agentSelf 键;AgentCard pill / 详情来源行)。
- 精选清单提案三条同日照准(curation-proposal.md 拍板记录)。
