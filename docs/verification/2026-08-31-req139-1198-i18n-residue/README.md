# REQ-139 / ac#1198 — i18n 值级品牌残留:窄容器 L2 截图

被测树:分支 `t1198-i18n`(base `origin/alpha` @ `4b65ec4c1`),dev 实例
(`bun run --cwd packages/ui-mac dev`,CDP 9222,未登录 BYOK 态),截图 = CDP
`Page.captureScreenshot`。三面均无溢出/截断/换行异常。

## shot1-ext-ownership-rows.png — 扩展中心详情页所有权段(真实数据路径)

定制中心 → 连接器 → 「Excel 表格读写」详情页。真实渲染:作者 `Code Puppy`、
甄选 `Code Puppy 精选目录 · 审核于 2026-08-17`(`alpha.ext.partyAlpha` /
`alpha.ext.ownCuratedReviewed`),含 `ownNote` 整句。列表页筛选 chip
`Code Puppy 出品`(`alpha.ext.sourceAlpha`)也在真实路径上渲染。

## shot2-model-picker-group-label.png — model picker 分组标签(宽度探针)

平台组标签(`alpha.model.platformGroup`,`alpha-composer-model.tsx:632`)只在
**平台登录态**下渲染(`model-picker-core.ts:99`:`accountState === "out"` ⇒ 平台行为空),
本 lane 无登录凭据 ⇒ 真实数据路径不可达。方法:在**真实打开的 picker 弹窗**的
`.a-mpp-scroll` 容器里注入同 class `.a-pop-label` 节点、textContent 为新 zh 串,
真实 CSS 生效(该 class 带 uppercase 变换,截图显示 `代理节点 · 经 CODE PUPPY 代理`),
量得 `scrollWidth === clientWidth === 387px`,`overflow: false`;同帧下方是真实渲染的
BYOK 组标签作对照。拍完即删探针节点。**这张证明的是宽度/排版,不是数据链路。**

## shot3-cloud-consent-title.png — 云同意弹窗标题(宽度探针)

同意弹窗(`upload-consent-dialog.tsx`)只在云派发含受保护文件时挂载,依赖平台登录 +
真实派发流 ⇒ 不可达。方法:按 `Dialog.tsx` 的真实 DOM 形状
(`.a-ui.a-dialog-root[data-beside-sidebar]` > `.a-dialog-panel[data-size=md]` >
`.a-dialog-header/.a-dialog-title` …)注入骨架,文案全部取自 zh 字典逐字值
(title / introPrefix+pipelineReview+introSuffix / scopeFiles / scopeHint /
retentionStandard / cancel / cta)。标题单行 468.9px,`overflow: false`。拍完即删。
**同上:宽度/排版证据,不是数据链路。**

平台登录态下这两面的真实数据路径渲染,留给 REQ-139 的 L2/RC 验证轮
(登录态属 owner 手上的实例;合并后升级即可目验)。
