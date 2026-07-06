# B11 静默失败复扫(S11 T4,PR #60)

> 基准说明:原「32 失败点」在登记册 §6.2 只有汇总行(32 点/22 静默 ~69%)+ 4 个具名锚点,**无逐条原表**;
> 本文以代码直扫的静默吞异常点重建清单作为复扫基线(与 4 锚点对齐),此后按本表增量维护。
> 状态:✅=有用户可见反馈 · 🆗=有意降级(豁免,理由在行内)· ⏭=后续(留 B11 行内追)。

## 呈现底座(本批新增)

- `alpha-ui/Banner.tsx` + `banner.css`:持久/阻断状态条(info/success/warning/error,语义色走 tokens;新增 `--a-info-subtle` 亮/暗)。与 Toast 分工:Toast=瞬时动作反馈,Banner=持久状态。
- Toast 唯一出口 = `pushToast`(定制中心私有 `.alpha-ext-toast` 已收编,kind 分级)。
- B23 探测:`ext-config.configHealth()`(jsonc 语法错 / 未知顶层 key,V1 顶键集自引擎 schema 提取)→ IPC `ext-config-health` → AlphaHome warning banner「全局配置未生效」+ 打开配置;5 单测;逃生 `ALPHA_CONFIG_HEALTH_DISABLE=1`。

## 复扫矩阵

| # | 失败点(file:line 修前) | 修前 | 修后 |
|---|---|---|---|
| 1 | 账户读取失败误显「钱包按量扣费」(`model-picker-inject`) | 静默误导(具名锚点#1) | ✅ 保留 `{error}` 判别式 → picker `error` 态 banner「账户信息读取失败」+ 重试;不再回退 balance |
| 2 | 侧栏「会员订阅」行读取失败显「未订阅」(`alpha-sidebar:1014`) | 静默误导 | ✅ error 态显占位「—」(状态未知不装已知) |
| 3 | project.list 失败侧栏空白(#4) | ✅ 已修(PR #24 error+重试) | ✅ 维持 |
| 4 | project.list 失败**首页**静默空白(`AlphaHome` 不读 store.error) | 静默 | ✅ 首页 error banner + 重试 |
| 5 | 首条消息发送失败(#6) | ✅ 已修(keep-text+toast) | ✅ 维持 |
| 6 | mcp.status 整表失败 hub 静默空白(`use-extensions:145`) | 静默 | ✅ hub 顶部 error banner + 重试 |
| 7 | 定制中心操作反馈走私有 toast(体系分裂) | 分裂 | ✅ 收编 pushToast,失败=error 级 |
| 8 | B23 全局配置被引擎静默清零 | 静默(32 点外第 33 类) | ✅ configHealth banner(语法错/未知顶键双病灶,B23 主案例=未知顶键) |
| 9 | splash 等待期零文案(最坏 ~60s 纯 logo,B20) | 静默 | ✅ 「正在启动引擎…」状态行 |
| 10 | 云任务终态无回执 | (新面) | ✅ CloudRunWatcher toast(PR #58) |
| 11 | sidecar 崩溃无自愈无提示 | 静默 | ✅ 自愈(PR #57);**连崩停手呈现已修(S19,2026-07-06)**:give-up → `sidecar-fatal` 事件 → 侧栏常驻 error Banner(「引擎已停止运行」)+ toast + 「重试」(阶梯清零 + 既有互斥 respawn 入口);**dev 真实全链 E2E PASS**(真杀监听进程 ×6 → give-up 日志 → banner 截图 → 重试恢复,见 S19 sprint 残单节) |
| 12 | `keyStatus`/`catalog`/`platformLive` 拉取失败(`model-picker-inject:52/120/132`) | 静默 | 🆗 豁免:有意降级到缓存/内置 snapshot(REQ-001 设计),picker 不空白、有「内置目录」徽标 |
| 13 | 会话 rename/share/delete/copy 失败(`use-projects:291/301/310/333`) | 静默 | ✅ 已修(S19,2026-07-06):rename/delete 返回 boolean → 调用方失败 toast;share 此前**丢弃 URL**(菜单形同无效)→ 现复制链接到剪贴板 + 成功/失败 toast;copy 早已有 toast |
| 14 | `createSession` 失败返回 undefined(`use-projects:253`) | 静默(调用方不导航) | ✅ 已修(S19,2026-07-06):侧栏 startChat 失败仍回退草稿(可用),但补 error toast「会话创建失败,已打开草稿」;首页 startChat 早有失败 toast |
| 15 | firehose `subscribe` 断流(`use-projects:378`/`use-extensions:235`) | 静默 | 🆗 豁免:SDK 自动重连,瞬断呈现反而制造噪音 |
| 16 | 登录整链失败静默(`alpha-auth.ts:239`,具名锚点#12) | 静默 | ✅ 已修(S19,2026-07-06):main 四失败点(provider error/回调残缺/state 不匹配/兑换失败)推 `auth-error` code → sidebar toast 按 code 给原因;已知边界=深链冷启动窗口未建成时事件丢失(与登录成功路径同界,ADR-017) |
| 17 | `promptAsync` 无超时(B20,`use-projects:273`) | 挂起无感 | 🆗 豁免(记录):长任务合法,加超时会杀正常流;弱网感知由 splash/banner 承担 |
| 18 | websearch keyless 限流 `orDie`(上游 core) | 静默 | 🆗 豁免:上游归属(R2),alpha 杠杆=env 关闸;剩余风险已记 ADR-009 |
| 19 | 启动失败落上游英文崩溃屏(C28 撤回后现状) | 有呈现但未品牌化 | 🆗 豁免:C28 边界下沉设计单列(BACKLOG 在册) |
| 20 | 骨架组件零引用(`Skeleton.tsx` 死代码,B20) | — | ✅ 已决(S19,2026-07-06):**删**——零引用死代码移除(`Skeleton.tsx` + `skeleton.css`);「真骨架」若日后需要属独立 UX 决策,git 历史留存 |

**记账**:20 项 —— ✅ 14 · 🆗 6(豁免有理由)· ⏭ 0。「有用户可见反馈或有意降级」合计 **20/20 = 100%**,本矩阵可落码面全清(失败态实拍归真机批)。**S19(2026-07-06)两批清完**:第一批 = 行13(会话操作 toast)+ 行20(Skeleton 死代码删);第二批 = 行14(createSession 失败 toast)+ 行16(登录链 auth-error 事件→toast)+ 行11 残余(连崩停手 banner+重试)。

## 关联
B11(底座)· B20(弱网,⊂B11 部分)· B23(§呈现底座)· C28(崩溃屏,单列)· PR #24/#57/#58/#60。
