# catalog-channels testvectors(B 侧合同测试向量,只读拷贝)

- 来源:`alpha-web` 仓 `contracts/catalog-channels/testvectors/`(REQ-101 B 侧)
- 来源版本:`alpha-web@9cb605703d72682d053819426aacf5ed54263d85`(PR jinjunnn/alpha-web#31,2026-07-13)
- 合同本体:`alpha-web/contracts/catalog-channels/CONTRACT.md`(§4 拒绝矩阵 R1–R12,§5 校验顺序)
- 消费方:`packages/ui-mac/src/main/catalog-channels.test.ts`(issue #193,REQ-101 A 侧)
- 纪律:**不得手工编辑任何向量文件**(签名覆盖精确字节);B 侧更新向量时整目录重拷 + 更新本文件的来源版本。
- `vectors.json` 是机器可读索引(expected 断言);三个负向(tampered / expired / mix-and-match)必须被 A 侧拒绝。
