# S12 定制中心 v3-M1 验证记录(REQ-018 T8)

> 2026-07-04 · sprint [2026-07-04-s12-ext-hub-m1](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/sprints/2026-07-04-s12-ext-hub-m1/sprint.md) 收口证据。
> 结论:M1 六任务(T1–T7)全部 shipped(PR #66–#71,合入 alpha)。核心「装→亮→用→卸」四步的
> **引擎级**闭环已端到端实测通过;**in-app 真机四步(带 live agent 工具调用)+ A6 env dump 解 R3 +
> 迁移开门演练**需登录/模型/打包签名 app,归**真机批**(见 §4,与 REQ-016 同场),状态维持 shipped、
> 未擅自翻 verified(ADR-018 shipped≠verified 纪律)。

## 1. 引擎级端到端(装→亮→卸)—— 实测 PASS

隔离真 opencode server(`bun packages/opencode/src/index.ts serve`,独立 XDG + `:memory:` DB),
按 T2 安装产物形态(`.alpha` 真源 + `.opencode` symlink 桥,单元测试已证 installer 产出此形态)
驱动,证据:

| 步骤 | 操作 | 观测(`GET /skill`、`GET /agent`) | 判定 |
|---|---|---|---|
| **装** | 写 `.alpha/skills|agents/*` + `.opencode` 桥 | skill/agent 文件经桥可达 | ✅ |
| **装完未重载** | 立即查询(实例缓存态) | skill=[] agent=[] **不可见** | ✅ **证 placebo 根因真实**(P0-1:写盘 ≠ 生效) |
| **亮** | `POST /global/dispose` → 下次请求惰性重建重扫 | skill=["verify-skill"] agent=["verify-agent"] **可见** | ✅ **免重启生效**(T4) |
| **卸** | 拆桥 + 删真源 → `POST /global/dispose` | skill=[] agent=[] **净除** | ✅ 卸载干净(T6) |

补充 dispose 性能实测(前序 spike,同 server):`POST /instance/dispose` 返回 **8ms**;下一请求
惰性重建 **~101ms**(`/global/dispose` ~310ms)→ 用户感知≈即时。多跳 symlink 链、整目录桥均被
引擎 glob(`follow:true`)发现(REQ-004 spike 6/6,本批复用)。

**覆盖的 P0**:P0-1(装完不生效 placebo)根因被实测确认并由 dispose 消除;P0-3(装完失管)
的卸载净除半边由「卸」步证实;P0-4(写盘根跑偏)由 `.alpha` 落点 + 桥形态证实。

## 2. 单元测试(main 侧,全绿)

`bun test src` 全量 **266 pass**(S12 新增 ~59):
- `alpha-installs.test.ts`(11):receipts 读写/upsert/损坏隔离自愈/校验。
- `alpha-bridge.test.ts`(10):dir-link/item-link 退化/拆链/防误删/防逃逸。
- `ext-fs-installer.test.ts`(22):`.alpha` 落盘 + 桥 + receipt + 项目 scope + legacy 逃生 + `removeFsInstall`。
- `alpha-mcp-secrets.test.ts`(9):0600 密钥 file 化、序列化 config 断言**零明文**、吊销。
- `ext-config.test.ts`(+receipts/removePlugin):MCP/plugin 记账 + 卸载。
- `alpha-migrate.test.ts`(8):scanLegacy/removeLegacy/门控。

## 3. UI 渲染(CDP)

`hub-featured.png`(2560×1600,`ALPHA_SHOT` 隔离 test profile):侧栏「定制中心」入口在位、
alpha-ui 换肤常态。**注**:fresh test profile 强制 onboarding 覆盖层 + 无登录/模型 → hub 内页
(Agent tab / 已安装全类型 / 密钥采集弹窗 / 迁移条)的populated 截图需真机(登录后)补,归 §4。

## 4. 真机批(pending,需用户机器:登录 + 模型 + 打包签名 app)

以下需 live 环境,状态维持 shipped、真机验证后翻 verified(与 REQ-016 同场):
1. **in-app 四步 ×4 类**:装 markitdown(免密钥)/ github(填 PAT→jsonc 见 `{file:}` 非明文)/ 自建 skill / 自建 agent → **当前会话下一条消息** agent 实调该能力成功 → 卸载四处一致。
2. **A6 MCP 子进程 env dump**:验证第三方 MCP 子进程 env 不含平台 JWT/BYOK/EXA key → **解 R3 门控**(A2b/E2/E6)。
3. **迁移开门演练**:`ALPHA_MIGRATE_ENABLE=1` → 旧 XDG 安装迁到 `.alpha`、旧位净除、receipts 一致(用户自建内容不动)。
4. **REQ-006 四用例** + Agent tab / 密钥弹窗 / 已安装全类型 / 迁移条 的 populated 截图。

## 5. 已知残留 / 诚实失败(非缺陷)

- 官方 skill:仅 `skill-creator`(Apache-2.0,真内容+LICENSE)已打包;`mcp-builder`/`canvas-design`/
  `brand-guidelines` 本机无可信来源 → **拒绝伪造**、保持诚实失败(catalog `_disclaimers` 记账)。
  **安全后随修(PR #73)**:自动安全审查发现 vendored `skill-creator/eval-viewer/generate_review.py`
  的 `</script>` 突破 XSS(eval 数据含半可信模型输出插进 `<script>`)→ 已转义 `</`+U+2028/9 加固;
  标注 alpha 安全补丁,re-vendor 须重应用。
- 项目 scope 卸载 IPC 目前按 global 解析(`ext-uninstall` 的 project fs 卸载走 projectDir 传参待 REQ-019 细化);M1 已安装列表 = global,不受影响。
- 远程 catalog、详情页、更新通道、导入 = REQ-019/020;不在 M1。
