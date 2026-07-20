---
id: ADR-022
title: 自动化(定时任务):本地调度器 + 只读 agent 静态权限档 + .alpha 落盘(A1 MVP)
status: accepted
date: 2026-07-04
related: [ADR-002, ADR-019, ADR-021, REQ-021, REQ-022]
---

> **2026-07-05 转 accepted**(REQ-016 S16 真机批,证据 [audits/2026-07-05-req016-realmachine-batch/verify.md](../../../docs/audits/2026-07-05-req016-realmachine-batch/verify.md)):prod 签名包实测 —— E1 once 任务到点触发(+4ms)→ 真会话 → report.md/status.json 落 `.alpha/runs/`;E2 readonly 档实调「创建文件+bash」被 deny 且**全程零 ask**(status=ok 非 timeout,禁止文件零创建);E3 过期任务 catchUpPolicy:skip 未补跑;E4 自动化实体与 `_state.json`(dailyRunCap 跨重启)机制验证。残余(冷重启往返 / 历史回跳 / 云档位)不阻断转正。下方「真机批待验」门已达成。

## 背景
用户目标:定制中心下方「自动化」——一句话描述 workflow → 定时执行(REQ-021,2026-07-04 拍板:
完整需求分期 A1 只读 MVP > A2 增强 > A3 云档)。此前为零:侧栏「自动化」是孤儿 i18n key,A/B 两侧
均无调度设施。引擎事实(已核):v1 config `agent.<name>.permission` 可静态配死全部权限(pattern→action
对象,agent 级合并)→ 无人值守零 ask 可行;v2 SDK `session.prompt` 阻塞到回复完成 → 执行链无需自建
流消费。

## 决策(A1,全部 alpha 自有文件,零改上游)
1. **实体**:`<环境级全局根>/automations/<id>.json` 一任务一文件(`shared/automation-types.ts`;
   schedule = cron 5 字段 | interval 分钟 | once)+ `_state.json`(全部暂停 + dailyRunCap 记账)。
   运行记录写目标项目 `.alpha/runs/auto-<id>-<ts>/`(report.md + status.json,复用 ADR-019 守卫
   `alpha-workdir.writeRunFiles`)。存储层硬校验(A1 强制 execution:local + readonly,防绕过 UI 直写)。
2. **调度器 = Electron 主进程**(`automation-scheduler.ts`):每任务单 timer(算下次 → setTimeout
   分段 → 执行 → 重排);`powerMonitor.resume` + 30min 兜底 tick 全量重排;错过一律 skip 不补
   (catchUpPolicy;纯逻辑 `shared/automation-schedule.ts` 单测覆盖);全局并发 1 + overlap skip
   记账;dailyRunCap 默认 24 次/日(跨重启持久)。**应用未运行不执行**(UI 明示,不装后台常驻),
   配套「登录时启动」开关(`app.setLoginItemSettings`,首个使用点)。
3. **执行链只走 SDK**(ADR-002;main 内 `@opencode-ai/sdk/v2/client`,凭证复用 serverReady Deferred):
   `session.create`(标题「⏱ 自动化 · <name>」)→ `session.prompt`(agent=`alpha-automation`,阻塞)
   → 最终回复落 run 目录;超 `maxDurationMin`(默认 15,上限 120)abort 记 timeout;失败也留痕
   (status.json)。通知 = Electron `Notification` + 渲染层 `automation-event` 推送(侧栏 badge =
   失败/超时任务数)。
4. **readonly agent = config 注入静态权限档**(`sidecar.injectAlphaConfig` 第 5 段,
   `ALPHA_AUTOMATION_DISABLE` 逃生):read(`*` allow,`*.env*` deny)/glob/grep/list/webfetch/
   websearch/skill=allow;edit/bash/external_directory/doom_loop/question/task=deny;prompt 内联
   声明无人值守语义(绝不提问、答复即报告)。**零 ask 是无人值守的硬前提** —— 靠静态配死,不靠
   运行时兜底。
