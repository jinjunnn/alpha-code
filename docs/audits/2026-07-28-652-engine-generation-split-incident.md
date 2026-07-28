---
title: "#652 事故解剖:一次夹带的引擎代次切换,和四道假闸门"
kind: audit
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-28
---

# #652 事故解剖:一次夹带的引擎代次切换,和四道假闸门(2026-07-28)

> **这次的教训是「绿灯是假的」,不是「有人写错了代码」。**
>
> 一行改路由的代码写错,是日常;**2526 条测试全绿、跨模型对抗审计通过之后,发出一个「每个
> 会话只能发一条消息」的产品,并且四天没人发现**,是闸门的问题。下面前两节是因果链,第三节
> 是当时亮的绿灯,第四节逐条解剖这四道绿灯为什么本来就抓不到它 —— 第四节才是本文的主体。
>
> 翻到 PR#569 的人:那次交付的 UI 成果是真的、也全部保留了;它的代价在本文里。

覆盖 [#652](https://github.com/jinjunnn/alpha-code/issues/652)(P0)。
修复的真机取证在 [`../verification/2026-07-28-652-packaged-three-sends.md`](../verification/2026-07-28-652-packaged-three-sends.md);
方向裁决在 [[ADR-036]];由本次事故立的类级规矩在 [[ADR-037]]。

## 用户看到的

打包版桌面应用里,**每个会话只能发出第一条消息**。第二条起:输入框清空,此后没有任何反应 ——
没有报错、没有失败标记,**连用户自己刚打的那句话都不显示**。存活时间:
`5bf362ffa` 合入(2026-07-24)→ `40bdb12c` 修复(2026-07-28),四天。

## 因果链

**触发提交:`5bf362ffa` / PR#569**,标题
`REQ-125 C7 —— AlphaComposer 直挂 + 审批/任务停靠区 + v2 durable 发送与档位协议`,2026-07-24。

1. **一次引擎代次切换被夹带在一次 UI 重构里。** 该 PR 正文 7 条 bullet,主语依次是:直挂
   composer、上下文用量 ring、审批 dock、提问卡/任务清单卡、live status/stop、斜杠命令来源
   登记、surface manifest 重锚 —— **全部是 UI**。「换引擎代次」在正文里只剩第 5 条中间的
   「发送即排队」五个字,以及标题末尾的「v2 durable 发送与档位协议」。
   复现:`git show -s --format=%b 5bf362ffa | awk '/^\* fix\(ui-mac\).*Codex/{exit} {print}' | grep -c '^- '` → `7`。
2. **切换只覆盖了一半入口。** 首页新对话 `startChat`
   (`packages/ui-mac/src/renderer/sidebar/use-projects.ts:320`)仍走 v1 `session.promptAsync`
   —— 能用;会话页 composer 改走 v2 `c.v2.session.prompt` —— 必失败。
   于是**同一个会话第一条 v1、第二条起 v2**,症状精确地落在「第二条」上。
3. **新代次拿不到 provider 凭证。**
   `packages/ui-mac/src/main/alpha-config-injection.ts:413` 为 v2 目录逐 provider 剥掉
   `apiKey`;其 `:393-395` 的前提注释白纸黑字写着「推理仍走 v1(有 `{file:}`/`{env:}` 解析),
   故 v2 文件一律剥掉 apiKey」。**这次切换正是作废该前提的那次改动,而注释与实现都没有跟改。**
4. **凭证缺失被降级成了远端 401。** `packages/llm/src/route/client.ts` 在 `5bf362ffa` 上的
   `:253` 与 `:275` 都是 `auth: routeInput.auth ?? Auth.none`,而 `packages/llm/src/route/auth.ts:96`
   的 `Auth.none` 是 `auth((input) => Effect.succeed(input.headers))` —— **未声明鉴权的 route
   会把没有 `Authorization` 头的请求照常发出去**。失败点因此被推到对端、原因被字符串化:
   整类「凭证通道变暗」都表现为「远端拒绝」。
   实测:v2 的 POST 回 **200** 并给出 `{"admittedSeq":…,"delivery":"steer"}`,随即 2 毫秒内
   `session.next.step.failed` / `Provider request failed with HTTP 401`。
   **全库统计:v2 受理 8 次、started 8 次、failed 8 次,零成功。**
5. **UI 同时失明,所以症状是「什么都没发生」而不是「失败了」。** 两条相互独立的断裂:
   - 渲染层**没有任何 `session.next.*` 的 reducer**。全仓仅 1 处提及,还是一句声明不消费它的
     注释:`git grep -n "session\.next\." 5bf362ffa -- packages/ui-mac/src/renderer` →
     `alpha-ui/composer-state.ts:39: * 不消费 \`session.next.agent.switched\` 事件…`。
   - **两代消息写两张表且互不投影**:v1 写 `message` / `part`,v2 写 `session_message`
     (`packages/core/src/database/migration/20260427172553_slow_nightmare.ts:9`)。
   合起来:**用户自己发的那条消息已经写进数据库了,却永远不会显示。**

一句话总因:**一次没有被当成决策的代次切换,切到了一个没有凭证链的代次上;而失败通道和
显示通道恰好都不通,于是它以「静默」的形态存活了四天。**

## 它当时通过的闸门

`5bf362ffa` 的提交正文原文记录了合并前的本地门:

```
ui-mac typecheck 绿
bun test src  2526 pass / 0 fail
north-star 零上游路径
```

以及同一次交付里的对抗审计一轮:**Codex 对抗审计第 1 轮 2 Blocker + 4 Major + 2 minor 全修**
(修复内容见 `5bf362ffa` 正文第二段:permission feed refetch 竞态、独立兜底面 fail-closed 等)。

**这些闸门没有一个是敷衍的。** 它们全都真跑了、真红过、真修过。问题不在执行,在**它们断言的
东西里没有一样能证明「第二条消息发得出去」**。

## 四道闸门为什么本来就抓不到它

这是本文的主体。四道各自失效的形态不同,合起来正好覆盖了这条链路的全部路径。

### 1)唯一那条「发两次」的用例,两次都判成新会话 —— 后续消息分支覆盖率 0%

`packages/app/src/components/prompt-input/submit.test.ts`(`40bdb12c^`)是全仓唯一连续调用两次
`handleSubmit` 的用例:

- `:27` `let params: { id?: string } = {}`,`:97` `useParams: () => params`;
- `:259` `beforeEach` 里 `params = {}`;
- 全文件只有 `:398` 与 `:433` 两处把它设成 `{ id: "session-1" }`,而**那条发两次的用例
  (`:294` / `:296`)不在其中**。

于是两次提交都跑在「无会话 id」上,**两次都走新会话分支**。它断的是
`expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])` —— 两个**新建**会话。
「同一会话里的第二条消息」这条分支,**覆盖率是 0%**。

同一文件的假 SDK 还叠了一层:`:82` `promptAsync: async () => ({ data: undefined })` —— 瞬时返回、
永不失败、不区分成败。即便走进了后续消息分支,它也不可能红。

> **形态:空闸门。** 用例名字对、测试真跑了、断言也真的成立 —— 但它证明的不是它看起来在证明的
> 那件事。

### 2)E2E 全仓没有任何测试提交过消息,mock server 连 prompt endpoint 都没有

- `git grep -in "promptAsync\|session\.prompt" 40bdb12c^ -- packages/app/e2e | wc -l` → **0**。
- `packages/app/e2e/utils/mock-server.ts` 的路由表(`:57`–`:118`)是:
  `/global/event`、`/event`、`/global/health`、`/api/session`、`/experimental/capabilities`、
  `/permission`、`/question`、`/session/status`、`/vcs/diff`、`/file`、`/file/content`、
  `/find/file`、`/api/reference`、`/session/:id`、`/session/:id/message/:id`、
  `/session/:id/todo`、`/session/:id/{children,diff}`、`/session/:id/message`。
  **没有任何一条发送/prompt 端点。**

E2E 只覆盖「打开、浏览、滚动、切换」。**产品的核心动作 —— 发一条消息 —— 从来没有被端到端跑过
一次。** 一个连 prompt endpoint 都不存在的 mock server,结构上就不可能抓到发送链路的任何缺陷。

> **形态:枚举漏。** 最先漏掉的,是我们自己产品里最核心的那个动作。

### 3)多轮时间线测试用手搓的消息对象伪造轮次 —— 只证明能**显示**第 2 轮,没证明能**发起**它

`packages/ui-mac/src/renderer/alpha-ui/session-timeline/timeline-model.test.ts:33-60` 定义了
`userMsg()` / `assistantMsg()` 两个工厂,直接构造 `UserMessage` / `AssistantMessage` 对象喂给
`projectTimelineRows`;渲染侧的 `session-timeline-test-runtime.tsx:99` 则直接
`setTimelineRows(next: TimelineRow[])` 把行灌进去。

两条路径都**从消息已经存在的那一刻开始**。「消息是怎么产生的」——也就是本次坏掉的那一段——
在这些测试里**根本不在被测范围内**。多轮时间线因此可以在发送完全瘫痪的情况下全绿。

> **形态:条件门。** 前提(消息已存在)本身就是绕过口:测试的起点在缺陷的下游。

### 4)源码文本断言:断的是源码里有没有那段字面量

`packages/ui-mac/src/renderer/alpha-ui/takeover-adapter-coexistence.test.ts` 在 `5bf362ffa` 上的
`:140-142`:

```ts
expect(composer).not.toContain(".promptAsync(")
expect(composer).toMatch(/c\.v2\.session\s*\.prompt\(\{/)
expect(composer).toContain('delivery: "queue"')
```

`composer` 是 `read(path.join(ALPHA_UI, "alpha-composer.tsx"))` —— **一个字符串**。这三条断言的是
「源文件里写没写这几个字符」。缺陷恰恰是「写了这几个字符、而这条链路发不出去」:
**这道闸对本 bug 不仅通过,而且是热情地通过 —— 它把出错的那行代码作为正确的证据。**

> **形态:假闸门。** 断言源码文本,不断言可观测结果。这是四道里最危险的一道:它看起来是专为
> 这次切换设的闸,实际上它保护的是**改动本身**,不是**行为**。

### 合起来

| 链路环节 | 谁应该守 | 实际 |
| --- | --- | --- |
| 发起第二条消息 | submit 单测 | 两次都判新会话,该分支 0% |
| 端到端发一条消息 | E2E | 全仓零发送,mock 无 prompt 端点 |
| 多轮渲染 | 时间线测试 | 从「消息已存在」起测,起点在缺陷下游 |
| 代次选择正确 | 共存棘轮 | 断源码字面量,把错误当证据 |

**四道闸门,零道断言可观测行为。** 2526 这个数字与这条链路的安全性之间没有任何关系 ——
这正是「整包全绿」作为判据的失效方式。

对抗审计同理:Codex 第 1 轮真找出了 2 Blocker + 4 Major,但它审的是**被提交的那批改动写得对不对**
(竞态、fail-closed、stale 拒收),而这次的缺陷是**这批改动不该以这种形状被提交**。
形状问题不在 diff 审计的视野里 —— 这是 [[ADR-037]] 决策 2 存在的理由。

## 修复

**PR#666 / `40bdb12c`**,`fix(#652): 会话发送回到单一引擎代次(v1 promptAsync)+ Auth 默认 fail-closed`。三件事:

1. **发送回到单一代次。** 会话页 composer 与时间线续钮改回 `c.session.promptAsync`,与首页同一条;
   档位随每条消息走 v1 `PromptInput.agent`,v2 的 switchAgent + 权威读 + CAS 回滚账本一并退役。
   REQ-125 的 UI 成果一行未动。方向裁决与其重新迁移的三条准入判据见 [[ADR-036]]。
2. **`Auth` 默认 fail-closed。** `packages/llm/src/route/client.ts:255,277` 的默认从 `Auth.none`
   改为 `Auth.unset`(`packages/llm/src/route/auth.ts:118`):未声明鉴权 = **发送前即拒**,
   失败具名(`MissingCredentialError`),不再由对端回 401;只有 provider 显式声明 `Auth.none`
   才允许无头发出。该修复与代次选择无关,两代都成立。
   新闸 `packages/llm/test/auth-fail-closed.test.ts`(断言 **0 次 HTTP** + 具名失败)。
3. **一条端到端连发三条的行为闸。**
   `packages/ui-mac/src/renderer/alpha-ui/session-workspace/session-second-send.test.ts` →
   `packages/ui-mac/test-component/session-second-send.cases.ts`:生产 `AlphaComposer`(home 与
   session 两个 mode)与生产 `AlphaSessionTimeline` 挂在同一棵 Solid 树上,共用一个**同时挂着
   v1/v2 两条发送端点**的假 sidecar(两条都照生产实测行为实现,harness 不预设哪条是对的);
   第 1 条走首页、第 2/3 条走会话页,**断言时间线上渲染出来的回复**。
   该 cases 文件顶部记录了它的变异验证:把会话发送改回 `c.v2.session.prompt`,第一条用例必须转红。

三道闸都登记进 `scripts/gate-files.tsv`,并且 `takeover-adapter-coexistence.test.ts` 那行的
`delegates_to` 列被补上 `session-second-send.test.ts` —— **源码棘轮从此必须点名它委派的行为闸**。

真机取证(打包版、事故现场那个会话、连发三条全部渲染、v2 表零新增):
[`../verification/2026-07-28-652-packaged-three-sends.md`](../verification/2026-07-28-652-packaged-three-sends.md)。

## 固化

- [[ADR-036]] —— 会话发送保持单一引擎代次(**这一条链路**的方向裁决)。
- [[ADR-037]] —— 引擎代次切换是一次独立变更(**这一类改动**的形状规矩:独立票/独立 PR/独立
  决策/能力清点表/行为判据/禁半代次迁移,每条附「如何检验某个 PR」)。
- 组合级同类条款见
  [alpha-work `governance/delivery-standard.md`](https://github.com/jinjunnn/alpha-work/blob/main/governance/delivery-standard.md)
  的「运行时代次替换」条。

## 本审计不覆盖

- **老数据。** 事故期间落在 `session_message` 里的失败记录原样保留,未做处置。
- **审批面缺口。** 回到 v1 后 alpha 的审批 dock 消费 `permission.v2.asked`、而 v1 引擎发
  `permission.asked`(`packages/schema/src/v1/permission.ts:61`),已登记为已知缺口
  ([[ADR-036]] §后果),不在本次范围。
- **其余闸门的普查。** 本文只解剖了这条链路上的四道。「还有多少道闸门断的是源码文本而不是
  行为」是一次独立的普查,不在本审计内。
