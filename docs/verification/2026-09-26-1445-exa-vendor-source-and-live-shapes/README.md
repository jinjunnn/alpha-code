# alpha-code#1445 —— 补勘:vendor 源码 × 今天的活体形状(2026-09-26)

问题不变:**「这是一段错误提示」有没有结构化信号可消费?**
上一轮(`2026-09-24-1445-exa-mcp-response-shapes`)的前提「失败臂没被观测过」被订正 ——
坏负载的**文本**是实抓的,没观测到的只是信封元数据。本目录是在这个前提下重做的证据;
结论与逐条排除在 [`../../architecture/2026-09-24-exa-mcp-failure-signal-recon.md`](../../architecture/2026-09-24-exa-mcp-failure-signal-recon.md)
的《2026-09-26 补勘》一节。这里只放证据与复现手段。

## 文件

| 文件 | 是什么 |
| --- | --- |
| `vendor-source.py` | 读 npm 上 exa-mcp-server **四个发行版**(3.1.9 / 3.2.1 / 3.4.0 / 3.4.1)的构建产物,回答:限流提示怎么返回(带不带 `isError`)、成功渲染成什么(带不带 `_meta`)、零命中渲染成什么。只访问 registry.npmjs.org,不耗 Exa 额度 |
| `results/vendor-source-excerpts.txt` | 上一行的输出。要点:**四个版本都给限流提示置 `isError: true`**;3.1.9 成功时直出 Exa API `/context` 整段(无 `Title:`/`URL:` 行、无 `_meta`),3.2.1 起改成逐条 `Title:/URL:` + `content[0]._meta.searchTime`;零命中四个版本都是 `{content:[{type:"text",text:"No search results found. Please try a different query."}]}`,无 `isError` |
| `live-shapes.mjs` | 今天 nokey 打 `https://mcp.exa.ai/mcp` 一次、keyless 打 `https://search.parallel.ai/mcp` 一次,保存**完整原始响应**(状态 / 全部头 / body)。请求与 `packages/opencode/src/tool/mcp-websearch.ts` 的 `call()` 同形,参数与 `#1433` 的探针逐字相同 |
| `results/live-shapes.json` | 上一行的输出(04:27Z)。Exa:200 `text/event-stream`,3 条结果,`content[0]._meta.searchTime`;Parallel:200 `application/json`,`isError:false` + `structuredContent` + `result._meta["parallel/usage"]`,文本是 JSON。**额度已重置**(09-24 跑满的那次 `x-ratelimit-reset` 指向 09-25 00:00Z) |
| `probe-parsers.ts` | 四种真实负载(票面 D / 零命中 Z / 今日 Exa A / 今日 Parallel P)喂进两份生产 `parseResponse`,并列出每份的结构特征向量。要跑得拷进 `packages/opencode/` —— 模块解析要求 |
| `results/parsers-now.txt` | 上一行的输出(`#1449` 合入 `8f0fc0900` 之后重跑,逐字节未变):四种负载两份副本**全部判成功**;D 与 Z 的信封特征逐格相同,文本层唯一差别是 D 有 2 个 URL、Z 有 0 个 |

## 复现

```
python3 docs/verification/2026-09-26-1445-exa-vendor-source-and-live-shapes/vendor-source.py

node docs/verification/2026-09-26-1445-exa-vendor-source-and-live-shapes/live-shapes.mjs   # 各打一次,耗 1 次 Exa 额度

cp docs/verification/2026-09-26-1445-exa-vendor-source-and-live-shapes/probe-parsers.ts packages/opencode/probe-1445b.ts
cd packages/opencode && bun run probe-1445b.ts < /dev/null
rm packages/opencode/probe-1445b.ts
```

⚠️ Exa 的免费额度按出网 IP 计,跑满要等到次日 00:00Z。`live-shapes.mjs` 只打一次;别为了「再看一眼」循环跑。

## 读法

- `vendor-source-excerpts.txt` ① 那一行回答的是「开源代码会不会发出票面那一种(2xx + `result` + 非 `isError`)的限流提示」——
  **不会**,四个版本都 `isError:!0`。所以 D 是 `mcp.exa.ai` 托管端自己那一层的产物(它的 `tools/list` inputSchema 也与任一 npm 版不同),源码拿不到。
- ② 那一行回答的是「`_meta` / `Title:` 行能不能当成功判据」—— 3.1.9 的真结果两样都没有,半年内换过一次渲染。
- ③ 那一行回答的是「零结果与一段散文在结构上分不分得开」—— 分不开,零命中**就是**一段散文,信封与 D 逐格相同。
