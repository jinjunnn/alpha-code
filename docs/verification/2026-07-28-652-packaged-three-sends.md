---
title: "#652 打包版真机取证:同一会话连发三条"
kind: verification
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-28
review_after: 2026-10-28
---

# #652 打包版真机取证:同一会话连发三条(2026-07-28)

覆盖 [#652](https://github.com/jinjunnn/alpha-code/issues/652) 的 **AC1 复现/AC6 打包验证**。
本仓硬教训:dev 用 bun 测不出打包问题,而 #652 本身就只在打包版被撞到。

被测件:`/Applications/alpha-code.app`,`bun run ship:mac` 于 2026-07-28 04:49 产出并安装,
基线 = 本 PR 分支 `fix/652-session-send-v1`(`6e679615`)。运行处于 **owner 的登录态**
(PRO,平台代付),未登出、未删除任何会话。

## 被测会话正是事故现场

三条消息发进的是 **`ses_059262883ffeUtMlpjSplg9L7B`(标题「只回复A指令」)** ——
Issue 里那个会话本体:它的第一条 `只回复一个字：A` 于 2026-07-27 23:52:02 成功,
随后 23:52:40 / 23:53:52 两条(`B` / `C`)被 v2 受理后死于 401,**在界面上一个字都没出现**。
本次是在**同一个会话**、同一台机器、同一个模型(`deepseek-v4-flash` / `deepseek-byok`)上续发。

## 实测结果:三条全部渲染

| # | 发送时刻 | 自己的消息显示 | 引擎回复显示 | 用时 |
| --- | --- | --- | --- | --- |
| 1 | 04:52:42 | ✅ `回复恰好一个字:壹。这是第一条(652-761728)` | ✅ **壹** | 1.7 秒 |
| 2 | 04:53:15 | ✅ `回复恰好一个字:贰。这是第二条(652-761728)` | ✅ **贰** | 1.2 秒 |
| 3 | 04:53:19 | ✅ `回复恰好一个字:叁。这是第三条(652-761728)` | ✅ **叁** | 1 秒 |

三条都由**会话页 composer**(`data-alpha-composer="session"`)发出 —— 即 #652 里静默失效的那条路径。
渲染截图:[`assets/2026-07-28-652-packaged-three-sends.png`](assets/2026-07-28-652-packaged-three-sends.png)。

## 引擎侧证据:新引擎一次都没有被受理

判据不取「UI 看起来好了」,取**引擎持久化的地面真相**(`~/.local/share/opencode/opencode-alpha.db`):

```
-- v2 durable 表最后一次写入 = 事故当晚,本次运行零新增
sqlite> select max(time_created), datetime(max(time_created)/1000,'unixepoch','localtime') from session_message;
1785210833076|2026-07-27 23:53:53

-- 本次三条消息的正文,全部落在 v1 的 part 表
sqlite> select datetime(time_created/1000,'unixepoch','localtime'), substr(data,1,110)
        from part where data like '%652-761728%' order by time_created;
2026-07-28 04:52:42|{"type":"text","text":"回复恰好一个字:壹。这是第一条(652-761728)"}
2026-07-28 04:53:15|{"type":"text","text":"回复恰好一个字:贰。这是第二条(652-761728)"}
2026-07-28 04:53:19|{"type":"text","text":"回复恰好一个字:叁。这是第三条(652-761728)"}
```

- v2 `session_message` 表在 2026-07-27 23:53:53 之后**零新增** ⇒ `c.v2.session.prompt` 一次都没被调用。
- 本次运行的全部日志(`logs/20260728T085023/`)中 `session.next.*` 命中 **0 次** ⇒ 没有起过任何 v2 回合。
- v1 `message` 表在该会话新增 3 组 user+assistant(04:52:42 / 04:53:15 / 04:53:19),
  三条回复 `壹` / `贰` / `叁` 在 `part` 表各恰好 1 条。

事故当晚遗留在 `session_message` 里的 4 行(seq 20/21/24/25,两次 401)**原样保留**,未做处置 ——
老数据处置不在本轮范围。

## 取证方法

打包应用以 `--remote-debugging-port=9333` 启动,经 CDP `Runtime.evaluate` 驱动**真实 DOM**:
在 composer 的 `textarea` 上走原生 setter + `InputEvent`,再点击 `.a-comp-send`;
每一条都先等「自己的消息出现在时间线」、再等「回复出现在该消息之后且停止键消失」才发下一条。
断言的是**渲染出来的文本**,不是「函数被调用了」。

## 本次取证**不**覆盖的部分

- **审批停靠区**:本次三条都没触发工具审批,故 alpha 的审批面在 v1 回合下是否点亮**未取证**。
  已知事实:alpha 的审批 feed 消费 `permission.v2.asked`,而 v1 引擎的工具审批发的是
  `permission.asked` —— 见 [[ADR-036]] §后果,作为已知缺口交 owner 判断。
- **超过 10 分钟的回合**:token 刷新会重启 sidecar 并掐断在途 SSE(独立缺陷,另票),本次三条各 ≤2 秒,未触及。
- **附件 / 斜杠命令 / plan 与只读档**在打包版的发送路径本次未逐条走。
