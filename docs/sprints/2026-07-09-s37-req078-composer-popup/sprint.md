# S37 — REQ-078 @/+ 装配弹窗诚实化与能力补齐(2026-07-09)

> 契约(ADR-018):目标 / 抽取 IDs / task 表 / gates / 结果 / 回写清单。

## 目标

修掉 @/+ 弹窗两处 placebo(附件行静默吞、终端行文案失实),补附件真通道(图片/PDF)与零查询钉 git 变更文件。

## 抽取

| ID | 状态入 | 状态出 |
|---|---|---|
| REQ-078 | ready | shipped(真机批残单见 verify.md) |

## Tasks

- [x] T1 placebo 修复:附件行接真通道(不再 `command.trigger("file.attach")`);终端行文案如实「打开终端(输出不会自动进入上下文)」且仅 session 表面出现(home 不摆死行)
- [x] T2 附件真通道:`composer-attachments-core.ts` 纯核(类型/体积闸门 5MB 图 / 10MB PDF、去重、8 个帽、part 形状=上游 images 通道)+ AlphaComposer 三入口(弹窗行→隐藏 input / 粘贴 / 拖拽)+ chips(缩略图/移除)+ 提交并入 parts + 斜杠命令不携带附件的诚实拦截
- [x] T3 零查询钉「git 变更文件」:弹窗打开拉 `vcs.status`(**发现并绕开上游 `/file/status` 存根**,见 verify.md)+ `find.files` limit 8→20
- [x] 单测:+29(attachments-core 全量 + buildAssembleRows 三新例 + 既有例随语义更新);全量 667→ 全绿
- [x] CDP 视觉核验:3 图 + DOM 断言([audits/s37](../../audits/2026-07-09-s37-req078/verify.md))

## Gates

- [x] alpha-check(北极星守卫 + typecheck + 单测)全绿
- [x] 零改上游文件(引擎存根只记录不修——那是上游的)
- [x] GLOSSARY 输入语法分工不漂移(`/` 执行 · `@`/`+` 装配,节结构未动)

## 回写清单

- [x] BACKLOG REQ-078 → shipped(PR 号见行内)
- [x] CHANGELOG [Unreleased] 用户可见两条
- [x] requirements/REQ-078 frontmatter → shipped
- [x] 证据:audits/2026-07-09-s37-req078/(3 png + verify.md)
