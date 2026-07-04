# C14 升级破坏面收敛(S11 T8,PR #62)

> 上下文:ADR-020 冻结后 app/ui 不再每日漂移,232 选择器面的衰减源已物理消除;C14 的角色转为
> **re-freeze 体检工具 + alpha 侧防误改**。本批落验收 ①③④,② 机制化说明见 §三。

## 一、验收① providers 薄 re-export 层(ADR-016 待办①)
- NEW `alpha-ui/providers.ts`:上游内部 hook 借用唯一汇聚点;规则=alpha 组件不得直 import
  `@opencode-ai/app`(shell 入口 index.tsx 的 AppInterface/Platform 官方接缝除外,属 sanctioned)。
- 切换:`alpha-sidebar.tsx` / `AlphaHome.tsx` / `composer-controls.tsx` 的 `useCommand` → providers。
- 复核命令:`grep -rn 'from "@opencode-ai/app"' packages/ui-mac/src/renderer --include="*.tsx" | grep -v index.tsx` 应为空。

## 二、验收③ `as any` 清点(23 处,较初报 16 处增长)
全部集中在两个 SDK 数据层文件,**同一类偏斜**(SDK v2 codegen 类型 vs server 实际形状):
- `sidebar/use-projects.ts` ×16:session.list 扩展参数(directory/scope/roots)、session.create/update/share/delete/messages/promptAsync 参数、data 元素形状、global.event 信封
- `extensions/use-extensions.ts` ×7:mcp.status/add/connect/disconnect 参数、global.event 信封
处置=两文件头部**契约锚注释**(C14③,grep 键 `as any`);上游 codegen 修齐后成批删除;纪律:不新增其它用途 as any。逐处改正式类型不做(冻结前端下 SDK gen 与 server 偏斜属上游演进面,alpha 手写类型=第二耦合面,得不偿失)。

## 三、验收② COUPLING 清单机制化
- 选择器半边:载体 = REQ-012 `upstream-anchors.json`(195 alive 清单 + 契约测试,PR #44 已建)。
- 重指 runbook:冻结后唯一重指时机 = **re-freeze**(ADR-020 §5 ③ 已含锚点契约测试步);发版走查清单在 DISTRIBUTION §5(本批补一行耦合复核)。
- `data-alpha-*` 全量重打点**不做**(冻结使其收益消失;re-freeze 失败再启,ADR-020 已留 C→D 备选)。

## 四、验收④ warn-only 补丁 loud-fail
`electron.vite.config.ts`:`brandI18nPlugin`/`patchUpstreamPlugin` 默认 `strict`(打偏=build 红);
逃生 `ALPHA_PATCH_LENIENT=1`(re-freeze 体检期临时放行)。理由:冻结后子串恒应命中,miss=真漂移。

## 复核命令(sync/re-freeze 时)
```
grep -rn 'from "@opencode-ai/app"' packages/ui-mac/src/renderer --include="*.tsx" | grep -v index.tsx
grep -rn "as any" packages/ui-mac/src/renderer --include="*.ts" --include="*.tsx"
bun --cwd packages/ui-mac test src/renderer/alpha-ui/upstream-anchors.test.ts
```
