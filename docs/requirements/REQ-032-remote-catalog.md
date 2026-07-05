---
id: REQ-032
title: 定制中心 catalog 远程分发(收编 E10):C 端点 + 签名验签 + A 运行时拉取/缓存/回退 + skill/agent 远程资产通道
type: feature
priority: P1
status: registered
repo: X
created: 2026-07-05
---

## 背景(为什么)

2026-07-05 现状核查(alpha-code `packages/ui-mac/src/renderer/extensions/`):

1. **catalog 完全静态**:`alpha-catalog.json`(version `2026-07-03.1`,24 条:MCP×8 / skill×6 / agent×1 / plugin×1 / bundle×5 / cloud×3)编译期 `import` 进 renderer bundle(`use-extensions.ts:21`、`extension-hub.tsx:33`),**零远程刷新**;`remoteIndexUrl` / `downloadUrl` 仅为占位类型、全仓零消费(`catalog-types.ts:44,59-60`)。
2. **更新机制封闭**:「可更新」角标 = receipts 快照版本 vs 打进包的 `CATALOG.version`(`extension-hub.tsx:365-367`)——**只能随 app 发版翻新**。
3. **上架成本 = 发版**:新增一条 skill 到市场,今天必须:放资产进 `resources/skills/` → 加 catalog 条目 → bump version → **重新构建 + 签名 + 公证 + 分发安装包**。没有任何远程下发通道。
4. **方向已有拍板**:ADR-014 O4 = 远程 catalog 依赖 alpha-web(C),「C 端点未建前离线优先内置」;E10 已登记(BACKLOG,X,阻塞于 C 端点未建);v3 设计已规划条目级 ed25519/minisign 离线验签(designs/2026-07-04-extension-hub-v3-universal.md:238)。本档把 E10 从一行 roadmap 升级为全流程需求,**E10 → dup 并入本档**。
5. **关键约束(勘探结论)**:清单远端化 ≠ 资产远端化——skill/agent/vendored-plugin 资产在 `resources/`(extraResources),远端 catalog 新增条目若无资产会命中既有「未随此版本打包」诚实失败(`ext-fs-installer.ts:229`)。要真正解耦发版,必须同时建资产下载通道。

用户诉求(2026-07-05):官方/社区的连接器、技能、agent、插件、套件、云能力清单不应在 alpha-code 侧逐条维护——每加一条 skill 就要发新包;应在上游(alpha-web / alpha-platform)维护,alpha-code 经接口查询,更新只动上游。

## 落点拍板(用户 2026-07-05 确认:alpha-web C,非 B)

维持 ADR-014 O4:catalog 是公共、无鉴权、可 CDN 缓存的分发内容,与 C 的角色(官网/下载/自动更新 feed)同构;走 `alphacodeone.com` 域(境内可达已验证),不依赖 GitHub/raw CDN。**alpha-platform(B)不合适**:B 是鉴权控制面,catalog 放 B 会让浏览市场都要登录,且把公共静态内容拖进计费/配额信任域。云能力条目本就是 catalog 数据(`byType("cloud")`),照常随远端 catalog 下发;其登录门控(`cloudReady()`)留 A 侧现状不动。

## 目标(做什么)

