---
id: REQ-101
title: Signed Channel Metadata v2：stable/preview/dev 精确晋级 + expiry/key rotation/revocation
type: security
github_issue: https://github.com/jinjunnn/alpha-work/issues/4
repo: X
created: 2026-07-10
source: 2026-07-10 路由与扩展生态所有权专项审计；用户要求拆为独立 REQ
---

## 背景

当前单 URL、单公钥、单 Catalog 签名已经能防普通篡改和版本回退，但不足以表达 metadata expiry、密钥轮换、channel、snapshot 一致性、撤销、advisory 和兼容范围。Git 长期分支也不能作为不可变软件分发通道。

## 目标与交付

1. 建立严格命名的 `signed channel metadata v2`，而不是只借用“TUF-style”名称。
2. 定义 stable/preview/dev channel target；promotion 只移动同一 manifest/blob digest 指针，不重新构建。
3. metadata 包含 sequence、expires、snapshot identity、target digest/size、compatibility、revocation/advisory 与 key id。
4. 支持可验证 root key rotation；客户端拒绝过期、降序、mix-and-match、未知 key 和 digest/size 不符。
5. 公共安全撤销属于签名 Registry metadata，可离线生效；alpha-platform 只提供组织/团队额外 policy 覆盖。
6. 短期把 `alpha-web/catalog-src` 提炼为独立 release unit；只有 publisher/镜像/委派规模达到阈值时才拆 `alpha-registry` 新仓。

## 验收标准

1. preview 验证过的 target 晋级 stable 后 digest 完全相同；CI 禁止 promotion 时重新打包。
2. 过期 metadata、旧 sequence、错误 snapshot、替换 blob、撤销 target、未知 key 均被客户端拒绝，且缓存 last-known-good 的策略清晰可测。
3. 双签换钥演练完成：旧客户端、新客户端和离线窗口行为符合书面 runbook。
4. 同一版本号不同 digest 被拒绝；同一 digest 可被多个 channel 引用。
5. 发布端和客户端 schema 有跨仓 contract tests；错误不会退化为静默使用未验内容。
6. advisory 能使已缓存 target 禁止再次启用，同时保留审计和取证信息。

## 非目标

- 不在本项声称兼容完整 TUF；只有完整实现角色、阈值、snapshot、expiry、rollback 语义后才另行决策。
- 不引入 OCI/ORAS 或要求用户安装 Docker。
- 不实现本地 CAS/seed（REQ-102）。

## 依赖与激活条件

- 依赖 REQ-099 的 canonical manifest/target digest 语义。
- 跨仓实施必须分别在 owning repository 建子 Issue 与 contract gate；GitHub Issues 和 Alpha Delivery 是唯一交付真源。
