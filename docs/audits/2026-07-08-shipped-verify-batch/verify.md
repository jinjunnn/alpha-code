# 2026-07-08 shipped 残验批(用户指令:清 shipped 待真机 verify)

**环境**:今晨 REQ-060 真机批的 ship:mac 装机实例(/Applications/alpha-code.app,dev 渠道 userData `ai.opencode.desktop.dev`,CDP 9222,连续运行 4h55m,含上午高强度 fan-out 验证批流量);引擎 `http://127.0.0.1:55373`(凭证经 `window.api.awaitInitialization`)。执行者:Claude(会话内),证据均为当场实测输出。

## ✅ REQ-060 —— 会话级残验(最后一腿)PASS

真 LLM 会话实调 `alpha_register`,四断言全过:

1. **真会话**:POST /session(directory=/Users/tide/req060-session-verify,全新 scratch 项目)→ `ses_0bf475d4dffeqmhK6rI4Ywcs0v`;POST message(deepseek/deepseek-chat,agent build)提示模型注册 command → 模型实调工具,回复「已注册 verify_req060 命令,下次消息起可用。」
2. **落盘正确**:`<proj>/.alpha/alpha.jsonc` 原子落 `command.verify_req060 = {template: "echo req060-session-ok", description: "REQ-060 会话级验证"}`;**项目目录内唯一生成物 = `.alpha`,零 `.opencode`**(ls 实证)。
3. **自动 reload 生效**:数秒后 GET /command?directory=… 即见 `verify_req060`(source: command)——「下次消息可用」承诺兑现,无需重启。
4. **相邻隔离**:GET /command?directory=/Users/tide/app/kama-bot-local 零泄漏。

→ REQ-060 全残清零,翻 verified。

## ✅ C3 —— 日志治理运行期真机腿 PASS(带既知限制)

- **启动期轮转真档案**:`~/.local/share/opencode/log/` 存在 `opencode.20260707T115443.log`(97MB)与 `opencode.20260707T115741.log`(34.5MB)两份归档 —— 超 25MB 阈值在启动期被归档的真实发生记录(REQ-053 事故日志的收尾);当前 `opencode.log` 仅 166KB(自 7-07 19:58 起跨多个 app run),留存数 ≤3 符合设计。
- **netlog 默认关**:userData 全树 netlog 文件计数 = 0(`ALPHA_NETLOG` 未设)。
- ⚠️ 既知限制不变:轮转仅发生在启动期,运行期无界增长由 [[REQ-053]] ③ 追踪(非 C3 验收面)。

## ✅ B4 —— 冷启动 Instance 面复核 PASS

当前 `opencode.log`(覆盖 7-07 晚起多个 run)共 93 条 `creating instance`,目录分布**全部**为:真实项目(alpha-code / kama-bot-local / Documents 系 3 个用户自有项目)+ home(`/Users/tide`,15 次 —— [[REQ-058]] 已拆出独立追踪的既知单点)+ 上午验证批 scratch 目录(req060-* / b21-test)。**零 `/` 根 Instance、零巨型目录风暴**;`/project` 里的 `/` 为全局 worktree 约定非目录 Instance(ADR-008),与日志互证。重复计数源于 dispose→重建循环(上午批高频 dispose),属预期。

## ✅ B12 —— 长时内存/watcher 实测 PASS(带测量 nuance)

连续运行 4h55m(含上午高强度验证批 + 93 次 instance 创建/dispose 循环)后:main 进程 RSS 146MB、engine(utility)110MB、第二 utility 44MB;kqueue watcher 计数全进程个位数(main 9 / utility 7·4 / gpu 3)。无累积增长迹象。⚠️ nuance:macOS 上 FSEvents 型目录监听无 fd 痕迹,kqueue 计数非全量;RSS 稳定是本项核心担忧(watcher 常驻致内存失控)的实质证据。

## ✅ B21 —— 状态列滞后修正(证据早已在册)

行内备注已含完整真机 verified 记录(2026-07-07,装机 v0.1.2,用户真 key 在场:改键 respawn/删键吊销/复键全链,证据 audits/2026-07-07-b21),唯状态列未翻 —— 本批修正为 verified,无新增验证动作。

## ✅ REQ-057 —— ship:mac 验签链(de-facto 证据)

PR #142 的验证方法(真跑 ship:mac 全链 + 实启 app)已于当日执行;**当前正在运行的实例本身就是该链产物**(今晨 ship:mac → install-local(含 3.5 验签/ad-hoc 补签步)→ 实启 → 承载全天验证批)。翻 verified。

## 未动残留(11 项,各自所需条件)

| 项 | 需要什么 |
|---|---|
| REQ-056 | 五项修复的装机像素走查(CDP 多步交互,留专场) |
| B11 / B20 | 失败态实拍需人为制造 sidecar 连崩/弱网(对在跑实例有扰动,留专场) |
| REQ-002 | ④ logout 复验 = 主动登出(破坏登录态,需用户同意时机);token 过期路径已由 B2 verified 覆盖 |
| REQ-003 | 弱网 UI 呈现(同 B20 专场) |
| REQ-025 | 登录态 A↔B 云自动化 e2e(需平台代付登录态 + B 侧配合) |
| REQ-030 | 运营者 intl picker 全量 = 用户本人自验 |
| REQ-031 | 欠费真实切换 = 运营演练 |
| REQ-038 | 真机 IME 输入(需人工输入法操作)+ 空工作区提示像素 |
| REQ-039 | 真实 cn 租户 prod 云任务(放量前执行) |
| E2 | 钉钉真凭证(DINGTALK_Client_ID/Secret,等用户提供) |
| C3→REQ-053③ | 运行期增长治理属 REQ-053,不在本批 |