1. **C / catalog 端点**:静态 JSON 端点(如 `alphacodeone.com/catalog/v1/catalog.json`)+ 资产对象存储(skill/agent 文本资产包);发布流程 = git 审核 → 部署(catalog 内容仓内版本化);catalog 整体签名(ed25519/minisign,私钥离线持有,公钥内置 app)。
2. **A / 运行时拉取**:启动或进 hub 时拉取(ETag/If-None-Match 缓存)→ 验签 → 落 userData 缓存;回退链 = 远端 → last-known 缓存 → **内置 catalog(打包 fallback,永不空白,B20 纪律)**;`CATALOG.version` 改用生效 catalog 的 version → 「可更新」角标脱离 app 发版。
3. **A / 远程资产通道(phase 1 仅 skill/agent)**:文本类低危资产走 `downloadUrl` + catalog 内 **sha256 钉死**,下载校验通过后接入既有安装管线(复制 → 账本 → dispose 免重启);校验不过拒装(loud)。**plugin(可执行 JS)不进 phase 1**——仍走 vendored/npm 双通道,远程分发列 phase 2(需逐条目签名 + 风险确认 UI)。
4. **MCP 现状不变**:MCP 本就运行时 uvx/npx 现拉(带国内镜像兜底),远端 catalog 只更新其条目元数据。
5. **更新机制(2026-07-05 用户追问,补入范围)**:
   - **A / 检查节奏**:启动时 + 进 hub 时拉远端 catalog(ETag,304 零成本);可选每日一次后台静默检查(app 存活时,与 ADR-022「不装后台常驻」同一诚实边界)。角标改按**生效 catalog**(远端/缓存/内置)计算。
   - **A / 版本粒度修正**:更新判定从「receipts 快照 vs **全局** `CATALOG.version`」(现状,粗——catalog 任何变动会给全部已装项打可更新角标)改为「receipts 记条目版本 vs **条目级** `entry.version`」;`version?` 字段已在 schema(`catalog-types.ts:53`),远端 catalog 中对可安装条目转为必填。
   - **A / 逐类型更新流(复用 REQ-019 既有,不新建)**:skill/agent = 下载新资产校验后 fs 覆盖重装;plugin = 换钉版本;MCP = 确认框重装(防丢 `{file:}` 密钥引用,`use-extensions.ts:99` 既有纪律);bundle = 逐子项按各自类型走。
   - **C / 更新包机制**:资产按版本**不可变存储**(`/catalog/assets/<id>/<version>/…`,已发布版本永不覆盖 → sha256 恒定、CDN 友好);catalog.json 每条目携 `version + sha256 + downloadUrl` 指向当前版;**回滚 = catalog 指回旧版本路径**(资产还在);发布流程 = 内容仓 PR → CI 校验 schema/算 sha256/签名 → 部署。

## 验收标准(可验证,逐条)

1. C 端点上架一条新 skill(条目 + 资产)→ A **不发版**,hub 刷新即可见、可安装、装后引擎生效(dispose 链路),真机核验([[visual-verify-required]]);
2. 篡改 catalog(签名不符)→ 拒用 + 回退内置/缓存,loud 提示(不静默降级);
3. 资产 sha256 不匹配 → 拒装,错误可见;
4. 断网 → 内置 catalog 照常浏览与安装 builtin 资产(现状零回归);
5. 远端 bump **某一条目**的 version → 仅该已装条目出角标(条目级粒度,无关条目不误报),无需新 app 包;逐类型更新流实测(skill 覆盖重装 / MCP 确认框重装后 `{file:}` 引用不丢);
6. 境内网络实测端点可达(alphacodeone.com 域);
7. C 侧回滚演练:catalog 指回旧版本 → 客户端可装到旧版资产,sha256 仍匹配。

## 非目标

- 不做 plugin 远程分发(phase 2,前置 = 逐条目签名方案);
- 不自建 npm/PyPI 镜像(MCP 运行时拉取现状不变);
- 不做服务端个性化目录(登录门控/edition 显隐留 A 侧;catalog 对所有人同一份);
- 不做社区自助提交/审核后台(上架 = 仓内 PR 审核,人肉即可,量大再议);
- 不做 catalog 增量 diff 协议(整份 JSON ~23KB + ETag 足够)。

## 方案 / 关联

- **E10 → dup 并入本档**(原一行 roadmap:「catalog 远程增量同步(alpha-web C)/ HTTP fetch / C 仓 catalog 端点未建」);
- ADR-014(O4 拍板、v3 修订)、REQ-023(供给链:vendoredAssetKey/downloadUrl 字段已备)、REQ-019(更新通道 UI 已建,本档让其脱离发版)、REQ-020(cloud 条目随 catalog 动态化);
- 供应链安全:远端化引入篡改面,签名 + 验签 + 回退是硬门(对齐 designs/2026-07-04-extension-hub-v3-universal.md:238);
- C 侧交付物按 ADR-018 §8 登记(`仓=X`,C 内部实现细节留 alpha-web 仓)。
