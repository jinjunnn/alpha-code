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


## codex 审计(1 High / 4 Medium / 2 Low)与修复(同 PR)
- **H1 IPC 信任边界未钉**(renderer 可自带 name/files 绕开 catalog 签名)→ IPC 只收 `catalogId`,name/清单/版本全部由 main 从**已验签** catalog 重新派生;renderer/被篡改缓存无法自带 URL+hash;
- **M1 缓存不重验签** → 缓存改存 body+sig 原文,**读取时重跑 ed25519**,失败丢弃并 loud(本地篡改缓存失效);
- **M2 旧签名 catalog 重放/回滚** → 版本单调守卫:远端版本低于缓存版本拒用(`ROLLBACK REJECTED` loud,数值感知段比较);
- **M3 redirect 降级** → fetch 后校验**最终** URL 仍为 https(catalog/sig/资产三入口统一);
- **M4 frontmatter name 未绑定**(装安全目录名、以另一名字暴露 shadow 技能)→ 解析 SKILL.md frontmatter,`fm.name ≠ entry.name` 拒装(spoofing guard,e2e 锁定);
- **L1 详情页持旧 entry** → H1 使 main 始终按 id 从当前已验签 catalog 派生,安装面自然新鲜;展示级旧引用接受;
- **L2 账本写失败静默 ok** → 保持 ok(技能实际可用,不谎报失败)但 `console.error` loud 记录;与既有 installer 同型系统债,随 B20 线跟踪。
- Informational(资产任意 https host):内容完整性已由签名内 sha256 钉死;host allowlist 属网络 egress 策略,留 REQ-032 phase 2。
live e2e 复跑 10/10(含 spoofing 拒装);新缓存格式 304 路径复验。
