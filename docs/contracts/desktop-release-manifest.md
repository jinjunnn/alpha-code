---
title: Desktop release manifest v1 (signed, machine-consumable)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-19
review_after: 2026-11-19
---

# Desktop release manifest v1(#175,父需求 alpha-work#11)

每个 beta/prod 桌面发布产出**唯一、签名、机器可消费**的 release manifest。它是发布事实的
单一真相:`alpha-web`(alpha-web#25)只验签并消费它,不得自行作者化版本、文件名、大小或
updater 事实。必需事实缺失或不一致时 producer **拒绝产出 manifest**(fail hard,无 warning
通道),发布即被阻断。

- 生产端逻辑:`packages/ui-mac/src/main/release-manifest.ts`(纯裁决,负向测试
  `release-manifest.test.ts`)+ `packages/ui-mac/src/main/release-sbom.ts`(SBOM)。
- CLI:`packages/ui-mac/scripts/release-manifest.ts`(keygen / produce / verify)。
- Windows CI 硬门:`.github/workflows/alpha-windows-build.yml` +
  `packages/ui-mac/scripts/verify-windows-signing.ts`。
- 发版流程接线:[../runbooks/distribution.md](../runbooks/distribution.md) §1。

## 1. 文档与产物

| 文件 | 内容 |
| --- | --- |
| `alpha-release-manifest.json` | manifest 本体(schema `alpha.release.manifest.v1`),随 GitHub Release 上传 |
| `alpha-release-manifest.json.sig` | 对 manifest **精确字节**的 ed25519 签名,base64 |
| `alpha-code-<version>-sbom.cdx.json` | CycloneDX 1.6 SBOM,从**打包产物的 app.asar** 枚举 |
| `desktop-release-manifest.trust.json`(本目录) | 信任根:签名公钥集 + 已撤销 manifest 列表,消费方 vendor 它 |

## 2. 签名模型(与 catalog-channels 合同 §2 同形)

- ed25519 over manifest 的**精确字节**(`JSON.stringify(manifest, null, 2) + "\n"`,无
  canonical-JSON 变换);`.sig` 为 base64,允许尾随空白。
- `keyId` = 公钥 SPKI DER 字节的 sha256 hex,写在 manifest 内(签名覆盖它)。
- 私钥不入库:`~/.alpha-code-signing/release-manifest-ed25519.pem`(0600),由
  `release-manifest.ts keygen` 生成。

## 3. 信任与轮换(AC6)

`desktop-release-manifest.trust.json`(schema `alpha.release-manifest.trust.v1`):

- `keys[]`:`{keyId, publicKey, status: active|retiring|revoked, notBefore, notAfter?}`。
  轮换 = 新钥 `active` + 旧钥 `retiring`(带 `notAfter` 窗口)同存;窗口过后旧钥置
  `revoked`。`keyId` 必须等于 `publicKey` 的指纹(schema 校验强制)。
- `revokedManifests[]`:按 manifest 字节 sha256 撤销**已发布的坏版本**(召回位)。
- 消费方 fail closed:未知 `schema` 字符串、未知 `keyId`、`revoked` 钥、窗口外、
  撤销列表命中 —— 一律拒,无占位/unsigned 回退。

## 4. manifest 形状(v1)

顶层:`schema, channel(dev|beta|prod), version, releaseTag, repo, publishedAt, keyId,
artifacts[], updater.feeds[], sbom`。

`artifacts[]` 每项:`filename, platform(darwin|win32), arch(arm64|x64),
kind(installer|updater-archive|blockmap), size, sha512(base64,electron-updater 口径),
sha256(hex), signing`。`signing` 按平台:

- darwin:`{type:"apple", signed, identity, teamId, notarized, stapled}` ——
  从 dist 里同轮打包的 `.app` 执行 `codesign -dvv` / `spctl -a -t install` /
  `stapler validate` 得出。
- win32:`{type:"authenticode", signed, status, publisher, thumbprint}` ——
  来自 Windows runner 采集的 facts(§6)。

`updater.feeds[]`:electron-builder feed 文件(`latest-mac.yml`/`latest.yml`,beta 渠道为
`beta-mac.yml`/`beta.yml`)的 `{filename, size, sha256, version}`。
`sbom`:`{filename, size, sha256, format: "CycloneDX-1.6", componentCount}`。

## 5. fail-hard 规则(全部在负向测试里逐条钉死)

| 规则 | 内容 |
| --- | --- |
| R1 | channel/repo/tag 合法;version 为 semver 且**非** `0.0.0`(含 `0.0.0-*` 前缀)/`local`;`releaseTag = v<version>` |
| R2 | artifacts 非空、filename 唯一、size/sha512/sha256 形状合法、至少一个 installer |
| R3 | blockmap 的宿主必须在 inventory 里 |
| R4 | 每个出现的平台必须有对应 feed;feed 覆盖该平台全部非 blockmap artifact;feed 条目的 filename/sha512/size 与**最终字节**逐字相等;feed.version = manifest.version;条目必须是裸文件名;无平台对应的多余 feed 拒 |
| R5 | SBOM 必须在场且 `componentCount >= 1` |
| R6 | darwin 产物必须带 mac 签名事实;beta/prod 上必须 signed + teamId=`RQX6X6A635` + notarized + stapled |
| R7 | win32 产物必须逐文件有 facts,且 facts 的 sha256 与最终字节相等(旧 facts 配新包必炸) |
| W1–W5 | facts 的 channel 必须与门的 channel 一致;beta/prod 上必须 signed 且 status=Valid(W2)、publisher 在场(W3)、publisher 白名单已注册且命中(W4/W5)。**白名单今天为空 = 任何 signer 都拒**(Authenticode 证书采购归 REQ-076 T3;落地时同一 PR 更新白名单、本契约与负向测试) |

dev 渠道:签名不强制,但事实必须**完整如实记录**(dev 包不发布;发布链只认 beta/prod)。

## 6. Windows signing facts(`alpha.release.windows-signing-facts.v1`)

`alpha-windows-build.yml` 打包后由 pwsh 从最终 `.exe` 采集
(`Get-AuthenticodeSignature` + `Get-FileHash`),写
`windows-signing-facts.json`:`{schema, channel, collectedAt, artifacts[{filename, sha256,
status, signed, publisher, thumbprint}]}`。同 workflow 内
`verify-windows-signing.ts` 立即按 W1–W5 裁决(beta/prod 未签名 ⇒ job 红,artifact 不出),
facts 随 `*-release-facts` artifact 上传,供发版机 producer 消费。

## 7. SBOM 来源

从**打包器输出的 app.asar**(mac:`dist/mac-<arch>/*.app/Contents/Resources/app.asar`;
win:`dist/win-unpacked/resources/app.asar`)枚举 `node_modules/**/package.json`
(asar header 直接解析,含 `.unpacked` 条目)。lockfile 说「装了什么」,asar 说「**发出去**
了什么」——SBOM 取后者。零条目 = 硬失败。

## 8. 显式不做(hard cutover)

无旧 feed、旧 manifest schema、placeholder version/filename、unsigned Windows 兼容路径;
当前无用户,未知/不合规输入一律 fail closed。web 消费半场归 alpha-web#25;seed 完整性归
alpha-work#5;runtime/public reachability 证据归共享 RC verification issue。
