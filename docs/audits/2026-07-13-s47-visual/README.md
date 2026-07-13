# S47 视觉验收(2026-07-13)—— REQ-105 快照收口 / REQ-101-A / REQ-088 前置 C1

真机取证:dev 模式(CDP 9222,裸 WebSocket 截屏 + DOM 探针),PRO 登录态。
权威门:`scripts/alpha-check.sh` 全绿(**1248 pass / 0 fail**,todo 清零);冻结集双门
`packages/app` typecheck + test:unit(407 pass)绿。

| 截图 | 场景 | 探针 |
|---|---|---|
| `10-home-freeze-sanity.png` | Home 渲染 sanity(ADR-020 §5 ④,freeze-base-3 轮转后) | sidebar 在场、正文非空 |
| `20-connectors-new-snapshot.png` | Hub 连接器(快照 v2026-07-13.1) | dingtalk/feishu/yuque/word/ppt 全 false;excel true(卡片文案含「仅 local stdio 运行」) |
| `30-bundles-office-with-excel.png` | Hub 套件 | china-office 绝迹;office 套件在场含 excel;「写作三连」文案已消失(web#21 部署后经 channel/v1 同源) |

## REQ-105 快照收口(alpha-work#7 证据)

- 快照经 `sync-catalog-snapshot.mjs` 从生产端点验签刷新:v2026-07-06.4(28 条)→
  **v2026-07-13.1(25 条)**;-dingtalk/feishu/yuque/china-office(REQ-081 落地),
  +mcp:excel(钉版 0.1.8,`_provenance` 与 EXCEL_MCP_PIN 逐字一致);零手编(sha256 守卫)。
- REQ-105 守卫在新快照全绿:word/ppt 包名 0 命中、Excel 钉版唯一、bundle 零归档成员;
  dingtalk 系新增绝迹断言 = conscious-restock 闸。

## REQ-101-A(#193)运行时实证

- dev app userData 已落 `catalog-channel-state.json`(trust + trustAnchor + stable 缓存)
  ——channel-first 路径真实执行;#193 线上三通道实测 `via=channel-stable,
  version=2026-07-13.1`;缓存篡改一字节重验即弃(测试)。
- R1–R11 拒绝矩阵 38 测全绿;B 侧 testvectors 已入仓(SOURCE.md 记 alpha-web@9cb6057)。

## REQ-088 前置(#181,不关 issue)

- C1:`./surface/session` 窄导出(冻结集 delta 恰 1 行)三层守卫就绪;ADR-027/020 已修订;
  `verify-freeze-restore.sh` 对 base-2 受控红(轮转必要性证据),铸 tag 后须复跑全绿。
- C2:六项真引擎 characterization 两连跑 6/6(真 serve 引擎 + 冻结 renderer + 真 Chromium;
  `test-live/req087/`,不进权威门,锚点测试防蚀);legacy 基线落盘 `baselines/legacy-baseline.json`。
- Legacy 怪癖实锤:首次切走 session 时活动终端 recoverTerminal clone 产生恒 1 个孤儿 PTY
  (不线性累积)——REQ-088 parity/rollback 对照上界。
- 余项:C4 探针矩阵(Electron 真机 `__req087Spike.summary()`)→ REQ-088 主实现启动条件。
