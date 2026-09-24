# alpha-code#1445 —— Exa MCP 响应形状实读

问题:**「这是一段错误提示」有没有结构化信号可消费?**
结论与全部分析在 [`../../architecture/2026-09-24-exa-mcp-failure-signal-recon.md`](../../architecture/2026-09-24-exa-mcp-failure-signal-recon.md)。
本目录只放证据与复现手段。

## 文件

| 文件 | 是什么 |
| --- | --- |
| `probe-exa-shapes.mjs` | 探针。打 `https://mcp.exa.ai/mcp` 本体,请求与 `packages/opencode/src/tool/mcp-websearch.ts` 的 `call()` 逐字同形 |
| `results/arms.json` | 本次运行(11:46Z,额度已跑满的窗口)的各臂原始判据字段 |
| `results/success-arm-sample.log` | 成功臂样本(11:37–11:39Z,额度未尽的窗口):27 次 200 响应,`meta=true` 全中 |
| `results/ticket-payload.json` | `#1445` 票面那一种的负载(246 字,逐字复制自 `#1433` 的记录)+ envelope 每一格是怎么反推的、哪一格反推不出来 |
| `probe-parsers.ts` | 两份生产 `parseResponse` 对三种负载的判定(AC2 的「改前」臂)。要跑得拷进 `packages/opencode/` —— 模块解析要求 |
| `results/parsers-before.txt` | 上一行的输出 |

## 复现

```
node docs/verification/2026-09-24-1445-exa-mcp-response-shapes/probe-exa-shapes.mjs

cp docs/verification/2026-09-24-1445-exa-mcp-response-shapes/probe-parsers.ts packages/opencode/probe-1445-parsers.ts
cd packages/opencode && bun run probe-1445-parsers.ts < /dev/null
rm packages/opencode/probe-1445-parsers.ts
```

⚠️ **Exa 的免费额度按出网 IP 计,跑满要等约 12 小时**(实测 `retry-after: 44333`)。
成功臂只有在额度未尽时量得到;额度已尽时同一条命令返回 429。
别为了「再看一眼」重跑整套 —— 代价是本机无 key 的本地搜网在那段时间里全部失败。

## 读法

`results/arms.json` 每一行的判据字段就是生产 `parseResponse` 会看的那几样:
`status` / `jsonrpc` / `isError` / `structuredContent` / `contentBlocks[].meta`。
`list-outputSchema` 那一臂回答的是「Exa 声明了 outputSchema 吗」——
声明了才谈得上拿 `structuredContent` 当成功判据。实读:两个工具都没有。
