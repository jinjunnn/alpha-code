# REQ-055 dev 实例走查(2026-07-07,发版前验证)

> 环境:dev channel 实例(fresh renderer bundle `main-BpXaNEuB.js`,零 `alpha-composer-inject` 残留 —— grep 实证);CDP 只读驱动。
> 坑位记录:首两轮 CDP 误连了并行运行的打包版 0.1.1(其以 `ALPHA_CDP=1` 启动占住 9222)→ 假"旧代码"。退打包版后 dev 得 9222,标记全新。

## 结果(全 PASS)

| 验收 | 证据 |
|---|---|
| ① 同一组件两面渲染 | 首页 `[data-alpha-composer=home]` / 会话 `[data-alpha-composer=session]`;布局同构(r55-home.png / r55-session.png):`+ · 请求审批 · build · (◯) · 模型 · ⚡ · 发送` |
| ② effort 两面可点即生效 | 首页选 Sonnet → effort 启用,弹层 默认/低/中/高,点「高」chip 即变(零轮转零延迟);会话页保持「高」;未选模型时诚实禁用(title「选择模型后可用」) |
| ③ agent 列表零内部泄漏 | agent 弹层仅 `build 默认`(alpha-automation / -standard / alpha-readonly 全部不可见;config 注入 hidden:true + 列表过滤双保险) |
| ④ 上下文 ring | 会话页 ring 收养成功,停靠模型 chip 左侧(r55-session.png) |
| ⑤ 零工作区诚实反馈 | 模型 chip 无工作区时走 onNeedWorkspace(工作区选择器 + toast),与发送同分支(REQ-054① 关闭) |
| ⑦ SDK 参数化提交 | 首页发「1+1 等于几?」带 model=claude-sonnet-4.6 + variant=高 → 会话创建、**Build · Claude Sonnet 4.6 · 7秒** 回复「2」—— 显式 model 参数生效实证 |
| ⑧ 上游 composer 退役 | `[data-component=session-composer]` computed display:none;`composer-inject`/`slash-inject` 文件已删;body 带 takeover 标记 |
| ⑨ 单测 | composer-state 10 例(参数构造/斜杠路由/agent 过滤)+ 全套 503 pass;REQ-012 锚点清单再生(alive=195) |

## 残余(随 v0.1.2 真机批)

- 焦点圈修复(⑥)与 stop 按钮忙态(status 轮询)未在 dev 单独截图 —— 打包版实测;
- variant 上 wire 的引擎侧复证(REQ-029 机制已实证过,本次为参数通道换新);
- agent 列表在真机(引擎全 agent 集)下复核 plan/自建 agent 可见性。
