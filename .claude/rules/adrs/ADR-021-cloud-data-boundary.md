---
id: ADR-021
title: 代码上云数据边界:diff-only 优先 + secrets 过滤 + 体积上限 + consent 挂钩 B16
status: accepted
date: 2026-07-04
related: [ADR-002, ADR-019, B/PA-7, B/PA-22]
---

## 背景
云能力有**两条数据出境通道**,边界此前无 A 侧设计(C9,册 T4.5;platform PA-7 已 flag 出境、PA-22 code-review pipeline 已 live 必然收代码):
1. **显式通道** —— 云任务 dispatch(`CloudJobEnvelope.input/objective`,经 MCP facade 或 `window.api.cloud.dispatch`);
2. **隐式通道** —— platform-pays 模型代理:登录默认走平台代付,**每条 prompt(含 agent 读进上下文的文件内容)持续出境**(R7 升级提醒)。

与 [[B16]](parked)分工:**C9 = 技术边界(本 ADR),B16 = 法律同意/告知**。B16 重启时直接消费本 ADR 的挂钩点。

## 决策(全部 alpha 自有文件,零改上游)
1. **显式通道·diff-only 优先**:凡向云传代码的任务(code-review 等 pipeline),A 侧产出 contract 时**默认 diff-only**(`git diff` 范围),不传全库;「全库/目录上传」不提供(与 NON_GOALS 精神一致,需求出现再议)。dispatch skill 的 contract 模板按此写死。
2. **显式通道·A 侧前置硬校验**(落点 `alpha-cloud-jobs.ts:dispatchCloudJob`,B 侧 schema 校验之前再挡一层):
   - **体积上限**:envelope 序列化 > **1MB 拒发**(loud error,不静默截断);
   - **secrets 内容扫描**:对 `input/objective` 做密钥模式扫描(API key/token/私钥块常见格式),命中即**拒发 + 指出字段**——不做静默改写(改写=送出损坏数据还装没事,违反反 placebo 纪律 C28);
   - **denied_paths 默认加固**:contract 未显式声明时,默认注入 `.env* / *.pem / .alpha/ / .git/` 等 denied_paths。
3. **隐式通道·定位为「告知 + 逃生」而非过滤**:prompt 内容**不做静默改写/拦截**(会破坏编码任务且给用户虚假安全感)。技术义务已由既有决策覆盖:A6(密钥 env 不出境,`{file:}` 通道)+ BYOK 模式可整体绕开平台代理(逃生门)。剩余义务 = **告知**,归 B16(见 §4)。
4. **consent 挂钩(B16 重启时直接可用)**:预留两个挂钩点,**时机拍板留给 B16**(parked,不代决):
   - 显式:**首次云 dispatch(per 项目)** 弹 consent(记录于 `.alpha/prefs.json`,ADR-019);
   - 隐式:登录选择 platform 模式时的告知文案(alpha-web 登录流内)。
   - B16 未重启前的现状声明:云 dispatch 仅由登录用户在会话内显式触发,每次 run 落 `.alpha/runs/<runId>/`(ADR-019)形成本地审计痕迹。
5. **回流侧(对称边界)**:云 → 本地已由 `alpha-workdir.ts` 落地(PR #55):写盘困在 `.alpha/`、敌意文件名消毒、100MB 体积帽——上行下行两侧都有界。

## 后果
- ✅ 两条通道各有明确定位:显式=硬校验可执行,隐式=诚实告知不装过滤;B16 重启零返工(挂钩点已定义)。
- ✅ 上行校验落在 main 单点(`dispatchCloudJob`),MCP facade 路径由 B 侧 schema 校验兜底(双层)。
- ✅ §2 的 secrets 扫描/体积帽/denied_paths 默认注入**已实现(2026-07-04,S14/REQ-020 T1)**:`ui-mac/src/main/cloud-envelope-guard.ts`(纯函数,单测 12 例覆盖三路径)前置于 `dispatchCloudJob`,错误 loud 回 renderer 行内呈现;B3 验收⑦ 同账,登录态真发被拒的实测归 S14 真机批。
- ⚠️ secrets 模式扫描有假阴性(新格式 token);定位为纵深一层,非唯一防线(A6 才是密钥主防线)。
