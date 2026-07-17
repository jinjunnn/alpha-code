# REQ-104 #395 L2 视觉证据 — 第三方默认关 + 全类型启用开关(2026-07-17)

真实 CSS harness 截图(#348/#393/#398 同款 L2 模式):`tokens.css` + `extension-hub.css` 逐字加载,
DOM 复刻 `extension-hub.tsx` InstalledRow 实现产出,零样式覆写。
对照基线 = 已批设计稿 `docs/design/2026-07-17-req104-pack-facts/design.html` 改动二(approved 2026-07-17)。

| 文件 | 内容 |
|---|---|
| `req395-l2-light.png` | 浅色:第三方插件/连接器默认关(「已安装 · 未启用」徽标 + 关态开关 + 状态行提示);第一方技能/Agent 默认开;开关对全类型(技能/Agent/插件/连接器)在场 |
| `req395-l2-dark.png` | 同态,`:root[data-color-scheme="dark"]` |

行为链路(装→默认关→enable→生效→disable→不可见)由单测矩阵覆盖(ext-install-policy /
ext-set-state-tx / gen-skill-paths 投影门 / ext-seed-install #395 块),不属视觉面。
