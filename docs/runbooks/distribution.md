---
title: Mac release runbook (signing, notarization, auto-update)
kind: runbook
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-16
review_after: 2026-10-14
---

# 发版 runbook — alpha-code Mac(签名 · 公证 · 自动更新)

> 权威发版文档。把 alpha(opencode 引擎 + 自有前端/后端)打成**你自己**的、签名+公证、可分发给任意 Mac 的 app,并经 GitHub Release 走自动更新。
> 首个签名+公证发布:**v0.1.0**(2026-07-03,`jinjunnn/alpha-code`),下述流程即由它验证。
> 卸载与数据残留:见 [uninstall.md](uninstall.md)(C16;app 内入口 = 数据 ▸ 清除数据…)。

## 0. 前置(已就绪,一次性)

**签名/公证凭证**(**不在仓库**,`~/.alpha-code-signing/` 0600 —— 见该目录 README):
- `Developer ID Application` 证书(team **RQX6X6A635** = Beijing yuanyuji,与 tideapp 同 team),已装登录钥匙串,`codesign` 已授「始终允许」→ 打包不再弹钥匙串框。全链 verify 通过。备份 `devid-backup.p12`(口令见 README)+ **已另存 iCloud**。
- `AuthKey_Y69LXQA5B4.p8`(App Store Connect API key,`开发者` 角色,公证用,**只能下一次**)。
- `signing.env` 导出 `ALPHA_SIGN=1` + `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` + `APPLE_TEAM_ID`。

**打包配置**(`packages/ui-mac/electron-builder.config.ts` + `scripts/*`,零改上游):
- prod/beta productName `alpha-code`、appId `com.tide.alphacode`(dev/beta 加后缀)、URL scheme `alpha-code`、artifact `alpha-code-*`。
- 更新源 = 自有 public repo `jinjunnn/alpha-code`(prod=`latest` 渠道,beta=`beta`),**不是** `anomalyco/opencode`。
- `ALPHA_SIGN=1` → Developer ID 签名 + 公证;否则 ad-hoc(仅本机双击)。
- `notarize` 是 boolean(electron-builder 26.x);team/凭证走 env。
- prebuild 会 `patch-server-version.ts` 把内嵌 server 的 `InstallationVersion` 从 `local` 改成真实版本(A4:否则 `@opencode-ai/plugin@local` 装不上,带 `.opencode` 插件的项目首个请求卡住)。

## 1. 发一个版本(权威步骤)

```bash
# ⓪ 前端合并复验(REQ-012,546-sync 静默回归教训——v0.1.0 就是跳过这步翻的车):
#    a. cd packages/ui-mac && bun test src/renderer/alpha-ui/upstream-anchors.test.ts   # 锚点契约必须绿
#    b. CDP 截图关键屏(首页/会话/模型卡/composer/时间线)对上一版基线肉眼比对(visual-verify-required)
#    上游 sync 后未做过 a+b 的树,禁止打 tag。

# ①′ 刷新内置 catalog 快照(REQ-046):cd packages/ui-mac && node scripts/sync-catalog-snapshot.mjs
#    (拉已发布 catalog + 验签 + 字节快照;alpha-catalog.json 禁手编 —— 单测守卫,手编即红。
#     上架/撤架条目一律在 alpha-web catalog-src 操作,联网用户即时生效,发版只是刷新离线底座。)
# ① 版本号:改 packages/ui-mac/package.json 的 "version"(唯一真源;About/崩溃屏/updater 都读它)
#    例:0.1.0 → 0.1.1。用真实 semver,别回 0.0.0。

# ② 打签名+公证包(package:mac,不装机)
source ~/.alpha-code-signing/signing.env               # ALPHA_SIGN=1 + Apple 凭证
cd packages/ui-mac
OPENCODE_CHANNEL=prod bun run build                     # prebuild(含 A4 patch)+ 渲染/主进程
OPENCODE_CHANNEL=prod bun run package:mac               # 签名 → 上传 Apple 公证(在线,几分钟)→ dmg/zip

# ③ 验证产物真的签名+公证了(必须都过)
xcrun stapler validate dist/mac-arm64/alpha-code.app    # 期望 "The validate action worked!"
spctl -a -vvv -t install dist/mac-arm64/alpha-code.app  # 期望 "accepted / source=Notarized Developer ID"
ls dist/alpha-code-mac-arm64.dmg dist/alpha-code-mac-arm64.zip dist/latest-mac.yml   # 三件齐

# ④ 发 GitHub Release(dmg + zip + 两个 .blockmap + latest-mac.yml 一起传,tag = v<版本>)
cd dist
gh release create v0.1.1 \
  alpha-code-mac-arm64.dmg alpha-code-mac-arm64.zip \
  alpha-code-mac-arm64.dmg.blockmap alpha-code-mac-arm64.zip.blockmap \
  latest-mac.yml \
  --repo jinjunnn/alpha-code --target alpha \
  --title "alpha-code 0.1.1" --notes "……"

# ⑤ 确认自动更新 feed 通(electron-updater 就读这个 URL)
curl -sL -o /dev/null -w "%{http_code}\n" \
  https://github.com/jinjunnn/alpha-code/releases/latest/download/latest-mac.yml   # 期望 200
```

