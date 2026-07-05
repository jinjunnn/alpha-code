---
id: REQ-021
title: 自动化(定时任务)完整需求:A1 本地只读 MVP → A2 增强 → A3 云档位(按优先级分期实现)
type: feature
priority: P2
status: verified
repo: A
created: 2026-07-04
sprint: 2026-07-04-s15-automations-a1
source: designs/2026-07-04-extension-hub-v3-universal.md(§5.7、§7、§8 M4)
---

## 背景/拍板
用户目标:在定制中心下方新增「自动化」,一句话描述 workflow → 定时执行。现状为零:侧栏「自动化」是孤儿 i18n key(`zh.ts:42-43`,零引用);A/B 两侧均无任何调度设施(已勘探)。**拍板(2026-07-04)**:只读权限档先行;**先制定完整需求,按优先级分步实现**——本档即完整需求,分期 A1 > A2 > A3。

引擎事实(可行性依据):permission 可静态配死消除全部 ask(`v1/config/permission.ts`,agent 级合并 `agent/agent.ts:277-293`)→ 无人值守可行;config `agent` 注入 + `prompt:{file:}` 生产可用 → 自动化专用 agent 零改上游可下发。

## 实体(全期共用)
`~/.alpha/automations/<id>.json`:`{ id,name,nlText, schedule{kind:cron|interval|once,expr,tz}, target{projectDir,agent,model?}, prompt, execution:local|cloud, permissionProfile:readonly|standard, budget{maxDurationMin,dailyRunCap}, overlapPolicy:skip, catchUpPolicy:skip, notify{system}, enabled, lastRun }`。运行记录写目标项目 `.alpha/runs/auto-<id>-<ts>/`(复用 ADR-019 schema、`alpha-workdir.ts` 守卫与原子写)。

## A1 —— 本地只读 MVP(最高优先)
1. 侧栏「定制中心」下方新增「自动化」入口(复活既有 i18n key);页面 = 任务列表(名称/人话周期/项目/下次运行/上次结果点/开关)+ 空态示例引导 + 全部暂停。
2. 新建流:一句话输入 → **确定性规则解析**(每天/每周 X/每月 N 日/每 N 分钟·小时/工作日/周末 + HH:mm,中英)→ 预览卡(周期·时间·项目·执行内容·权限档·预算,逐字段可改)→ 保存;解析不出周期时降级为手动选周期 + 描述作任务指令。
3. 调度器(Electron 主进程):每任务单 timer(算下次触发 → setTimeout → 执行 → 重排);`powerMonitor` resume 重算;错过按 catchUpPolicy 跳过;应用未运行不执行(UI 明示)+「登录时启动」设置项;全局并发 1,overlap skip(记录被跳过)。
4. 执行链:SDK `session.create({directory})` → `session.prompt`(agent=`alpha-automation`);会话标题前缀「⏱ 自动化 · <name>」;SSE session idle 判完成;超 `maxDurationMin` abort;最终回复存 `report.md` + `status.json` 落 runs;系统通知 + 侧栏 badge。
5. `alpha-automation` 只读 agent(config 注入下发):read/glob/grep/list/webfetch/websearch/skill=allow;edit/bash/external_directory=deny;doom_loop=deny;`*.env*` read 保持 deny;question 不可用。
6. 护栏:dailyRunCap(默认 24 次/日全局)+ 每任务 maxDurationMin(默认 15);platform-pays 模式新建/启用时显示「将消耗平台额度」提示。
7. 历史:任务详情页运行历史(时间/结果/摘要),点击回跳会话原文与 run 产物。

**A1 验收**:①「每天 HH:mm」任务真机到点触发并产出 run + 通知([[visual-verify-required]]);② readonly 档实测不弹任何 ask、edit/bash 实调被 deny;③ overlap/catch-up 按策略(构造重叠与睡眠错过用例);④ 历史回跳会话可用;⑤ 断电/重启后任务与 next-fire 恢复正确;⑥ 调度纯逻辑(下次触发计算/错过判定)单测覆盖。

> **拆行(2026-07-05,按 ADR-018 ID 纪律)**:A2/A3 已拆为独立需求 [[REQ-024]](A2 增强)与 [[REQ-025]](A3 云档位,B 侧阻塞中),消除本档「shipped 但有余量」歧义;以下 A2/A3 节保留为原始分期定义,**状态以新档为准**。本档 shipped 语义收窄为 A1。

## A2 —— 增强(次优先,A1 verified 后)→ 已拆 [[REQ-024]]
1. `standard` 权限档(可写,edit=allow、bash 危险类仍 deny)+ 启用警告与确认;A1 期间该选项灰显「即将推出」。
2. LLM 辅助解析(规则解析失败/复杂描述时,经当前会话模型一次性抽取 schedule+prompt,预览确认不变)。
3. 失败连败熔断(连败 3 次自动停用 + 通知)、手动「立即运行」、每任务预算(时长/日次数)UI、历史保留策略(默认保留 30 条/任务)。

**A2 验收**:standard 档写文件真机成功且警告链路完整;连败自动停用可复现;立即运行不干扰排程。

## A3 —— 云档位(最后,前置 REQ-020 §2 校验 + REQ-022 就绪 + B16 重启评估)→ 已拆 [[REQ-025]]
1. `execution:cloud`:保存时经 REQ-022 契约注册 schedule 到 B(envelope 复用 CloudJobEnvelopeSchema);离线也执行。
2. 开 app 拉回:按 REQ-022 `jobs?since=` 拉取错过的 run → `cloud_status/artifacts` → `.alpha/runs/`(复用 cloud-save-run 链路)。
3. 云任务的数据边界提示(ADR-021)在预览卡与详情页强制展示。

**A3 验收**:创建 cloud 档任务 → 退出 app → 到点 B 侧执行 → 重开 app 自动拉回 run 落盘;欠费/超配额被拒且 UI 可见原因。

## 非目标(全期)
事件触发(on push/webhook,另议)、多机同步任务定义、cron 可视化构建器(接受 raw cron 输入即可)、离线推送通知(微信/邮件,C/B 仓另议)、自动化编排多步 DAG(单 prompt 单会话即 MVP 语义)。

## 关联
新 **ADR-022(自动化)** 随 A1 实现 PR 立档(实体/调度/权限档/护栏/云档位边界);REQ-011(composer 预留位)候选之一可指向自动化入口(待拍板不变);REQ-020(硬前置 A3);REQ-022(B 侧);B16(A3 前重启评估)。
