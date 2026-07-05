# Sprint 2026-07-05 S16 —— 真机验证收尾批(REQ-016 全量)

> **给接手的新 session**:验收真源 = [requirements/REQ-016](../../requirements/REQ-016-realmachine-verify-batch.md)(2026-07-05 范围刷新版,A–F 六组);方法与手法见档内「方法」节 + memory [[visual-verify-required]]/[[ext-hub-v3-roadmap]](截图陷阱:fromSurface:true、hub 入场动画 1.5s、Portal 宿主 z-index)。
> 本批是 **ADR-014 v3 与 ADR-022 转 accepted 的唯一门**;A6 verified 解 R3 门控(解锁 A2b/E2/E6)。

## 目标
把 S9–S15 攒下的全部「verified 待真机」在**当前 HEAD 的 prod 签名+公证包**上一次清账;能翻 verified 的全翻,agent 做不了的(破坏性/侵入)收敛成明确的用户批残单。

## 抽取
REQ-016(headline,X)。顺带回写受益 ID:A6/A2/B1/B3/B6/B11/B21/B22/B23/D1/C3/REQ-001/REQ-004/REQ-006/REQ-010(抽查)/REQ-011/REQ-014(复现)/REQ-018/REQ-019/REQ-020/REQ-021/REQ-023/REQ-007③。

## Task 表

| Task | 内容 | 对应 | 状态 |
|---|---|---|---|
| T0 | 重 ship:alpha HEAD → prod 签名+公证 → 装机;核验版本/asar 标记/staple/spctl + 登录态保留 | 前置 + C 组 C5 | ☑ notarization successful + spctl accepted + staple validate;asar 标记全含 M2-M4 |
| T1 | 静态/包体核验:resources/{agents,plugins,skills} 进包;NOTICE;fuses/entitlements 抽查 | C5、B7⑤部分 | ☑ agents/plugins/skills/NOTICE/alpha-ext 全在包 |
| T2 | CDP 视觉批(登录无关):REQ-011 首页、REQ-001 picker、hub 9-tab、B23 坏配置检测、B1/D1 日志计时 | F 组 | ☑ REQ-011/001/B1/D1 verified;B23 检测 verified(banner 冷启动残余) |
| T3 | 登录门控功能批:A6 env dump(解 R3)→ in-app 四步×4 类(REQ-018/019/006/023)→ 卸载净除 | A1、B 组 | ☑ A6 解 R3;四类装卸+桥+净除全通;**修 P1 卸载 bug**;迁移开门残余 |
| T4 | 云批:platform 双态 → guard 真发被拒 → code-review dispatch 端到端 | A4、D 组 | ☑ guard 拒发实证;dispatch→live 执行→completed 往返;回流 saveRun 残余 |
| T5 | 自动化批:once 到点触发 → readonly deny 零 ask → 错过 skip → 持久化机制 | E 组 | ☑ E1/E2/E3 PASS;E4 机制验证;冷重启往返/历史回跳残余 |
| T6 | 复现尝试:B22 / REQ-014 | F 组 | ⏭️ 复杂触发未复现,残余 |
| T7 | 回写:audits 证据 + BACKLOG/需求档翻 verified + ADR-014 v3/ADR-022 转 accepted | 完成定义 | ☑ |

## Gates
- 证据先行:每项截图/日志/命令输出落 `docs/audits/2026-07-05-req016-realmachine-batch/`,再翻状态(反 placebo,[[visual-verify-required]]);
- 用户环境可逆:动用户真实配置前必备份、用后还原(opencode.jsonc、日志、OS 外观);
- **不做**(留用户批):B2 短TTL(改 prod alpha-web env)、REQ-002④ logout(登出后需人工重登)、真断网(切 Wi-Fi 会断本 agent 命脉,先以 nettop 零流量证据替代)、真睡眠(pmset 需 sudo);
- token 消耗类(B6 prompt / B3 dispatch / 自动化真跑 / REQ-007③)控制在最小样本。

## 结果(2026-07-05 回填)
- **翻 verified(12)**:A6(解 R3 门控 → 解锁 A2b/E2/E6)· REQ-018 · REQ-019 · REQ-020 · REQ-021 A1 · REQ-023 · REQ-006 · REQ-011 · REQ-001 · B1 · D1;B6 部分(接缝加载 verified,alpha_ping 执行残余)。
- **ADR 转 accepted**:ADR-014(v3)· ADR-022。
- **修 P1 bug**:已安装 tab 卸载/更新对账本条目静默失败(Solid store Proxy 未 unwrap 过 contextBridge)—— `use-extensions.ts` unwrap 两处 + 回归锁测 `use-extensions-ipc.test.ts`。**只在打包态真机暴露**。
- **证据**:[audits/2026-07-05-req016-realmachine-batch/verify.md](../../audits/2026-07-05-req016-realmachine-batch/verify.md) + 20 截图 + a6-env-dump。
- **残余(留用户批 / 下批)**:B2 短TTL、REQ-002④ logout(需人工重登)、迁移开门(需 `ALPHA_MIGRATE_ENABLE=1` 重启)、回流 saveRun(原生目录选择框)、卸 uv 像素、git 真克隆、dispose 打断活跃流、B22/REQ-014 复现、B23 banner 冷启动渲染、B6 alpha_ping in-session、E4 冷重启往返、E5 历史回跳、真断网/真睡眠。REQ-016 保 shipped(残余在档)。