5. **一句话解析 = 确定性规则**(`shared/automation-nl.ts`,中英:每天/每周X/每月N日/工作日/周末/
   每N分钟·小时 + HH:mm/H点半/am·pm):解析不出周期诚实降级手动选;LLM 辅助解析归 A2,不在 A1 引入。
6. **分期边界**:`standard` 可写档(UI 灰显「即将推出」)与连败熔断/立即运行归 A2;`execution:cloud`
   (B 侧 cron,REQ-022)归 A3,硬前置 = ADR-021 §2(已落地,S14)+ B16 重启评估。

## 边界与诚实声明
- tz:实体存 `tz` 字段,A1 计算用**系统本地时区**(跨时区任务不承诺);cron 无秒级。
- 通知/调度只在 app 存活时发生;睡眠错过 = 跳过(记录可见),不是静默丢失。
- interval 下限 5 分钟(防打点风暴;dailyRunCap 是第二道)。
- main 侧通知文案暂为中文硬编码(main 无 i18n 设施;随后续 main-i18n 统一)。

## 后果
- ✅ 「一句话 → 定时执行」闭环全在本地接缝内:零改上游、零新 HTTP 面、执行只走 SDK。
- ✅ 调度纯逻辑与解析器可单测(A1 验收⑥);权限档静态可审计。
- ⚠️ **真机批待验**(转 accepted 的门):到点触发 + 通知实拍;readonly 实测零 ask 且 edit/bash 被
  deny;重叠/睡眠错过用例;断电重启 next-fire 恢复;历史回跳会话(并入 REQ-016 场次)。
- ⚠️ `alpha-automation` 以 `mode:"primary"` 注入 → 会出现在引擎 agent 列表/选择器里(描述已注明
  用途);若上游后续支持对 prompt 直接指派 subagent,可改 subagent+hidden 收干净。
- 🔭 A2/A3 见 REQ-021;云档位落地时本 ADR 需修订 §6(dispatch 复用 ADR-021 §2 校验)。

## 修订(2026-07-06,REQ-024/REQ-025 —— A2 全量 + A3 云档落地,§6 分期边界兑现)
- **A2(REQ-024,PR #106)**:`standard` 可写档上线(注入 `alpha-automation-standard`:edit allow + bash 破坏类模式 deny —— 黑名单诚实非穷尽,UI 启用确认明示;零 ask 语义不变);LLM 辅助解析(规则失败后用户显式触发,临时会话即删);连败 3 熔断(`shouldTripBreaker` 纯函数)+ 立即运行(不改 next-fire,计日 cap)。
- **A3(REQ-025,PR #108;B=REQ-022/PA-28,alpha-platform #17/#18 已 prod)**:`execution:"cloud"` 上线 —— 保存即注册 B 侧 D1 schedule(cron 化映射,once/超长诚实拒),本地调度器不排;开机按 `jobs?since&origin=schedule` 拉回错过 run 落 `.alpha/runs/`;B 熔断状态回读进列表;数据边界提示(ADR-021)强制展示。**MVP 限 research 管线**(任务文本=调研问题,零项目文件上云);B 端预算硬帽 15 iter/150k tok/300s。
- §6 原「A2/A3 归后期」边界就此关闭;云档 dispatch 复用 ADR-021 §2 校验前置的承诺由 B 端 schema+预算校验 + A 端仅文本上云共同兑现。

## 修订(2026-07-07,REQ-055 —— 内部 agent 对选择器隐藏)
原 ⚠️「alpha-automation 以 mode:primary 注入 → 会出现在引擎 agent 列表/选择器里」的观感债就此关闭:三个内部 agent(alpha-automation / alpha-automation-standard / alpha-readonly)经 config 注入上游原生 `hidden: true`(agent.ts 字段,仅影响可见列表)+ AlphaComposer agent 列表二次过滤,不再出现在任何用户可见选择器;调度器/只读档按名 prompt 不受影响(dev 实证)。

## 修订(2026-07-19,#428 —— 自动化真源随当前环境隔离)

`<环境级全局根>` 定义为 `<appData>/alpha-code-state/env/<environment>`。调度器只消费 desktop
初始化后派生的 canonical `ALPHA_GLOBAL_DIR`；退休 home 根零读取、零迁移、零 dual-read。
