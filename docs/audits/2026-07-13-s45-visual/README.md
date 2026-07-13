# S45 视觉验收(2026-07-13)—— REQ-099 / REQ-100 / REQ-105-A

真机取证:dev 模式(CDP 9222,裸 WebSocket `Page.captureScreenshot` + `Runtime.evaluate` DOM 探针),
PRO 登录态。预置手段:`~/.alpha/installs.json` 临时注入 `mcp:word` / `mcp:powerpoint` 两条 catalog
receipts(取证后已还原备份,零残留)。

## REQ-105-A(#197)UI 实证

| 截图 | 场景 | DOM 探针 |
|---|---|---|
| `10-connectors-browse.png` | 连接器分区(remote catalog 仍含 Word/PPT,web#21 前的 stale 场景) | `archivedChips: 2`,chip 文案「已归档」;Word/PPT/Excel 卡片可见(legacy optional 语义,卡片带警示) |
| `20-installed-advisory.png` | 已安装分区,预置已装 Word/PPT | `role="alert"` 警示条 ×1(列出两连接器名 + 2026-03-03 归档日期 + 禁用/卸载/替代指引,日期取自 advisory 记录);archived 徽标 ×2;行内停用开关 + 卸载按钮同框(不静默删除,可审计处置) |
| `30-word-detail-advisory.png` | Word 连接器详情页 | heading「Word 文档读写(office-word-mcp)」;archived chip ×1;红色 advisory note(归档缘由 + 处置 + markitdown/python-docx 替代) |
| `40-bundles-office.png` | 套件分区 office 套件 | 成员探针:无 PowerPoint;「Word」文案命中均为良性(markitdown 的"转 Markdown 读取"描述 + **remote 套件描述遗留「Excel/Word/PPT 写作三连」——文案源自 remote catalog,已记入 alpha-web#21 处置**) |

离线 seed 面(AC1)由自动化守卫证明:`alpha-catalog.test.ts`(id/包名逐字扫描 + bundle 成员 +
mcp:excel 准入闸)+ `scripts/assert-seed-assets.sh`(catalog + 出厂技能双面,含「未来快照」
钉版/漂移 fixture 验证)。`EXCEL_MCP_PIN` 的 sdist/wheel sha256 已与 pypi 实测复核一致
(excel-mcp-server 0.1.8)。

## REQ-099(#191)/ REQ-100(#192)

本期无新 renderer UI 面(preload 未暴露新通道,Hub 接线属后续 slice,ADR-028 residual 在案)。
实证 = 测试矩阵 + 权威门:

- REQ-099:78 测(manifest-v2 20 / receipt-v2 24 / planner 34)—— 伪造 renderer 输入拒绝、
  非法 manifest 写盘前拒绝(installer 零调用断言)、scope 独立 fail-closed(rename/symlink/
  Unicode 路径)。
- REQ-100:90 测(4 文件,441 expect)—— 14 崩溃点故障注入矩阵(旧/新完整态、恢复收敛、
  幂等重试)、权限 diff 重确认(扩张无确认拒绝、授权账 fail-closed)、Bundle 锁并发串行化。
- 集成接线:main 启动期 `recoverExtensionTransactions`(ext-ipc 注册时启动,install/uninstall
  通道 await 恢复先行;无 probe/receipt 注入 → 引擎 fail-closed 全回滚,账本零漂移)。
- 权威门 `scripts/alpha-check.sh`:北极星守卫 + typecheck + **1207 pass / 0 fail**(3360 expect)。

## 残留(如实)

- planner→事务引擎全量改线 + 前滚 hooks 注入 + legacy 通道下线:随 renderer 切换到
  `ext-install-catalog` 的后续 slice 收口(ADR-028 residual)。
- 权限扩张确认对话 UI:REQ-100 已在 authorize 失败结果携带逐 item `CapabilityDiff`,UI 面
  随 Hub 接线 slice 落地。
- remote 套件描述「写作三连」文案 → alpha-web#21。
