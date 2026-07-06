# 真机批 vNext-3 · 验证清单(攒单,待开批)

> 2026-07-06 S26 收尾时汇编(用户指令「先 REQ-045,再攒真机批一次清单」)。
> 覆盖:S22–S26 新增码面的全部真机递延 + 存量 verified 残单。开批时以本单为底抽取,逐项证据落 `docs/audits/<date>-realmachine-vnext3/verify.md`,BACKLOG 状态随证据翻 verified。

## 批前置

1. **重 ship 签名+公证 prod 包**:自 S21 包(PR #118 前)后 A 侧新码 = PR #119(REQ-044 provenance)· #120(C16 + E2/E6)· #122(REQ-046 快照+远程 agent 接线)· #123(B16 consent 门);均「需下个签名版本生效」。
2. **A 快照刷新**(随 ship runbook ①′,DISTRIBUTION.md):`sync-catalog-snapshot.mjs` 收录 catalog 2026-07-06.2(REQ-045 三条 + bundle:design 回归)。
3. **REQ-046 远程 agent 演练前置**:C catalog 当前**无** remote agent 条目(agent:code-reviewer 是 builtin)——开批前需 C 侧上架一条远程 agent(正式条目或临时测试条目,单 .md ≤256KB 约定),否则该演练无对象。
4. 迁移开门项需 `ALPHA_MIGRATE_ENABLE=1` + 重启(REQ-016 残单注)。

## M1 定制中心 / catalog(P0,联动 REQ-045/046 演练)

- [ ] **REQ-045 验收③(A 零发版链路)**:hub 远程刷新 → 「MCP 构建指南 / 视觉海报设计 / 品牌规范应用」三条目出现 → 逐条安装成功(注意 canvas-design 84 文件 5.4MB 下载时长与进度呈现)→ 账本 origin 记远程来源 → 会话内技能可用;**bundle:design 一键装**(远程成员扇出首例)+ bundle:dev 可选装 mcp-builder。
- [ ] **REQ-046**:C 上架远程 agent → hub 安装 → 会话可用(见批前置 3);快照刷新后 `alpha-catalog.test.ts` 仍绿。
- [ ] **REQ-044 真实根迁移开门**:用户自建同名技能(如手写 `mcp-builder`)在场 → 迁移条**不列它** + main.log `[req044-provenance]` 排除留痕;真 alpha 旧安装正常迁移四要件(`.alpha` 真源/receipt/旧位净除/桥)。
- [ ] **E2 钉钉**:安装(Client_ID/Secret 密文采集 {file:} 化)→ 首调用真通;供应链警示在详情页如实展示。
- [ ] **E6 DBHub**:安装(DSN 密文采集)→ SELECT 真通 + 写语句被拒(0.12.0 readonly 语义实测)。
- [ ] **REQ-016 残余四小项**:卸载 uv 像素走查 · 断网 vendored 插件安装(零网络)· git 真克隆导入 · dispose 打断活跃流。

## M2 数据 / 凭证(P1)

- [ ] **C16 清除数据两级实操**:凭证级(清密钥+登出+respawn 防复活)· 全部级(打包态:先备份提示 → 红色终确认列体积 → 停引擎 → 清 → 退出);UNINSTALL.md 菜单直达;逐项结果留痕。
- [ ] **B14**:「数据」菜单备份/导出/打开文件夹实操(原生对话框);**C17**:DB 超前阻断对话框打包态演练(三选项)。
- [ ] **B2 短 TTL**:过期→续期 / 撤销→降级 BYOK/登出不串台;**B21**:BYOK 改键 → picker 即时反映 → 新 key 出账;删键即时吊销。

## M3 云线(P1)

- [ ] **B16 同意门**:首次派发弹窗实拍 → 拒绝**不发送** → 同意后 `.alpha/prefs.json` 落 cloudConsent → 二次派发不弹;登录授权页代付告知行在场。
- [ ] **B3**:登录态 in-app dispatch 冒烟 + 回流 saveRun 落 `.alpha/runs/<runId>/`(兼 REQ-004)。
- [ ] **REQ-024 A2**:standard 可写档启用确认 → 真跑一单(edit 通过、bash 破坏类被 deny、零 ask);**REQ-025 A3**:云档保存 → B 注册 → 关 app 错过 → 开机拉回落 runs(A↔B e2e)。

## M4 稳定性 / 呈现(P2,顺带项随场跑)

- [ ] **B22**:时间线崩溃真机复现(修复前置;有降落伞,不阻断其它项)。
- [ ] **B11 失败态实拍**(banner/toast 截图归档)+ **B23 语法错支**(全局 jsonc 语法错 → warning banner)。
- [ ] **B20 + REQ-003**:弱网走查(splash 状态/超时重试/websearch 降级/SSE 断连呈现)。
- [ ] **B4 冷启动深层断言**:netlog 专项(hidden 项目零 session.list → 引擎零 Instance;watcher 数);**C3**:打包启动 opencode.log 超限轮转;(**B12** 长时内存属长周期,单列不占本批)。
- [ ] **B7 release-time 三项**(随重 ship 顺带):①版本断言 ③断网首启 smoke ⑤注入 0.0.0 验证。
- [ ] **REQ-007③**(顺带):Tier-3 回答长度校准实测(explain 类不再过短)。

## 明确不入本批

- REQ-005(前端收尾核验)= 独立方向,用户候选单单列;
- B12 长时内存/watcher = 长周期观测,与单场批节奏不合,单列;
- C15 真机 CPU 对比 = 性能专项(/loop defer 结论)。
