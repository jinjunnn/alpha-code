---
id: REQ-066
title: 斜杠菜单卫生:治理禁用项不显示 + 命令来源标注(内置/技能/项目/MCP/导入)
type: ux
priority: P1
status: shipped
repo: A
created: 2026-07-08
---

## 背景(为什么)

用户截图实证(2026-07-08):`/customize-opencode` 已在 alpha 治理中禁用,斜杠菜单仍然列出(带「(已禁用)该技能已在 alpha 治理中禁用」占位描述)。

根因链:上游行为——`permission.skill deny` 后 `GET /skill` 与 command.list **仍返回条目**(alpha-governance.ts:14 记录的已知泄漏);治理落地时(REQ-037)composer 还是上游组件,alpha 只能用占位 command 做「诚实缓解」。**REQ-055 之后 composer 与斜杠菜单已是 alpha 自有组件**(AlphaComposer,数据源 command.list)——过滤权已在我方手里,占位缓解可以升级为真正隐藏。

第二个痛点(用户原话「莫名其妙的很多 / 命令我都不知道哪里来的」):命令来源零标注——菜单里混着引擎内置(/init /review)、skill 自动生成(每个技能一条,含 XDG/`.claude` 继承来的)、项目 `.opencode/command`(如本仓上游自带的 8 条开发命令)、MCP prompts、导入产物,用户无从分辨。这与 [[REQ-063]](继承 default-deny)互补:REQ-063 砍掉不知情的来源,本项让剩下的每一条**自报家门**。

## 目标(做什么)

1. **T1 过滤治理禁用项**:AlphaComposer 斜杠菜单过滤治理 deny 的 skill 所生成的命令与占位命令——数据源 = 治理状态(既有 governance IPC 的 skills.deny 等),**不靠**「(已禁用)」文案前缀判断(脆弱);解禁后免重启恢复显示(dispose 链)。引擎侧占位 template **保留**(用户手动键入完整命令名时的诚实兜底,纵深不拆)。
2. **T2 来源标注**:菜单每条命令加轻量来源标注(徽标或分组):`内置` / `技能` / `项目` / `MCP` / `导入`——数据源 = command.list 的 source 字段(skill/mcp)+ receipts(origin imported-*)+ 内置名单(init/review)交叉。
3. **T3 agent 选择器同口径复核**:REQ-055 已过滤 alpha 内部 agent;补「治理 disable/hidden 的上游 agent 不出现在选择器」的断言(REQ-037 hidden 机制已有,此处只加守卫测试)。

## 验收标准(可验证,逐条)

1. customize-opencode 治理禁用态 → 斜杠菜单**不出现**该条;治理面解禁 → 免重启恢复出现;
2. 手动键入 `/customize-opencode` 完整名并发送 → 引擎占位响应如实告知已禁用(不假装执行);
3. 菜单逐条有来源标注,抽查 ≥5 条(内置/技能/项目/MCP 各至少一条)与实际来源一致;
4. 组件级测试:过滤纯逻辑(禁用集 × 命令列表)+ 来源归类函数;
5. 真机截图:同一菜单禁用前后对比 + 来源标注实拍([[visual-verify-required]])。

## 非目标

- 不改引擎 `GET /skill` / command.list 的返回行为(上游归属,R2);
- 不做命令搜索/排序/分组的整体改版(单点卫生修复);
- 继承来源的整治归 [[REQ-063]](default-deny + 导入),本项只管「显示谁 + 标注谁」。
