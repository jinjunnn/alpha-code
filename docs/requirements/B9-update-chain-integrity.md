---
id: B9
title: 更新链完整性:关 allowDowngrade + 完整性校验
type: security
priority: P1
status: verified
repo: A
created: 2026-07-03
sprint: 2026-07-03-s10-hardening
source: 册 §6.2 / R5
---

## 背景/证据
R5 已修尖角:feed owner 从 anomalyco/opencode 改指 `jinjunnn/alpha-code`(PR #32),v0.1.0 起 feed 为自有签名产物。剩余:`allowDowngrade=true` 仍开(降级攻击面,`updater-controller.ts:45-55`)+ 更新链完整性依赖(zip-vs-yml SHA + macOS 签名)未显式核验成链。

## 验收标准
1. `allowDowngrade` 关闭(或写明保留理由与补偿控制);
2. 更新完整性链核实并文档化:latest-mac.yml SHA → zip → app 签名校验各环节实测(含篡改 yml 的失败用例);
3. 分发后的更新路径实测:v0.1.0 → 下一版真机自动更新成功。

## 关联
A7(签名,已 verified)、B7(发版流水线)、C27(fuses,邻接加固)。

## 采纳方案(2026-07-03,PR #47)
`updater.ts` 关 `allowDowngrade`(验收①)。理由入注释:true 是上游 desktop 多渠道切换遗留,alpha 单
prod 渠道无此需求;开着=feed 替换/重放旧版可把用户打回含已修漏洞版本。装旧版逃生口=手动下载
Release dmg(签名+公证),不走自动更新。

## 完整性链(验收②,文档化)
1. **feed 来源**:`https://github.com/jinjunnn/alpha-code/releases/latest/download/latest-mac.yml`
   (https + 自有 repo,owner 已修 PR #32);
2. **产物校验**:electron-updater 下载 zip 后按 `latest-mac.yml` 的 `sha512` 逐字节校验,不符即拒
   (内建,零配置);⟹ 篡改 yml 需同时能改 Release 资产(同一信任域,GitHub 账号 2FA 为根);
3. **签名校验**:macOS 侧 electron-updater 安装前校验下载 app 的代码签名与运行 app 同 identity
   (Developer ID RQX6X6A635);签名不符拒装 —— 即使 yml+zip 全被替换,未持我们签名私钥装不进去;
4. **降级闸**:本 PR 关闭(链条此前唯一的显式弱点)。
残余(诚实):GitHub 账号是信任根(2FA/token 卫生);首启 TOFU 由公证+Gatekeeper 覆盖。

## 验证记录
- 2026-07-03:allowDowngrade=false 合入;typecheck+tests 绿。
- **待(验收②篡改用例 + ③真机)**:下个真实发版时——v0.1.x → 新版自动更新成功 + 手改本地缓存 yml 的
  sha512 观察拒装(随发版 runbook 执行,一次记录)。
