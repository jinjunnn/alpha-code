# REQ-104 L2 视觉证据 — #397 PR-B 四级货架与策展呈现(2026-07-18)

真实 CSS harness 截图(#348/req103 同款 L2 模式):`tokens.css` + `extension-hub.css` 逐字加载
(经本地 http.server 服务 `src/renderer/`,`@import` 相对路径原样解析),DOM 复刻
`extension-hub.tsx` / `extension-detail.tsx` 实现产出(类名/结构/data-attr 一一对应),零样式覆写。
对照基线 = 已批设计稿 `docs/design/2026-07-18-req104-four-shelf/design.html`(v6,approved 2026-07-18)。
深色 = `document.documentElement.dataset.colorScheme = "dark"`(与 opencode 排程一致)。

| 文件 | 内容 |
|---|---|
| `req104-shelves-l2-light.png` | 浅色四态(下表) |
| `req104-shelves-l2-dark.png` | 同四态,深色 |

| 态 | 覆盖点(v6 稿对照) |
|---|---|
| 1 推荐货架 | 甄选驱动三货架(核心空 → 整组隐藏);组头标题+用户语言副标题;卡片名称行四色分级 chip;meta pill 密钥/体积事实(诚实口径「下载约 5.4 MB」/「需 3 项密钥」) |
| 2 连接器 tab | category 分组保留 + 分级 chip;归档卡 = 归档 chip + 「不可安装」置灰(tooltip 给原因);「未分级」尾组 = 诚实组头说明 + ghost 添加按钮 + 无分级 chip(缺席即身份) |
| 3 详情页 | 甄选事实真源整段切换:数据边界(能力 pills + 5 域名清单 + 观察注脚)/所需密钥(名称+来源标注)/所有权(甄选·审核于 / 上游状态 / 支持=无支持承诺 / 复审期限);归档 warnbox + 头部「不可安装」;「组件与来源」= 拉取失败行(loud + 重试,明示不影响其余判定)+ 来源快照已校验行(mono locator+integrity) |
| 4 fail-closed + 实验室降级 | 「分级」一行如实上报(仅 invalid 态);「启用方式」段(session-grant 讲人话 + #408 未落地的如实说明);已装实验室行 = 「仅支持按会话开启 · 此功能即将提供」且**不渲染开关**(诚实缺席,非置灰假开关);对照精选行照常有开关 |

判定:四态 × 双主题与 v6 已批稿改动一/二/三/四一致(货架序/空货架隐藏/chip 四色/未分级组头/
归档禁装/域名清单版式/评审事实行/组件与来源双行校验态/降级行无开关)。会话开关帧属 #408,
本稿如实降级不渲染(v6 稿允许的中间态,PR 说明有记)。
