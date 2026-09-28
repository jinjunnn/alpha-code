# alpha-code#1445 —— 条目形状 × fail-open(2026-09-27)

第三轮勘破的证据目录。问题:把「认出条目形状才声称是搜索结果、认不出一律放行」当成 fail-open 命题之后,
它自洽吗、四种真实负载各落哪一格、Exa 的渲染到底多久换一次、这份信息拿来做什么才值得。
结论在 [`../../architecture/2026-09-27-exa-entry-shape-fail-open-recon.md`](../../architecture/2026-09-27-exa-entry-shape-fail-open-recon.md);
这里只放证据与复现手段。**全部离线,不打 Exa 端点。**

## 文件

| 文件 | 是什么 |
| --- | --- |
| `entry-shape.py` | 离线版:命题(E = `Title:`+`URL:` 行对数;J = JSON 顶层 `results[]` 长度;任一 ≥1 才声称,否则放行不声称)跑仓里四种真实负载 —— D(`../2026-09-24-1445-exa-mcp-response-shapes/results/ticket-payload.json`)/ Z(vendor 源码逐字)/ A、P(`../2026-09-26-1445-exa-vendor-source-and-live-shapes/results/live-shapes.json`)—— 外加六条变异臂证明识别器看的是行结构 |
| `results/entry-shape-offline.txt` | 上一行的输出:D 放行不声称 / Z 放行不声称 / A 声称 3 条 / P 声称 10 条;六条变异臂全部符合预期 |
| `probe-entry-shape.ts` | 生产路径版:同四种负载**先经两份生产 `parseResponse`**(`packages/opencode/src/tool/mcp-websearch.ts`、`packages/core/src/tool/websearch.ts`)取出模型会看到的文本,再跑同一命题。要跑得拷进 `packages/opencode/` —— 模块解析要求 |
| `results/probe-entry-shape.txt` | 上一行的输出:两份解析器对四种负载都判成功、取出的文本长度逐格相同(246 / 54 / 5310 / 19341),四格 claim 与离线版逐格相同 |
| `vendor-all-versions.py` | 拉 npm 上 `exa-mcp-server` **全部 49 个**发行版的 tarball(缓存到 `<cache-dir>/`),按整包聚合判:成功渲染是哪一种、带不带 `_meta.searchTime`、限流提示带不带 `isError`、零命中文案在不在、工具名。签名变化的版本额外把上下文写进 excerpts 文件 |
| `results/vendor-all-versions.txt` / `results/vendor-all-versions.json` | 上一行的输出(逐版一行 / 逐版特征 JSON)。整包聚合会被别的工具(company_research 等)的渲染污染,所以边界判定以下一行为准 |
| `vendor-websearch-window.py` | 精确到 **`web_search` 处理函数**:从工具名字符串(`search` → `web_search` → `web_search_exa`)往后取 9000 字窗口,只在窗口里判渲染;给定版本号时打印该版的关键上下文 |
| `results/vendor-websearch-window.txt` | 上一行的输出:三代渲染的边界 —— `0.1.0`–`3.0.7` `JSON.stringify(response.data)` / `3.0.8`–`3.1.9` 直出 `response.data.context` / `3.2.0`–`3.4.1` `Title:` 行 + `_meta.searchTime`;含 `0.1.0` `0.3.7` `2.0.1` `3.0.7` `3.0.8` `3.1.9` `3.2.0` `3.4.1` 八版的源码上下文 |

## 复现

```
# Q2 离线版(从仓根跑;参数是 docs/verification 的路径,缺省即它)
python3 docs/verification/2026-09-27-1445-exa-entry-shape-fail-open/entry-shape.py docs/verification

# Q2 生产路径版
cp docs/verification/2026-09-27-1445-exa-entry-shape-fail-open/probe-entry-shape.ts packages/opencode/probe-1445c.ts
cd packages/opencode && bun run probe-1445c.ts < /dev/null
rm packages/opencode/probe-1445c.ts

# Q3 全版本普查(只访问 registry.npmjs.org;49 个 tarball 约 60 MB,缓存在 <cache-dir>)
python3 docs/verification/2026-09-27-1445-exa-entry-shape-fail-open/vendor-all-versions.py /tmp/exa-tgz /tmp/exa-excerpts.txt
python3 docs/verification/2026-09-27-1445-exa-entry-shape-fail-open/vendor-websearch-window.py /tmp/exa-tgz 3.0.7 3.0.8 3.1.9 3.2.0
```

## 读法

- `entry-shape-offline.txt` 与 `probe-entry-shape.txt` 的四格必须逐格一致 —— 前者证明命题,后者证明它跑在生产解析器取出的那段文本上。
- `vendor-websearch-window.txt` 里 `render=` 那一列翻转的行就是渲染换代的版本;`vendor-all-versions.txt` 里 `<-- CHANGED` 标的是整包签名变化(含工具增减),比渲染换代更频繁,不要拿它当渲染变更计数。
- 变异臂第一次跑时「标签不在行首」那条没翻:变异用 `replace("\nTitle: ")` 碰不到偏移 0 的第一行,改成按行首正则之后翻了。这是变异漏了,不是识别器漏了;留在这里是为了下次别再犯。
