---
title: Catalog channel consumption (A-side routing & fallback)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-15
review_after: 2026-10-15
---

# Catalog 通道消费(A 侧路由与回退契约)

本文钉住 alpha-code(A)拉取远程 catalog 时的**通道路由与回退语义**(REQ-098 #302)。
签名链/信任文档的 B 侧合同与 A 侧验签实现见 `catalog-channels.ts` 文件头(REQ-101 收口时
本文扩展为完整通道信任契约)。

## 1. 通道路由(main-owned,冻结快照)

- 通道 = 冻结环境快照的 `registryChannel`(`alpha-environment.ts`:prod→`stable`、
  beta→`preview`、dev→`dev`),启动期一次解析,运行期不可变;renderer 无输入权
  (唯一 IPC `ext-remote-catalog` 不收参数)。
- `refreshRemoteCatalog(userDataPath, channel, deps?)` 的 `channel` **必填无缺省** ——
  缺省值会让新调用方静默重现「恒请求 stable」缺陷(2026-07-14 审计 REQ-098 缺口)。
  composition root(`index.ts`)把同一份冻结值注入 IPC handler、planner 与启动预热。
- 并发合并:同 `(userDataPath, channel)` 的在途拉取 singleflight 合并(防启动预热/IPC/
  planner 并发重复网络往返与旧 sequence 晚写)。

## 2. 回退链(按通道分叉,fail-closed)

| 通道 | 回退链 |
| --- | --- |
| `stable` | channel remote → **legacy v1 兼容面**(远端 → v1 缓存,R11 撤销同样生效)→ stable LKG → none |
| `preview` / `dev` | channel remote → **同通道 LKG** → none;**绝不访问 v1** |

- v1(固定 URL)是 stable-only 遗产:非 stable 通道越级降 stable 内容 = 通道语义混淆,
  会进一步污染安装与 receipt —— 客户端一律 fail-closed。若发布侧希望 preview/dev 复用
  stable 内容,正确做法是签发指向同一 payload 的合法 channel doc。
- per-channel LKG(`catalog-channel-state.json` 按通道键)+ R3 mix-and-match 守卫
  (`doc.channel !== 请求通道` 拒)防通道串读。

## 3. 结果标注与 bundled 基线

- 结果带结构化 `channel` 字段(内容通道;v1 面恒 `stable`)与 `via` 字段(传输面:
  `channel-<name>` | `v1`)—— 消费方**不得解析 `via` 字符串推断通道**。
- 全链 `none` 后的随包 bundled catalog 是**离线基线**(当前 = 构建期 stable 快照,与
  packaged seed 互钉):它不代表所选 registry 通道的当前内容,不得宣称 preview/dev
  freshness;planner 落账保留 `bundled` provenance。

## 4. 守卫测试索引

| 面 | 测试 |
| --- | --- |
| 三环境映射驱动拉取 URL + 结构化 channel | `packages/ui-mac/src/main/remote-catalog.test.ts`(#302 环境通道路由) |
| 非 stable 禁 v1(无/有 LKG 两变体,V1 URL 零请求) | 同上 |
| singleflight 并发合并 | 同上 |
| stable 通道 channel-first + v1 零破坏回退 + R11 | 同上(REQ-101 A 侧接线组) |
| 通道隔离 / mix-and-match 拒 | `packages/ui-mac/src/main/catalog-channels.test.ts` |
