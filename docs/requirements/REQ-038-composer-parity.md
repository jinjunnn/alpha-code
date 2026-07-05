---
id: REQ-038
title: Composer 一致性收敛:首页/会话页输入框行为对齐(首页斜杠菜单接线为首项)+ 共享层继续收敛(逻辑/CSS 单一来源)+ 换皮层像素走查
type: ux
priority: P1
status: ready
repo: A
created: 2026-07-05
---

## 背景(为什么)

用户报告(2026-07-05,附三张截图):首页(AlphaHome)与会话页的 composer「经常起冲突、逻辑不一致」——实测**首页输入 `/` 不出命令菜单**(占位文案却写着「输入 / 调命令」),会话页 composer 另有零散 bug(截图见发送按钮疑似被容器裁切);诉求 = 封装成一个共享包,去掉不一致,保留正确的一方。

现状核查(2026-07-05,代码确证)修正了「两份重复 CSS」的假设——**两处根本不是同一个组件**:

1. **已共享(单一来源,零重复)**:工具栏 chips(+ 附件 `AddButton` / 权限 `PermChip` / effort `EffortChip`)= `composer-controls.tsx` 单一组件 + 模块级共享 state(文件头注释明书 "SINGLE source of truth");会话页经 `composer-inject.tsx`(MutationObserver + Portal)注入上游工具栏。chip/popover 样式只在 `home.css:337-534` 定义一次。
2. **不共享(差异根源)**:
   - 首页输入框 = alpha 自建裸 `<textarea>`(`AlphaHome.tsx:131-138`),**无 `/`、`@` 检测、无弹层、无 command 数据源**——占位文案是纯文案,能力不存在;
   - 会话页输入框 = 上游冻结 `prompt-input.tsx`(2248 行 contenteditable):slash 菜单(`:719-741` 内置 `command.options` + 自定义 `sync().data.command`)、@ 引用(agent/file/recent)、粘贴图片/拖拽/附件预览、IME 双守卫(`composing()` + `keyCode 229`)俱全;alpha 仅 CSS 换皮(`composer-reskin.css`)+ chip 注入。
3. **完整差异矩阵**:斜杠菜单/@/粘贴图片/拖拽/附件预览/用量环 = 仅会话页;工作区 chip = 仅首页;IME 守卫首页仅 `e.isComposing`(弱于上游);发送禁用条件两处口径不同(首页多「须选工作区」,上游认图片/comment 为非空);提交路径首页 `startChat`(session.create + promptAsync + navigate,`use-projects.ts:276-297`)vs 会话页上游 `handleSubmit` 直接 prompt。
4. **唯一真正的样式重复**:输入框外壳(圆角/边框/focus 态)在 `home.css:285-335`(`.a-comp`)与 `composer-reskin.css:7-26`(`[data-component=session-composer]`)各写一遍,靠人肉对齐。

## 方案论证(为什么不是「一个组件两处引用」)

- **上游组件搬首页 ❌**:prompt-input 依赖会话页 provider 栈(session context);AlphaHome 挂在栈外,`usePrompt`/`createPromptSubmit` 不可达(既有勘探结论,memory [[alpha-composer-provider-topology]])——这正是首页当初只能裸写 textarea 的原因。
- **alpha 组件替换会话页 ❌(短期)**:= composer 全面接管 = SDK 重实现图片/文件索引/draft 晋升全部能力,违背 ADR-016「重型引擎复用不重写」;若将来启动属定位级变更,须独立 ADR,不在本档。
- **✅ 采纳:物理双实现、逻辑与视觉单一来源 + 行为对齐**——共享得动的(数据源/弹层/守卫逻辑/外壳 CSS)收进共享层,共享不动的(输入框本体)逐条对齐行为,以上游(功能全、守卫全)为正确基准。

## 目标(做什么)

