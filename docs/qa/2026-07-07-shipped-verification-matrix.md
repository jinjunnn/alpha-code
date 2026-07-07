# shipped→verified 验证矩阵(2026-07-07,用户指令「先把这些处理掉」)

> 对象:BACKLOG 全部 38 项 shipped(归档批后)。环境事实:已装包 = prod 签名包 v0.1.0 **构建于 7-6 20:31**(S27 场次二重打包,含 7-6 晚前全部代码,**唯 REQ-052 不在包内**);登录态已恢复(alpha-auth.json 7-7 09:29);REQ-053 事故已现场处置(引擎正常)。
> 纪律:verified 只按验收标准实测翻;**任何 UI 自动化走查不触碰确认/破坏类对话框**(C16 事故教训,REQ-050);破坏性模拟(DB 超前、断电)一律留用户在场场次。

## 本批已翻 verified(证据在行内/本档)

| ID | 证据 |
|---|---|
| D10 | 实读 `packages/ui-mac/package.json`:license:MIT / author / repository(jinjunnn/alpha-code)俱在 |
| REQ-026 | `alphacodeone.com/getting-started` 线上 200(nginx),装-登-用内容实测(关键词:下载×27/登录×37/安装×11) |

## 桶 α — 证据已基本存在,复核需求档验收句后即可翻(候选 ~7)

| ID | 现有证据 | 缺口 |
|---|---|---|
| REQ-004 | 桥接 spike 审计 + ADR-019 回填;冒烟随 B3(已 verified)兼验 | 对照需求档验收句逐条勾 |
| REQ-009 | 今日 CI 实测:guard 15-17s / typecheck 42-45s / tests 35-37s(两轮 PR) | 与提速前基线数字对账 |
| REQ-012 | 锚点契约测试在 505 测试集内常跑;已历经多轮真实 sync | 下次 sync tripwire 实跑留观 |
| REQ-027 | 今日本地 alpha-check + CI typecheck 双侧真实执行(REQ-052 开发期实抓类型) | 无(证据充分,可翻) |
| C8 / C9 | ADR-002 修订 / ADR-021 已成文且 accepted;C9 §2 已实现(S14)§4 已落(S25,B16 verified 兼验) | docs 类,retro 复核即翻 |
| REQ-022 | B 侧 prod e2e 三轮(准点触发/overlap skip/删除)已在册 | A 侧无新缺口,可翻(云 e2e 全链归 REQ-025) |

## 桶 β — 本机免 UI 自动化可验(日志/文件/HTTP 观察)

| ID | 验法 | 今日增量事实 |
|---|---|---|
| REQ-030 | main.log allowlist 行 + 模型选择器走查 | ✅ 半验:`allowlist synced {edition:'intl', models:9}`(intl 侧真机证据);cn 侧随 REQ-039 复验 |
| B9 | main.log updater 行为 + 真实发版 | 半验:`allowDowngrade:false`、10 分钟周期检查正常;**发版半边留 S29 v0.1.1 实测** |
| C3 | 日志目录观察 | ⚠️ **今日获反例**:启动期归档在工作(rotated 文件生成)但运行时无尺寸帽 → 单 run 21GB(REQ-053 事故)。**不可翻 verified**,修复挂 REQ-053 ③ |
| B4 | 引擎日志 + watcher 观察 | ⚠️ 部分反例:引擎启动仍为 `/Users/tide` 建 instance + fs-events watcher(单次,非循环;侧栏过滤半边 S20 已验)。「home 零 Instance」深层断言不成立,**谁在启动期请求 home 待查**(并入 REQ-053 排查) |
| C25 | 代码/单测 + 打包件抽查 | 单测在;真机像素半边随下批 |

## 桶 γ — 需 UI 走查(CDP/交互;**开跑前需用户点头**,C16 后新规;绝不驱动确认框)

REQ-036(对话式创建)· REQ-037(治理层;config 层 deny 已在 `~/.opencode/opencode.jsonc` 实见 = 半证据)· REQ-038(composer 一致性)· REQ-028(只读档三档 chip)· REQ-029(effort variants)· REQ-043(切换不误报)· REQ-033(手动加 MCP)· REQ-032(hub 远程 catalog 条目)· B11/B20(弱网/错误呈现)· B21(BYOK 改键即时生效)· B12(watcher 常驻/归档即时生效)· B23(strict-key 守卫)· REQ-016 残单(冷重启往返/历史回跳)· E2(钉钉条目可见;**真凭证 e2e 需用户提供凭证**)· REQ-002(已登录,发一条消息即验流式+计量大半)· REQ-025 A 侧开机拉回

## 桶 δ — 需真实外部条件(逐项列条件)

| ID | 条件 |
|---|---|
| REQ-052 | **下个签名包**(唯一不在装机包内的 shipped 项):启动日志 `legacy direct links migrated` + 两旧链消失 + `~/.alpha/skills` 就位 |
| B2 | 短 TTL 实测:env 调短 token 寿命 + 过期窗口等待(用户在场批) |
| REQ-039 | cn 租户/edition 账号复验(S27 未覆盖项) |
| REQ-031 | 欠费 failover 不可安全模拟 → B 侧演练窗口(与 alpha-platform dev-token 流程同批) |
| REQ-003 | 网关侧审查报告在册;弱网 UI 半边并入 γ 桶 B20 |
| C17 | DB 超前 = 破坏性模拟,**必须用户在场**(C16 后规则) |
| C14 | 升级期锚点;随下次 upstream sync 实测 |
| REQ-016 | 残单中「冷重启往返」可 γ 桶做;其余(历史回跳)用户在场 |

