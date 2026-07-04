# Sprint 2026-07-04 S15 —— 自动化(定时任务)A1 本地只读 MVP(REQ-021)

> **给接手的新 session**:定制中心 v3 的 M4。开工先读:① 验收真源 [requirements/REQ-021](../../requirements/REQ-021-automations.md)(A1 节)· ② 方案 §7 [designs/2026-07-04-extension-hub-v3-universal.md](../../designs/2026-07-04-extension-hub-v3-universal.md) · ③ 新立 [ADR-022](../../../.claude/rules/adrs/ADR-022-automations.md)(随本 sprint PR)。
> **引擎事实(已核)**:v2 SDK `session.create({directory,title,agent})` + `session.prompt({sessionID,agent,parts,model})` **阻塞返回完整回复**(`{info:AssistantMessage,parts:[]}`)→ 执行链无需自建流消费;`session.abort` 可超时中断;config `agent` 注入(V1 schema `agent.<name>.{prompt,permission,mode}`)permission 支持 pattern→action 对象(`read:{"*":"allow","*.env*":"deny"}`)→ readonly 档可静态配死。

## 目标
「一句话 → 定时执行」的本地只读 MVP:侧栏「自动化」入口(复活孤儿 i18n key)+ 任务 CRUD + 主进程调度器 + SDK 执行链(readonly agent,无人值守零 ask)+ run 落盘 + 通知。**A2(standard 档/LLM 解析/熔断)与 A3(云档)不做**,A2 入口灰显「即将推出」。

## 抽取
REQ-021 **A1**(A2/A3 留册;A3 前置 = REQ-020 §2 已 shipped ✓ + REQ-022/B16 未就绪)。

## Task 表

| Task | 内容 | 对应 | 状态 |
|---|---|---|---|
| T1 | **纯逻辑**:`shared/automation-types.ts`(实体)+ `automation-schedule.ts`(cron 5 字段/interval/once 下次触发 + 错过判定)+ `automation-nl.ts`(中英确定性规则解析)+ 单测 | A1.2 / 验收⑥ | ☑ |
| T2 | **main 存储 + 调度器**:`alpha-automations.ts`(`~/.alpha/automations/<id>.json` CRUD,校验)+ `automation-scheduler.ts`(每任务单 timer→执行→重排;powerMonitor resume 重算;catch-up skip;并发 1 + overlap skip 记账;dailyRunCap 默认 24) | A1.3/A1.6 | ☑ |
| T3 | **执行链**:SDK(main 内 v2 client)`session.create`(title=「⏱ 自动化 · name」)→ `prompt`(agent=alpha-automation,阻塞)→ 最终回复落 `report.md`+`status.json` 进目标项目 `.alpha/runs/auto-<id>-<ts>/`(复用 alpha-workdir 守卫);超 maxDurationMin(默认 15)abort;系统通知 + 侧栏 badge 事件 | A1.4 | ☑ |
| T4 | **readonly agent 注入**:sidecar `injectAlphaConfig` 下发 `agent["alpha-automation"]`(read/glob/grep/list/webfetch/websearch/skill=allow;edit/bash/external_directory/doom_loop/question=deny;read `*.env*` deny;prompt 内联) | A1.5 / 验收② | ☑ |
| T5 | **UI**:侧栏「自动化」入口(定制中心下方,badge=失败任务数)+ 页面(列表:名称/人话周期/项目/下次运行/上次结果/开关 + 空态引导 + 全部暂停)+ 新建流(一句话→解析→预览卡逐字段可改→保存;解析失败降级手动周期)+ 详情(编辑 + 运行历史 + 回跳会话)+「应用未运行不执行」明示 +「登录时启动」设置 + platform 额度提示 | A1.1/A1.2/A1.7 | ☑ |
| T6 | **ADR-022 立档** + 收尾:alpha-check;CDP 视觉核验(列表/新建预览/详情;隔离实例构造 interval 任务实测触发出 run);四件套回写;PR | 验收①(部分)⑥ | ☑(真机批递延见下) |

## Gates
- 上游源码零改;执行链只走 SDK(ADR-002);无人值守绝不落 ask(readonly 档静态配死);失败行内 + 通知,不裸 toast。
- 诚实边界:应用未运行不执行(UI 明说,不装后台常驻);tz 暂用系统本地时区(实体存 tz 字段,跨时区支持后续)。

## 真机批(递延,并入 REQ-016 场次)
- 验收①全量:「每天 HH:mm」真机到点触发 + 通知横幅实拍;
- 验收②:readonly 档实测 edit/bash 实调被 deny、全程零 ask;
- 验收③⑤:构造重叠/睡眠错过用例;断电重启后 next-fire 恢复;
- 验收④:历史回跳会话真机走查。
