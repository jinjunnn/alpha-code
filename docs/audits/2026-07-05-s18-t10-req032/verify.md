# REQ-032 验收记录 —— catalog 远程分发(S18 T10;C 侧 alpha-web PR #5,A 侧本 PR)

> 2026-07-05。验证:**prod 真端点联测**(alphacodeone.com,境内直连)+ 隔离目录 e2e(bun test +
> electron mock)+ 全量单测门。

## 逐条结果

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | C 上架新 skill → A 不发版可见可装、引擎生效 | ✅ 机制 PASS(hub 像素→真机批) | C 侧发布 **远程-only** 条目 `skill:conventional-commits`(v1.0.0,资产只在 C,不在 app 包);A 侧 live e2e:生效 catalog 25 条含该条目 → `downloadRemoteAsset`(sha256 校验)→ `installRemoteSkill`(~/.alpha/skills + `skills` 整目录桥 + 账本 version 1.0.0)全通;引擎发现 = 既有桥机制(REQ-036 已裸引擎实证同通道);hub 内可见/安装按钮走 `installSpec.source:"remote"` 分支 |
| 2 | 篡改 catalog → 拒用 + 回退,loud | ✅ PASS | 真 body 翻 1 字节 → `verifySignature` false(live 实测);拒用路径回退 缓存→内置,error 字符串 loud(「SIGNATURE INVALID — possible tampering」) |
| 3 | 资产 sha256 不匹配 → 拒装 | ✅ PASS | live e2e:sha 改错 → `sha256 MISMATCH … refusing to install`,全单拒绝不落半成品 |
| 4 | 断网 → 内置 catalog 照常 | ✅ PASS(机制) | 回退链:fetch 失败 → 缓存 → `source:"none"` → renderer 保持 bundled(B20 永不空白);renderer IPC 失败同兜底 |
| 5 | 条目级 version 角标(无关条目不误报)+ 逐类型更新流 | ✅ 代码级 PASS | updatable 判定改「receipt.version vs `entryVersion(entry)`」且 **origin imported/created 不参与**(X7);metaFor 记条目级 version;逐类型更新流复用 REQ-019 既有(fs 覆盖重装/plugin 钉版/MCP 确认框) |
| 6 | 境内端点可达 | ✅ PASS | `alphacodeone.com/catalog/v1/catalog.json` 200 + ETag;**304 路径 live 实测**(第二次拉取);阿里云 A 记录直连(非 GitHub/raw CDN) |
| 7 | C 侧回滚 = 指回旧版本路径 | ✅ 机制 PASS | 资产**不可变**布局(`assets/<id>/<version>/`);build 脚本对已发布版本内容改动直接拒绝(IMMUTABILITY VIOLATION);回滚演练随下次真实版本迭代做 |

## 实现落点
- **C(alpha-web #5,已部署 prod)**:`public/catalog/v1/`(catalog.json+.sig)+ `public/catalog/assets/`(不可变)+ `scripts/build-catalog.mjs`(sha256 注入/签名/不可变检查)+ `docs/catalog-publish.md`;私钥 gitignored 本机持有(备份指引在 runbook)
- **A main**:`remote-catalog.ts`(ETag 条件请求/ed25519 验签(公钥内置)/2MB·5MB 体积帽/8s 超时/缓存;`downloadRemoteAsset` 逐文件 https+路径安全+sha256);`ext-fs-installer.installRemoteSkill`(builtin 同管线:桥+账本);IPC `ext-remote-catalog`/`ext-install-remote-skill`;启动预热
- **A renderer**:`catalog-source.ts`(生效 catalog signal:remote→cache→builtin)+ hub 全量切 reactive catalog + 进 hub 时刷新 + 条目级 updatable(X7 origin 过滤)

## 残单(→ 真机批 / 运营)
- hub 内远程条目安装的像素级走查([[visual-verify-required]];dev 环境事故同 REQ-036 记录)
- C 侧回滚演练(随首次真实版本迭代)
- 每日后台静默检查(REQ 可选项)未实现 —— 启动+进 hub 两触点已覆盖主路径,留增强
