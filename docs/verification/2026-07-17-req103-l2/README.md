# REQ-103 L2 视觉证据 — #307 scope 分组做实 + #392 已授权能力段(2026-07-17)

真实 CSS harness 截图(#348 同款 L2 模式):`tokens.css` + `extension-hub.css` 逐字加载,
DOM 复刻 `extension-hub.tsx` / `extension-detail.tsx` 实现产出,零样式覆写。
对照基线 = 已批设计稿 `docs/design/2026-07-17-req103-remaining/design.html`(approved 2026-07-17)。

| 文件 | 内容 |
|---|---|
| `req103-l2-light.png` | 浅色:①已安装 global+本项目组(只读 pill、无开关、卸载);②空态 A(组头+说明行);③详情页已授权能力(高危 chip 同 #348 分级 + meta 行);④双空态(无授权记录 / 未请求任何能力) |
| `req103-l2-dark.png` | 同四态,`:root[data-color-scheme="dark"]` |

判定:四态 × 双主题与已批稿改动一/改动二一致(组头 pill、行动作区、authz 行规格、空态文案位)。
空态 B(无项目上下文 → 组整体不渲染)为「不渲染」事实,由单测与代码路径覆盖,无视觉面。
