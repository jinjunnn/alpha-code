---
title: REQ-109 T1 —— 真机启动时间线(冷/热)与「闪」归因定案
kind: verification
status: final
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-24
---

# REQ-109 T1(#530)真机时间线:过期 token 冷启动 + 热启动,「闪」归因定案

打包版(`ship:mac`,分支 feat/req109-t1-startup-instrumentation @ 71a1608ba)真机采集。
时间线文件:`userData/logs/<run>/startup-timeline.log`(单调 ms,main 时钟裁决)。
过期档为自然过期:app 退出 ≥39 分钟(TTL 15 分钟),未手改任何存储。

## 冷启动(run 20260724T052317,token 已过期)

| t(ms) | 事件 |
| --- | --- |
| 267 | app ready |
| 446 | boot token_check **expired:true** → 阻塞续期开始 |
| 682 | refresh 成功(**236ms**,快路径) |
| 690→1290 | sidecar fork→ready(600ms) |
| 1549/1578 | ready_to_show / **首显** |
| 1688 | composer mount(occurrence=1,全程唯一) |
| 1715 | 候选 B:auth_epoch+1(auth 首次 publish)→ chain1 被掐,chain2 重启 |
| 1832→2203 | chain2:account_summary 116ms → model.list **成功 371ms,32 模型** |
| 2159 | **候选 A:workspace `/Users/tide/Alpha`(default)→ `/Users/tide/app/alpha-code`(真实项目)** |
| 2259→4333 | chain3(A 触发重跑):model.list 二跑 2074ms(引擎多实例 bootstrap 期) |

候选 C(整页 reload):未发生(无 respawn)。

## 热启动(run 20260724T052444,token 未过期)

| t(ms) | 事件 |
| --- | --- |
| 279 | token_check expired:false → **零阻塞** 直接 fork |
| 283→891 | fork→ready(608ms) |
| 1132/1160 | ready_to_show / 首显 |
| 1271 | composer mount(occurrence=1) |
| 1298/1302 | 候选 B(epoch+1)/ 候选 A(workspace 切换,早于内容稳定) |
| 1435→3679 | chain3 model.list **一跑 2278ms**(引擎 10 实例 init 门控) |
| **3600** | **composer 第二次完整 mount(occurrence=2)**——root.mount 仍为 1、无 reload |
| 3631→3721 | remount 后链重跑:account_summary 30ms,model.list 90ms |

## 「闪」归因定案

1. **冷启动可见闪 = 候选 A**(provisional→real workspace 切换):首屏内容已就绪后
   ~2.16s 发生身份切换,链路全量重跑(chain3),UI 重绑定。B 在链起步期(首屏前)
   触发,代价是 account_summary 双跑,非可见闪;C 未参与。
2. **热启动可见闪 = 三候选之外的第四机制(本轮新发现)**:composer 全量 remount
   (occurrence=2,t≈3.6s)。机制:路由挂载吃 `resolvedSurfaces.latest`
   (renderer/index.tsx:487–500,REQ-088 surface admission),surface 解析随引擎
   init 迟到收敛而变化 → 路由树重建 → 页面根重挂,信号全部重置(epoch 重新从 1
   计)。非 reload(root.mount=1)、非 epoch 重建本身。
3. B(auth_epoch)两种启动均在 auth 首次 publish 时固定 +1,掐掉首条链重启一次
   ——固定开销项,应并入 T3 的链治理,但不是用户可见闪的主因。

## 对 T2–T5 的基线读数

- 冷启动(快续期 236ms)catalog 可操作 ≈**2.2s**——贴着核心断言 ≤2s 的线;
  串行 account 门控(116ms)+ A 触发的整链重跑是可省部分(T3)。
- 热启动首显更快(1160ms)但 catalog 可操作反而 ≈**3.7s**:多实例 init 门控下
  model.list 单跑 2278ms + 3.6s remount 重置。T3 的 generation/loading 语义 +
  第四机制治理是主要收益面。
- 慢续期路径本轮未触发(网络快);50ms/1.5s/3s/10s 分档进 T7 矩阵(注入代理已备)。

## 与 #528 AC 的对应

AC1/AC3/AC4 的时间线证据基座就位(标记目录见 startup-timeline 模块与 PR #552)。
第四机制(surface admission 迟到重挂)超出 #528 既列候选,建议登记为 REQ-109 范围内
新观察,由 owner 决定并入 T3 还是另开票。