1. **首页斜杠菜单接线(P0,用户报的 bug)**:`/` 前缀检测 → 弹层列命令,数据源与会话页同源(SDK command 列表,含内置 + 自定义 + skill 生成);弹层做成共享模块(落 `composer-controls.tsx` 或新 `composer-slash.tsx`),复用 `.a-pop*` 既有样式;选中内置命令走 `command.trigger`,自定义命令回填 `/name `,与上游 `handleSlashSelect`(`prompt-input.tsx:743-759`)语义一致;键盘上下/Esc 导航。
2. **首页 @ 引用(至少 agent 档)**:@ 检测 + agent 列表(数据既有);文件引用视首页目录上下文可得性分期(工作区 chip 已给出 directory,file search SDK 可用则同批,不可用则文档记边界)。
3. **行为守卫对齐(取正确一方)**:IME 守卫补 `keyCode 229` 兜底;发送禁用口径统一(以「非空即可发」为准,首页保留工作区前置但给出未选态提示而非静默禁用);Enter/Shift+Enter 语义复核一致。
4. **外壳 CSS 合并单源**:`.a-comp` 与 `[data-component=session-composer]` 的外框样式抽成一份共享 CSS(变量或共用类),两处引用,消除人肉对齐。
5. **会话页换皮层像素走查**:发送按钮裁切(用户截图线索)、chip 注入定位(`order`)、隐藏原生控件的选择器现势——逐项核验修复,结论入走查清单([[visual-verify-required]])。
6. **占位文案诚实化(C28)**:在 ①② 落地前的过渡态,首页占位不得承诺不存在的能力;落地后两处文案同源(现状:首页硬编码字面量 `AlphaHome.tsx:134` + 上游经 `brand-i18n.ts:31` 构建期改写同句——收敛为单一常量)。

## 验收标准(可验证,逐条)

1. 首页输入 `/`:弹出命令菜单,条目与会话页一致(含自定义 command,可与 [[REQ-036]]/[[REQ-037]] 注入命令互验);选中可执行/回填;截图核验;
2. 首页输入 `@`:至少列 agent 并可插入;文件档如实现则与会话页行为一致,未实现则占位文案不提;
3. 中文 IME 组合输入回车不误发(首页,含 Safari/`keyCode 229` 路径);
4. 发送禁用口径对齐后:首页未选工作区时有可见提示;会话页有图片附件无文本时可发(回归,上游既有);
5. 外壳样式单源:改一处圆角/边框/focus 值,两处同步变化(代码层面验证引用同源);
6. 会话页走查清单逐项 PASS:发送按钮无裁切、chip 无重复渲染(effort 双显/用量环堆叠两个已修项做回归)、无新增视觉回归;
7. 占位文案与实际能力一致(两处、中英文);
8. 零改上游(north-star guard 绿;`composer-reskin.css`/`brand-i18n.ts` 均 alpha 自有)。

## 非目标

- **不重写/替换会话页上游 prompt-input**(ADR-016/ADR-020;全量并轨=另立 ADR 的定位级决策);
- 首页粘贴/拖拽图片附件:分期候补(需动 `startChat` 提交契约支持图片 parts),本档不含;
- 不动 EffortChip 引擎接线(→ [[REQ-029]])、不动权限档语义(→ [[REQ-028]]);
- 不改提交路径拓扑(首页 create+prompt+navigate 与会话页直接 prompt 各自保留——差异合理,非 bug)。

## 方案 / 关联

- 差异矩阵与全部 file:line 证据:本档背景节(2026-07-05 勘探);
- [[REQ-011]](archived,工作区 chip 现状)、[[REQ-028]]/[[REQ-029]](chip 语义/接线,共享层同文件勿冲突)、[[REQ-036]]/[[REQ-037]](自定义/治理后的 command 是斜杠菜单一致性的天然试金石);
- ADR-016(重型组件复用边界)、ADR-020(上游前端冻结——上游 prompt-input 不漂移,对齐一次长期有效)、C28(诚实控件:文案不承诺不存在的能力);memory [[alpha-composer-provider-topology]]。
