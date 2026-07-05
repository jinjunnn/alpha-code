# REQ-038 验收记录 —— Composer 一致性收敛(S18 T1)

> 2026-07-05,dev 实例(`bun run dev`,dev 恒开 CDP 9222)+ CDP 驱动(Runtime.evaluate + Page.captureScreenshot;探针脚本手法同 s17-t4)。逐条对 requirements/REQ-038 验收标准。

## 逐条结果

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 首页 `/` 弹命令菜单,条目与会话页同源;选中可执行/回填 | ✅ PASS | 菜单 12 条(custom=SDK `command.list`:/init /review /translate…含 skill 生成的 /customize-opencode;builtin=`useCommand().options` 同上游过滤式);`/rev`+点选 → 回填 `"/review "` 且菜单闭合(上游 handleSlashSelect 语义);builtin 走 `command.trigger(id,"slash")`。[02-slash-open.png](02-slash-open.png) |
| 2 | 首页 `@` 至少列 agent 并可插入;文件档如实现则行为一致 | ✅ PASS(文件档同批实现) | `@` → @general/@explore(SDK v2 `agent.list`,同上游 `!hidden && mode!=="primary"` 过滤);`@readme` → README.md 系列(SDK `find.files`,目录=工作区 chip);点选 `@gen` → 文本变 `"看看 @general "`,并记录真 part(submit 发 `{type:"agent",source:{start,end}}`,上游 build-request-parts 形状,单测锁定)。[04-at-open.png](04-at-open.png) · [05-at-files.png](05-at-files.png) |
| 3 | 中文 IME 组合回车不误发(含 keyCode 229 路径) | ◐ 代码级 PASS,真机 IME 残单 | `isImeComposing` 三重守卫(isComposing + composition 信号 + keyCode 229)与上游 prompt-input.tsx:641 逐字对齐;CDP 无法驱动真 IME → 真机批补验 |
| 4 | 发送禁用口径:未选工作区有可见提示 | ◐ 代码级 PASS | 按钮仅空文本/发送中禁用;无工作区时按钮保持可点 → 点击打开工作区选择器 + `.a-ws-hint`「请先选择工作区再发送」常显;dev 环境有项目无法触发空态 → 逻辑简单如实记录。会话页图片附件可发=上游既有,未触碰(回归零变化) |
| 5 | 外壳样式单源 | ✅ PASS | 新 `composer-shell.css` 为唯一定义,home.css/.a-comp 与 composer-reskin.css/[data-component=session-composer] 双双引用;computed style 实测:两面 focused 态 border 均 rgb(206,210,217)、radius 均 18px |
| 6 | 会话页走查:发送按钮裁切修复 + 无回归 | ✅ PASS(根因修复 ×2) | **裁切实锤并根因定位**:上游把 sprite svg 包在 `<div>`,alpha 只藏 svg → 残留 wrapper 占 grid 第一行,`::after` 箭头被挤到第二行、溢出 32px 圆外被 composer 边缘裁切(与用户截图一致)。修复=全子项+`::after` 叠 `grid-area:1/1`。修复前后对照:[07-send-zoom.png](07-send-zoom.png)(修复后箭头居中)。chip 单显、用量环单个(06 全景图核对)。**走查追加(用户当场报「有的有上下文,有的没有」)**:用量环收养选择器 `button:has(progress-circle)` 会误抓侧面板「上下文」**tab 触发按钮**(内含 indicator 环+文字,side-panel.tsx:274-300)——该 tab 开着的会话被偷走 tab 按钮、工具栏多出「上下文」文字。修复=收养过滤(排除 `[role=tab]/[role=tablist]` + 仅认 textContent 为空的纯图标形态)+ 误收养驱逐;**对抗验证**:DOM 植入带「上下文」文字的诱饵按钮 + 清空 host 强制重收养 → 诱饵未被收养、真环回收、诱饵原位不动(CDP 实测) |
| 7 | 占位文案与实际能力一致且同源 | ✅ PASS | 单一常量 `src/shared/composer-copy.ts`,AlphaHome 直接消费、brand-i18n.ts 构建期改写上游同句;/ 与 @ 能力本批落地 → 文案不再虚假承诺(C28) |
| 8 | 零改上游 | ✅ PASS | 全部 alpha 自有文件;`scripts/alpha-check.sh` 三关绿(north-star guard + typecheck + 384 tests) |

## 实现落点
- 新增:`composer-autocomplete-core.ts`(纯逻辑:触发检测/token 替换/mention→parts,15 单测)· `composer-autocomplete.tsx`(数据源+菜单 UI)· `composer-shell.css`(外壳单源)· `shared/composer-copy.ts`(文案单源)
- 修改:`AlphaHome.tsx`(接线+IME 守卫+ws 提示+parts 提交)· `use-projects.ts`(startChat 支持 extraParts + `/name args` 命中自定义命令改走 `session.command`,上游 submit.ts:77-100 同语义 + 暴露 `sdk()`)· `composer-reskin.css`(裁切修复+外壳抽离)· `home.css`(菜单/提示样式+外壳抽离)· `brand-i18n.ts`(消费常量)

## 残单(→ 真机批)
- 真机中文 IME 组合回车(验收③,Safari/keyCode 229 路径)
- 空工作区态的 `.a-ws-hint` 像素核验(验收④,需清项目环境)


## 追加(2026-07-05 晚,REQ-038b —— 用户拍板「两处用同一个弹框」)

用户实测反馈:会话页 slash 弹层(上游 prompt-input 自带,全宽、密度不同)与首页 alpha 弹层不一致,要求**已有对话使用新对话同款弹框**。CSS 换皮对齐方案被放弃(用户要的是同一个组件,非相似外观),改为**组件级接管**:

- `composer-slash-inject.tsx`:把首页同一套 `createComposerAutocomplete`(同数据源/同样式/同选中语义)Portal 进会话 composer;上游弹层整体 `display:none`;菜单键(↑↓/Enter/Tab)在 window capture 相位拦截防隐藏弹层双选,Esc 放行使上游状态同步关闭;编辑器仍是上游 contenteditable(execCommand 写回,draft 状态经其自身 input 监听同步)——零改上游。
- @ 菜单不接管(上游 @ 与其内部 parts/draft 状态强耦合,`modes: ["slash"]` 限定)。
- **实测(dev CDP)**:会话页 `/` → alpha 菜单(12 条,mcp/skill 徽标,active 态),上游弹层不可见;`rev` 过滤 + Enter → 回填 `"/review "`;ArrowDown+Enter 选第二项正确;菜单宽度=composer 宽度、位于其上 8px,与首页一致。截图:[09-session-alpha-slash.png](09-session-alpha-slash.png)。
- 过程发现:菜单初版挂 composer 内被 overflow 裁切(与 chips 弹层同款问题)→ 改 ChipPopover 同款 body Portal + fixed 锚定。**dev 走查坑**:dev 窗口可能加载 `oc://renderer`(陈旧内置 bundle)而非 vite dev server —— 验证前先核 `location.href`,否则改动看似无效。
