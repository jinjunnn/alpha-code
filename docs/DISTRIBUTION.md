# 分发 / 打包 runbook(Mac 签名 · 公证 · 自动更新)

面向:把 alpha(opencode 引擎 + 自有前端/后端)打成一个**你自己**的、可分发给别人 Mac 的签名+公证 app。

## 一次性:代码侧已就绪(本仓,零改上游)
`packages/ui-mac/electron-builder.config.ts` + `scripts/install-local.ts` 已改为:
- **品牌**:prod/beta 渠道 productName = `alpha-code`(不再 "OpenCode");URL scheme name = `alpha-code`;artifact = `alpha-code-*`。
- **Bundle 身份**:`com.tide.alphacode`(dev/beta 加后缀),沿用 tideapp 的 `com.tide.*` 约定,**不再是** `ai.opencode.desktop`。⚠️ 改 appId = 一次性重置 app 存储(会话历史/最近项目列表/登录);**磁盘上的项目文件不受影响**,重开一次即可。
- **自动更新源(B9)**:prod → `jinjunnn/alpha-code`(你自己的 **public** repo)`latest` 渠道;beta → 同 repo `beta` 渠道。**不再指 `anomalyco/opencode`**(否则会把上游 OpenCode 当更新覆盖掉 alpha)。
- **签名**:`ALPHA_SIGN=1` 时启用 Developer ID 签名 + 公证(team `RQX6X6A635`),否则 ad-hoc(本地可双击,不能分发)。

## 你只需做两件事(需 Apple 账号,我做不了)

Apple 团队 = **RQX6X6A635(Beijing yuanyuji Technology Co.,Ltd)**,即 tideapp 签名的同一个 team。钥匙串里现有的是 iOS 证书(`iPhone Distribution`)——**Mac 直接分发需要另一种证书**:`Developer ID Application`。

### 1. 造 `Developer ID Application` 证书(~2 分钟)
- Xcode → Settings → Accounts → 选中 team RQX6X6A635 的 Apple ID → **Manage Certificates** → 左下 `+` → **Developer ID Application**。
- 或 developer.apple.com → Certificates → `+` → Developer ID Application(走 CSR 流程)。
- 造完 `security find-identity -v -p codesigning` 应出现 `Developer ID Application: Beijing yuanyuji Technology Co.,Ltd (RQX6X6A635)`。配置默认自动发现它(可用 `ALPHA_SIGN_IDENTITY="..."` 覆盖)。

### 2. 备好公证凭证(二选一,走环境变量)
- **App Store Connect API key(推荐)**:developer.apple.com → Users and Access → Integrations → App Store Connect API → 生成 → 下载 `AuthKey_XXXX.p8`。然后:
  ```
  export APPLE_API_KEY=/绝对路径/AuthKey_XXXX.p8
  export APPLE_API_KEY_ID=XXXX
  export APPLE_API_ISSUER=<issuer-uuid>
  ```
- **或 Apple ID + 专用密码**(appleid.apple.com 生成 app-specific password):
  ```
  export APPLE_ID=<你的 Apple ID 邮箱>
  export APPLE_APP_SPECIFIC_PASSWORD=<app 专用密码>
  export APPLE_TEAM_ID=RQX6X6A635
  ```

## 出一个签名+公证的分发包
```
OPENCODE_CHANNEL=prod ALPHA_SIGN=1 bun --cwd packages/ui-mac run ship:mac
```
产物:`dist/` 下的 `alpha-code-mac-arm64.dmg` / `.zip` + `latest-mac.yml`(更新 feed)。把这三个作为一个 **GitHub Release** 传到 `jinjunnn/alpha-code`,别人下载 dmg 即可安装,装好的 app 会从该 repo 自动检查更新。

> 本地只是想跑不分发:去掉 `ALPHA_SIGN=1`,得到 ad-hoc app(仅本机双击)。

## 首个 prod build 需盯的已知项(还没实测)
- **A5/A4 `@opencode-ai/plugin@local` / `InstallationVersion=local`**:内嵌 opencode server 的依赖打包问题,只在**打包态**暴露(dev 跑不出)。app 显示版本已修为 `0.1.0`(`ui-mac/package.json`),但内嵌 server 的 InstallationVersion 是另一条链,首个 prod 打包时验证是否仍报 `local` 安装失败;若报,需把该依赖预置进 extraResources(见 register S2/T2.3)。
- **公证时长**:Apple 公证是在线步骤,首次可能几分钟。
- **updater feed**:第一个 Release 传上去前,已装 app 检查更新会「无更新」(正常,不是错误)。
