# 来源(勿手工编辑)

只读镜像自 `jinjunnn/alpha-web` `contracts/catalog-channels/testvectors/`
@ commit `6154104`(alpha-web 分支 feat/283-codepuppy-identity:契约 ID 改为 `codepuppy.catalog.*`、
测试签名钥换为 keyId `a469ae7c…`;向量集仍是 REQ-101 #35 snapshot + #36 advisory,由
`scripts/gen-channel-testvectors.mjs` 生成)。

更新方式:在 alpha-web 重跑生成器 → 整目录复制到此 → 更新本文件 commit 号。
消费:`catalog-channels.test.ts` 按 `vectors.json` 的 expected 断言。