**要点**
- `latest-mac.yml` 里的文件名必须与上传的 asset 名**逐字一致**(electron-builder 自动生成,勿改名)。
- Release **不能是 draft/prerelease**(否则 `latest` 渠道拉不到)。tag 用 `v<version>`。
- `--target alpha`:tag 打在自有代码所在分支。
- 只想本机自己用、不分发 → 用 `bun run ship:mac`(= build + package + 装到 `/Applications`);发布用 `package:mac`(只出产物,不动你在用的 app)。

## 2. 只 Apple Silicon(arm64)
当前只出 `mac-arm64`。要 Intel(x64)/universal:electron-builder 加 `--x64`/`--universal`(未验证,首个 Intel 包需实测)。

## 3. 排障 / 已知项
- **打包时弹「codesign 想访问密钥」**:点「**始终允许**」+ 输 Mac 登录密码(不是「允许」——那样每个文件都弹)。授权后长期免弹。若换机后又弹:`security import ~/.alpha-code-signing/devid-backup.p12`(口令 README)。
- **公证失败**:多为凭证/网络。`signing.env` 的 `APPLE_API_*` 是否正确;`.p8` 文件在否;换机后重新 source。API key 是 `开发者` 角色即够公证。
- **A4 已修**:`patch-server-version.ts` 已把 InstallationVersion 从 `local` 改真实版本(v0.1.0 打包实测生效)。若 prebuild 日志出现 `[alpha:patch-server-version] … not found`,说明上游改了那行表达式 → 去更新该脚本(否则 A4 复发)。
- **首个 Release 前**已装 app 检查更新会「无更新」= 正常。
- **appId 变更**(如从旧 `ai.opencode.desktop.*` 迁到 `com.tide.alphacode.*`)= app 存储一次性重置(会话/最近项目/登录),**磁盘项目文件不受影响**,重开即可。

## 4. 下一个真实版本怎么发(TL;DR)
改 `package.json` 版本 → `source signing.env && OPENCODE_CHANNEL=prod bun run build && bun run package:mac` → stapler/spctl 验证 → `gh release create v<ver> …` → curl feed 得 200。整条链(签名→公证→feed)v0.1.0 已端到端验证。

## 5. 硬化面(C27/C24,2026-07-04,S11 T6/T7)
- **Electron fuses**(`electron-builder.config.ts` electronFuses):`RunAsNode` / `NODE_OPTIONS` / node-inspect 三注入原语关闭;`EmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` + `CookieEncryption` 开启。sidecar 走 utilityProcess 不受影响;全仓无 `ELECTRON_RUN_AS_NODE` 用法。
- **entitlements 收紧**(`resources/entitlements.plist`):移除 `disable-executable-page-protection`、`allow-dyld-environment-variables`、`disable-library-validation`(dylib 注入组合);保留 `allow-jit`/`allow-unsigned-executable-memory`(V8)+ `audio-input`。**若签名包 native 模块(node-pty/ghostty)加载失败 → 仅回补 `disable-library-validation` 一项并在此记账。**
- **打包态 CSP + 回环-only CORS**(C24,`renderer-security.ts`):排障逃生 `ALPHA_CSP_DISABLE=1`。
- 验证清单(每次签名发版):stapler validate + spctl ✓ → 启动 → 终端(WASM+PTY)→ diff → 流式会话 → 定制中心 → 登录/账户 → 更新器检查。
- **CAS GC worker(REQ-102 #367,L3 项;裁决 Q6 —— bench 总耗时不能证明 main 占用,须按下列五步)**:
  1. 确认 `app.asar/out/main/ext-cas-gc-worker.js` 存在(`npx @electron/asar list <app>/Contents/Resources/app.asar | grep ext-cas-gc-worker`);
  2. packaged app 对隔离 heavy fixture(可用 `packages/ui-mac/scripts/bench-cas-gc.ts` 的 heavy 档参数造店)实际触发一轮(等 5 分钟首跑或临时把 `CAS_GC_INITIAL_DELAY_MS` 建包为短值);
  3. 观察日志出现 `[cas-gc-scheduler] gc-success` 结构化摘要(worker 真跑通、非 gc-exception);
  4. 同时记录 main 事件循环最大延迟或 UI heartbeat,判定 **<100ms**(GC 期间 UI 无可感知冻结);
  5. 该 RC 的执行结果落 `docs/verification/`(唯一权威落点;此处只维护步骤,不存活跃结果)。
- **耦合面复核**(C14):发版/re-freeze 前跑 `upstream-anchors` 契约测试;`providers.ts` 之外不得出现 alpha 组件直 import `@opencode-ai/app`;build 若被 brand/patch strict 拦下 = 上游子串漂移,更新清单而非放行。
