# REQ-104 #396 L2 视觉证据 — Pack 详情页整包事实段(2026-07-17)

真实 CSS harness 截图(#348/#393 同款 L2 模式):`tokens.css` + `extension-hub.css` 逐字加载,
DOM 复刻 `extension-detail.tsx` 实现产出,零样式覆写。
对照基线 = 已批设计稿 `docs/design/2026-07-17-req104-pack-facts/design.html`(approved 2026-07-17)。

| 文件 | 内容 |
|---|---|
| `req104-l2-light.png` | 浅色:①整包事实四行(体积「≥ X + N 项未知」pill、密钥 mono + 其余无密钥、运行面、最低支持档)+ 能力并集框(高危优先、来源子项标注、3+ 收敛计数);②变体(无密钥/体积全已知) |
| `req104-l2-dark.png` | 同两态,`:root[data-color-scheme="dark"]` |

判定:与已批稿改动一一致(段位置 = 简介与子项列表之间,由实现代码位序保证)。
