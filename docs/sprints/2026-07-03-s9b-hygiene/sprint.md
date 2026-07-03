# Sprint 2026-07-03 s9b-hygiene(S9 卫星批 · 并行)

**关系**:S9(`2026-07-03-s9-proxy-e2e`)是**唯一 headline**(代理核心链,占用 `server.ts`/auth/gateway/picker);本批是 BACKLOG「建议下一 sprint」段(line 135)预留、**留 ready 由并发 session 领取的简单/卫生批** —— 不与 S9 争 headline,**WIP=1 不破**(S9 仍是主线,本批为卫星)。

**目标**:清一批**低风险 × 低歧义、非视觉(可经 typecheck/test/CI/git 验、无需 Mac 截图)、与 S9 文件完全不相交**的工程卫生项,给 Opus 4.8 并行推进。

**并行安全纪律(硬)**:
- **禁碰 `packages/ui-mac/src/main/server.ts`**(A6/B1 owns)→ 故 **D1 排除**(其修点在 server.ts:198-212 健康探测环)。
- **禁碰 `packages/ui-mac/src/main/index.ts`**(S9/REQ-002 的 deep-link/auth 在此文件 `emitDeepLinks`:88 附近)→ 故 **D10 的 index.ts:82 陈旧注释子项延后**,只做 package.json 半。
- C3 的 netlog 开关落在 `logging.ts` 的 `startNetLog()` 内部(不改 index.ts 调用点)→ 100% 收在 `logging.ts`。
- CI 两项(REQ-009/D12)同一 session 领取,独占 `.github/workflows/`,避免 session 间对 CI 的互撞。

**抽取**:D10、C3、REQ-009、D12(BACKLOG 翻 in-sprint,标 s9b)。

| Task | 内容 | 对应 ID | 风险×歧义 | 文件 | 状态 |
|---|---|---|---|---|---|
| T1 | `ui-mac/package.json` 补 `license: MIT` / `author` / `repository`(指 jinjunnn/alpha-code,与 C18 更新链一致);**index.ts:82 陈旧注释延后**(共享文件避撞 S9) | D10 | 极低 | `packages/ui-mac/package.json` | ✅ 代码+gate(注释子项延后) |
| T2 | netlog 改 `ALPHA_NETLOG=1` opt-in(默认关,`startNetLog()` 内早退);opencode.log 启动期体积上限归档(超限轮转、保留最近 N 份) | C3 | 低 | `packages/ui-mac/src/main/logging.ts` | ✅ 代码+gate(运行期轮转 verify 待打包启动) |
| T3 | alpha-ci 提速:guard `filter: blob:none` 部分克隆 + typecheck/test 的 bun 依赖缓存;**构造改上游文件的提交验 guard 仍红**(验完删);单轮 ≤2min 记录 | REQ-009 | 低-中(需 CI run 验) | `.github/workflows/alpha-ci.yml` | ⏸️ CI 另议(退回 ready,用户 2026-07-03 定) |
| T4 | 上游 cron workflow 在本 fork 禁用(仓库设置 disable,记清单;不改 yml);误发布封死取证;lint/e2e 范围决策记录 | D12 | 低(含仓库设置) | 仓库 Actions 设置 + 本文档 | ⏸️ CI 另议(退回 ready) |

> **收尾(2026-07-03)**:用户选「先给 D10+C3 开小 PR、CI 另议」。**T1/T2 经 PR 交付**(隔离 worktree,不扰 S9 共享树);**T3/T4 退回 `ready`** 留 CI 域另批统一做(独占 `.github/workflows/`)。本卫星批以 T1/T2 收口。

**依赖**:无(四项互相独立)。T3/T4 同域(CI),同一 session 顺序做。

**Gates**:typecheck ☐ · bun test ☐ · 北极星守卫(仅新增/本批只碰 alpha 文件)☐ · /app:review ☐(CI 项 ship 前)
**回写**:BACKLOG ☐ · CHANGELOG ☐ · verify 记录 ☐ · retro 链接:—

## 验证记录
- **T1 (D10)** ✅ `package.json` typecheck 干净;字段与 C18 更新链(jinjunnn/alpha-code)、根 `license:MIT` 一致。注释子项延后(避撞 S9 index.ts)。
- **T2 (C3)** ✅ typecheck + 97 tests 绿;归档正则实测只命中 `opencode.<stamp>.log`(不误伤 `opencode.log`/日期文件/renderer/main);轮转+剪枝逻辑经 scratchpad 合成文件 E2E 复算 6/6 断言过(超限归档、剪枝留最近 3、日期文件不动)。**运行期首次轮转**待下次打包启动实测(现网真机 `opencode.log`=145MB 会在首启被归档)。
- **T3 (REQ-009)** ☐ 未开始:`≤2min` 与「改上游必红」依赖一次真实 CI run(=ship)。
- **T4 (D12)** ☐ 未开始:cron 禁用=仓库 Actions 设置(需 gh);本轮未动共享 CI。
