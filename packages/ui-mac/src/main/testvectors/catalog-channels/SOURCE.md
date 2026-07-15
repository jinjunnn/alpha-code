# 来源(勿手工编辑)

只读镜像自 `jinjunnn/alpha-web` `contracts/catalog-channels/testvectors/`
@ commit `21ebbe1`(REQ-101 #35 snapshot + #36 advisory 向量集,由
`scripts/gen-channel-testvectors.mjs` 生成)。

更新方式:在 alpha-web 重跑生成器 → 整目录复制到此 → 更新本文件 commit 号。
消费:`catalog-channels.test.ts` 按 `vectors.json` 的 expected 断言。