## 执行顺序建议

1. ✅ 本批:D10 / REQ-026 已翻;α 桶 7 项对照需求档复核后翻(下一批次,~1 小时);
2. γ 桶:**等用户点头**后 CDP 走查一次收 ~12 项(约一个场次;避开一切确认框,证据截图落 audits);
3. δ 桶:S29 发版收 REQ-052 + B9;用户在场批收 B2/C17/REQ-016 残单/E2 凭证;cn/欠费两项按条件解锁。


## 进度更新(2026-07-07 下午,S29-γ + S30 后)

**38 项累计:verified 15 / 剩 23。** 本轮新翻:REQ-016(冷重启+回跳两腿)· REQ-028(只读真拒写:文件未创建+零 ask)· REQ-029/REQ-043(会话内切档实测;机制已随 REQ-055 升级为 SDK 显式参数,dev 端到端复证)。

## 进度更新(2026-07-07 晚,S29-γ 补批「处理完剩余 23 项」)

**38 项累计:verified 21 / 剩 17。** 本轮新翻 **6 项**(含前置修复两把;E2/B4 诚实未全翻):
- **前置修复(阻断被清)**:sync-upstream 连败三天根因(husky 门 PR #143 + 冻结 add/add 冲突 PR #144)→ 真实 sync run 28847373458 成功,吸收 75 commits 零冲突。
- **REQ-009**:用户拍板重划验收(partial-clone ①③④ 划出);②⑤ 达标翻 verified。
- **REQ-022**:B 侧 prod e2e 三轮在册,A 侧无本项缺口,矩阵 α 桶复核翻 verified。
- **REQ-012 + C14**:真实 sync 两 tripwire 实跑(prompt「No changes」/ anchor「intact」)+ build strict transform 全绿,双双 verified。
- **REQ-033**:签名包 CDP 表单端到端真提交(config 落盘 + 密钥 {file:} 0600 + 账本 origin:created),verified。
- **B4**:数据层验收①②④达成,验收③单个残留 home Instance 移出为 [[REQ-058]];B4 保持 shipped(未翻,诚实)。
- **E2**:钉钉条目可见(半边 verified),首调用待真凭证。
- **C25**:非白名单 app 降级、白名单 app exec 二路实测 verified。

**剩 17 项卡点**(全部依赖外部条件,当前会话无法自主推进):
| 卡点 | 项 |
|---|---|
| 需你的凭证/账号 | E2 首调用(钉钉 Client_ID/Secret)· B21(BYOK 改键真 key)· REQ-039/REQ-030 另半(cn 租户账号) |
| 需你在场(破坏性/长窗) | C17(DB 超前)· B2(短 TTL 过期窗)· B23(全局配置故障注入) |
| 需网络工况/专项 | B20/B11 弱网批 · REQ-003 弱网 UI 半边 |
| 需 B 侧演练窗口 | REQ-031(欠费 failover)· REQ-025(云 cron A 侧拉回) |
| 纯观察积累/后续 | C3(轮转反例入 REQ-053,修复后复核)· B12(watcher 常驻长时观察) |
| 已翻半边/另半卡上 | REQ-002(核心链 ✅/过期路径=B2)· REQ-030(intl ✅/cn ⏳) |

> 本批 6 项全翻:REQ-009 / REQ-022 / REQ-012 / C14 / REQ-033 / C25。E2(半边)· B4(残留移出为 REQ-058)诚实未翻。上表 17 项 = 38 − 21。

**剩 23 项逐项卡点(能自主做的已做完/在做,以下全部依赖外部条件):**

| 卡点 | 项 |
|---|---|
| 等 v0.1.2 真机批(发版进行中,今天内) | REQ-052 已 verified;REQ-054/REQ-055 的 verified 门 = v0.1.2;C25 像素半边 |
| 需你的凭证/账号 | E2(钉钉 Client_ID/Secret)· B21(BYOK 改键需一把真 key)· REQ-039/REQ-030 另半(cn 租户账号) |
| 需你在场(破坏性/长窗) | C17(DB 超前模拟)· B2(短 TTL 过期窗)· B23(全局配置故障注入) |
| 需网络工况/专项 | B20/B11 弱网批 · B4 watcher 数 netlog 专项 · REQ-003 弱网 UI 半边 |
| 需 B 侧演练窗口 | REQ-031(欠费 failover)· REQ-022/REQ-025(云 cron A 侧拉回) |
| 需下次 upstream sync | C14 · REQ-012(tripwire 实跑) |
| 需拍板(验收含未做子项) | REQ-009(guard partial-clone ①③ 递延:做完 or 重划验收范围,一句话决定) |
| 半边已验、另半卡上述 | REQ-030(intl ✅/cn ⏳)· REQ-002(核心链 ✅/过期路径=B2)· B9 已 verified |
| 纯观察积累 | C3(轮转反例已入 REQ-053,修复后随批复核)· B12(watcher 常驻观察)· REQ-033(表单真提交一次) |
