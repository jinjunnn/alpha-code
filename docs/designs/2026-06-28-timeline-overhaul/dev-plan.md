# Timeline 全面优化 — 历史开发执行手册

> [!CAUTION]
> **冻结的历史执行记录(2026-07-11 cutover)。** 40 项实现清单不再由新
> session 直接执行或回勾；当前 characterization 与验收尾项由
> [alpha-code#214](https://github.com/jinjunnn/alpha-code/issues/214) 和
> [Alpha Delivery](https://github.com/users/jinjunnn/projects/2) 承载。历史
> 实现证据见 alpha-code PR [#15](https://github.com/jinjunnn/alpha-code/pull/15)
> 与 [#18](https://github.com/jinjunnn/alpha-code/pull/18)。

> 本文件保留 40 条优化的历史实施方法与验证证据；配套 `tasks.md` 同样冻结。
> 配套:`audit.md`(为什么)· `tasks.md`(做什么,40 条原子任务)· `timeline.html`(长什么样,设计稿)。

## 0. 一句话目标
把 opencode 时间线的 **40 个构件**(36 CSS / 3 INJECT / 1 ENGINE)全部换成 `timeline.html` 的 alpha 卡片语言,**零改 opencode 源码**(ADR-016/002/005),只追加 `timeline-reskin.css` / `timeline-inject.tsx`。

## 1. 开工前必读约束(硬规则)
- **只增不改 upstream**:绝不编辑 `packages/{ui,app,opencode}` 源码;只追加 alpha 自有文件。CI file-diff 守卫会拦(ADR-004/005)。
- **接缝**:纯换肤 → CSS;需建元素/解析 DOM → `timeline-inject.tsx` 的 MutationObserver(已有 `.a-tc-ico`/`.a-openp`/`.a-dirgrid`/`.a-cmd-chip` 先例);引擎(终端/diff/markdown)**不重写**,只换外框。
- **CSS 纪律**:只动 `color/background/border/radius/spacing/overflow` 与必要 flex;**不动 `display/position` 结构**(已有的 user-message/skill chip 是受控例外)。避免破上游布局。
- **耦合登记**:每加一组选择器,在 `timeline-reskin.css` 顶部「COUPLING」注释补登,供 upstream sync 时重指(ADR-015 合并验证)。

## 2. 环境 + CDP 验证回路(每条任务都要跑)
```bash
# ① 启动 dev app(自带 CDP，端口 9222)
cd /Users/tide/app/alpha-code/packages/ui-mac && ALPHA_CDP=1 bun run dev   # 后台跑
#   注意:必须 cd 进包目录;`bun --cwd <pkg> run dev` 在本机 bun 版本会只列脚本不执行。
#   ELECTRON_EXEC_PATH 由 scripts/launch.ts 自动解析。

# ② 类型守卫
cd /Users/tide/app/alpha-code/packages/ui-mac && bun run typecheck   # 须 EXIT=0

# ③ CDP 截图核验(把下面存成 cdp.mjs，用 bun 跑;bun 自带 WebSocket，无需装包)
#    bun cdp.mjs shot out.png         全页截图
#    bun cdp.mjs eval '<返回值的JS体>'  在页面里求值(导航/查 DOM)
```
`cdp.mjs`(自包含,复制即用):
```js
import fs from "node:fs"
const mode=process.argv[2], arg=process.argv[3]
const t=await (await fetch("http://localhost:9222/json")).json()
const p=t.find(x=>x.type==="page"&&x.webSocketDebuggerUrl); if(!p){console.error("no page");process.exit(1)}
const ws=new WebSocket(p.webSocketDebuggerUrl); let id=0; const pend=new Map()
const send=(m,pr={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:pr}))})
ws.addEventListener("message",e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result)}})
await new Promise(r=>ws.onopen=r)
if(mode==="eval"){const r=await send("Runtime.evaluate",{expression:`(async()=>{try{return JSON.stringify(await(async()=>{${arg}})())}catch(e){return JSON.stringify({__err:String(e&&e.stack||e)})}})()`,returnByValue:true,awaitPromise:true});console.log(r.result?.value)}
else if(mode==="shot"){await send("Page.enable");const r=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true});fs.writeFileSync(arg,Buffer.from(r.data,"base64"));console.log("saved "+arg)}
ws.close();process.exit(0)
```
导航到富会话(含全构件)再截图,例:
```bash
bun cdp.mjs eval 'document.querySelector("a[href*=session]")?.click(); await new Promise(r=>setTimeout(r,1500)); return location.pathname'
bun cdp.mjs shot /tmp/after.png
```
> 真机富会话参考:`kama-bot-local` 下的会话(含 read/grep/edit/write/bash/diff-summary/审查面板)。深浅色各截一次(`eval 'document.documentElement.setAttribute("data-theme","dark")'` 不适用于真机——真机主题走设置;可在两套主题下分别截)。

## 3. 代码落点 —— 单文件 vs 分文件(决定能否并行)
现状:36 条 CSS 默认都改 `timeline-reskin.css` 同一文件 → **逻辑独立但物理串行**(并行会 merge 冲突)。两种执行方式:

- **方案 S(串行,单文件,默认)**:一个 session 顺序做,所有 CSS 追加进 `timeline-reskin.css` 既有分区。最简单,无结构改动。
- **方案 P(并行安全,分文件,推荐给多 agent)**:先把 `timeline-reskin.css` 按区拆成 `@import` 分文件,任务各改各的文件,物理也独立:
  ```
  alpha-ui/timeline-reskin.css            # 只留 @import + 顶部 COUPLING 注释
  alpha-ui/timeline/user.css              # TL-01..06
  alpha-ui/timeline/assistant.css         # TL-07..14
  alpha-ui/timeline/tools.css             # TL-15..29
  alpha-ui/timeline/structure.css         # TL-30..34
  alpha-ui/timeline/review.css            # TL-35..39
  alpha-ui/timeline/misc.css              # TL-40
  ```
  拆分本身是一条前置任务(纯搬运 + 验证视觉不变)。
> **已定(2026-06-28):方案 P。** 分文件已建好(`timeline/{user,assistant,tools,structure,review,misc}.css`),采用**加性拆分** —— 既有已发布规则留在 `timeline-reskin.css`,新任务写进对应 `timeline/<area>.css`,入口已 `@import` 全部 partial。各区独占一文件 → 物理并行安全。共享原语(如 `diff-changes` 徽)放 `tools.css`,全局生效,其它区直接引用不重复定义。

## 4. 执行顺序(P0 → P1 → P2,共享原语先行)
1. **TL-22**(改动徽标,共享原语)—— 最先,TL-21/32/38 依赖它。
2. **其余 P0(10 条)**:TL-07 助手脚注 · TL-08 表格 · TL-15 工具状态 · TL-17 bash 退出码 · TL-21 文件卡头 · TL-32 本回合改动 · TL-35/36/37/38 审查面板。
3. **P1(16 条)**:TL-01..06 用户输入 · TL-09/10 markdown · TL-11 thinking · TL-18/19/20 bash/read/grep · TL-23 patch · TL-26 联网 · TL-29 诊断 · TL-30 分组头 · TL-33 压缩。
4. **P2(13 条)**:TL-12/13/14/16/24/25/27/28/31/34/39/40 打磨/可选。
每条独立闭环:**改 CSS/inject → typecheck → CDP 截图对照 `timeline.html` 同名构件 → 通过才下一条。**

## 5. ⚠️ 开工前必须先向用户确认 / 先核实(否则无法独立执行)
> 用户要求:存在问题先反馈。以下 6 项在动手前需解决,分两类。

**A. 用户已决策(2026-06-28)——**
1. **执行方式 = 方案 P(并行拆文件)**,已建 `timeline/<area>.css`(加性拆分,见 §3)。
2. **TL-31 计数动画 = 换肤**(不保留原生)。
3. **TL-34 回合分隔 = 做** · **TL-39 终端外框 = 做**(只换外框,不动内核)。

**B. 需开发中先真机核实钩子(3 项,无选择器无法写)——**
4. **TL-06 连接器 chip**(截图「GH GitHub」):真机复现一条带连接器/资源提及的用户消息,CDP dump 其 `data-*`,确认是 `data-highlight` 子类 / 附件 / 还是 MCP 资源 —— 再决定选择器。
5. **TL-40 回到底部按钮**:确认原生是否有该按钮及其钩子;若无则需 inject 造。
6. **TL-28 MCP server 拆分**:确认 `GenericTool` 是否暴露 server/tool 分字段;若只有合并的 `mcp__server__tool` 名,则「拆显」需 inject 解析,否则降级为仅 CSS 着色 + 原名。

> 另:**TL-36 审查面板的 tabs/radio/select 是 Kobalte 组件**,改前用 CDP dump 其内部结构确认 `data-slot` 稳定,避免改到会被上游升级重排的内部节点。

## 6. 每条任务的标准工作流(模板)
1. 读 `tasks.md` 对应 TL-NN 的钩子 + 改动 + 验收。
2. CDP dump 该构件真机 DOM(确认钩子仍在):`bun cdp.mjs eval 'return [...document.querySelectorAll("<hook>")].length'`。
3. 写 CSS/inject(只动允许的属性)。
4. `bun run typecheck`(EXIT=0)。
5. CDP 截图,与 `timeline.html` 同名构件比对 —— 浅色 + 深色。
6. 勾掉 `tasks.md` 该条,记一行到 `docs/retros/`(可选)。

## 7. 收尾(全部完成后)
- [ ] 40 条全绿,深浅色 CDP 回归截图归档到 `screenshots/`。
- [ ] `timeline-reskin.css` 顶部 COUPLING 清单更新(新增 ~36 组选择器),供 sync 重指。
- [ ] `ship:mac` 真机验收(`ELECTRON_MIRROR=npmmirror` 防 TLS,见 memory)。
- [ ] PR → `alpha`(base 必须 alpha,非 dev),merge 后删分支(ADR-005)。

## 8. Definition of Done(每条)
- 真机该构件不再回落 opencode 裸样式;深浅色都达标;typecheck 绿;未改任何 upstream 源码;选择器登记进 COUPLING。

## 9. 一眼速查
| 项 | 值 |
|----|----|
| 任务总数 | 40(CSS 36 / INJECT 3 / ENGINE 1) |
| 优先级 | P0=11 · P1=16 · P2=13 |
| 落点 | `alpha-ui/timeline-reskin.css` / `timeline-inject.tsx`(或 `timeline/*.css` 分文件) |
| 验证 | `bun run typecheck` + CDP 9222 截图 |
| 设计真源 | `timeline.html` |
| 先决 | §5 的 3 决策 + 3 核实 |
