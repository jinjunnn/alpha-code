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

## 2. 回退链(按通道分叉,fail-closed;#314 语义)

失败先分类(`FailureClass`,catalog-channels.ts):**security** = R1–R13 验证失败/撤销/
过期(冻结攻击面)/无可验 trust/**snapshot 缺失(404)**(选择性阻断不可与部署偏斜区分);
**availability** = 纯网络失败(超时/断网/5xx;被 snapshot 钉住的成员拉取失败归 security)。

| 通道 | 失败类 | 回退链 |
| --- | --- | --- |
| `stable` | security | **绝不碰 v1** → stable LKG(带 reasonClass)→ none |
| `stable` | availability | 有已验证身份(= channel LKG)→ **v1 仅作字节级镜像**(version + payload sha256 与 LKG **精确相等**,否则弃用)→ LKG;无已验证身份(fresh install/清态)→ **禁 v1** → none |
| `preview` / `dev` | 任意 | channel remote → **同通道 LKG** → none;**绝不访问 v1** |

- **snapshot 一致性(R13,#314 消费面)**:取数可并行,采信按 trust → snapshot(须钉住本轮
  采信 trust 的精确字节+sequence)→ channel doc(entry 缺失=拒;精确字节+sequence 钉合)。
  snapshot 自身 R5:序列低于本 channel 缓存基线拒,等序异字节(replacement)拒。全过 →
  doc/payload/snapshot 作 **coherent set 随本 channel entry 一次原子落缓存**(per-channel:
  各通道刷新节奏不同,全局单槽会互相误伤);LKG 读取时重验签 + **R13-on-cache**(缓存
  snapshot 在场则缓存 doc 必须命中其 entry;pre-#314 存量 state 无 snapshot 位,放行一次,
  下次成功刷新补齐)。trust 持久化仍**先行**(撤销/轮换离线生效)—— 安全前移只限 trust,
  snapshot 绝不先于成员验证落盘(防基线投毒)。
- **v1 身份镜像约束**(#314 裁决,取代旧「失败即回 v1」):v1 的一切版本判断取自**已签
  body**(缓存元数据 `raw.version` 不进安全判断);R11 撤销集**不可验(无可验 trust)时
  v1 整面拒用**(不可采信从不可验 trust 派生的空撤销集,`readRevokedTargets` 返回 null);
  远端/304/缓存三路都过身份精确相等检查。
- v1(固定 URL)是 stable-only 遗产:非 stable 通道越级降 stable 内容 = 通道语义混淆,
  会进一步污染安装与 receipt —— 客户端一律 fail-closed。若发布侧希望 preview/dev 复用
  stable 内容,正确做法是签发指向同一 payload 的合法 channel doc。
- per-channel LKG(`catalog-channel-state.json` 按通道键)+ R3 mix-and-match 守卫
  (`doc.channel !== 请求通道` 拒)防通道串读。
- **部署顺序前置**:A 侧本语义 fail-closed 依赖 B 侧已发布 `channels/snapshot.json`
  (alpha-web #35,main@6a11567)——**A 发版前必须先完成 alpha-web 生产部署**,并由其
  deploy [7/7] 公网一致性探针确认。

## 3. 结果标注与 bundled 基线

- 结果带结构化 `channel` 字段(内容通道;v1 面恒 `stable`)与 `via` 字段(传输面:
  `channel-<name>` | `v1`)—— 消费方**不得解析 `via` 字符串推断通道**。#314 起非 remote
  结果带 `reasonClass`(security | availability);planner 对 security-none 落 bundled
  仅限**浏览**面并 loud 记录,激活面的 advisory 基线闸随 #315 落地。
- 全链 `none` 后的随包 bundled catalog 是**离线基线**(当前 = 构建期 stable 快照,与
  packaged seed 互钉):它不代表所选 registry 通道的当前内容,不得宣称 preview/dev
  freshness;planner 落账保留 `bundled` provenance。**该保底仅指 planner 与启动路径**:
  renderer(`catalog-source.ts`)对 `none` 的行为是保留上一次成功信号(remote/cache 或
  内置初值),不主动切换回 bundled。

## 4. 守卫测试索引

| 面 | 测试 |
| --- | --- |
| 三环境映射驱动拉取 URL + 结构化 channel | `packages/ui-mac/src/main/remote-catalog.test.ts`(#302 环境通道路由) |
| 非 stable 禁 v1(无/有 LKG 两变体,V1 URL 零请求) | 同上 |
| singleflight 并发合并 | 同上 |
| stable 通道 channel-first + v1 零破坏回退 + R11 | 同上(REQ-101 A 侧接线组) |
| 通道隔离 / mix-and-match 拒 | `packages/ui-mac/src/main/catalog-channels.test.ts` |
