# S33 真机批 —— REQ-069/070/071/072/073 验证(2026-07-09)

> 环境:正式安装包(prod 渠道,本地打包 12:19 装入 `/Applications/alpha-code.app`,ad-hoc 签名)+
> **真实 profile**(登录态·余额不足;既有项目 workspace/alpha-code;BYOK glm 已配)。
> 走查方式:`ALPHA_CDP=1` 启动 + CDP 驱动,全只读(未发消息、未保存自动化、未动用户数据);
> 截图 = 本目录 `*.png`。结论:**五需求全部 verified,当轮归档**。

## 逐项判定

| REQ | 场景 | 结果 |
|---|---|---|
| **069** | 登录+余额不足态:composer 沿用用户 BYOK 持久选择(glm-5.1),**未默认到 member-only 代理**;picker「余额不足·充值后解锁代理」横幅如实;代理区全为 CN 节点 id(DeepSeek V4/glm/qwen),**零海外 model id 外显**(`06-model-picker.png`) | ✅ PASS(登出残留挂起场景本机不复现——用户当前选择合法有效;该场景证据 = S32 CDP 隔离双场景 + 27 单测) |
| **070** | 双自有域探活:`alpha-gateway/alpha-cloud.tidelabs.click` HTTP 404 = worker 已应答(路由活,根路径无 handler;S32 已录 `/health` `/v1/models` 200);A 默认值单测锁定 | ✅ PASS(注:本机 `window.api.endpoints()` 仍为旧登录 pin(workers.dev)——**设计内**,下次登录 discovery 自动刷新,CHANGELOG 已声明;迁移窗口内旧域在线) |
| **071** | 工作区弹层含「Alpha · 默认工作区」常驻入口(`01-ws-popup.png`);既有项目用户 chip 照旧首项目(零打扰);`~/Alpha`(用户 09:52 预建的空目录,早于新包安装)被**如实沿用未覆盖**;`/alpha-workspace` 出厂技能在 `/` 菜单 31 条中(内置签);自动化面板「模板:每日总结 → Alpha/Journal」按钮在,点击预填(名称/目录 ~/Alpha/21:00/可写档)且**不自动保存**(`10/11-auto-*.png`) | ✅ PASS(lazy 创建路径由 12 单测锁定;目录预存分支 = ADR-025 §2 沿用语义实证) |
| **072** | `/` 菜单:分节(内置命令/技能/MCP)+ 31 条全量 + 类型 icon + 行尾归属签 + 页脚计数(`07-slash-retry.png`);键盘 ↓×3 → 选中 3(`08-slash-kbd.png`);搜「审查」中文命中 `/review`(`09-slash-zh.png`) | ✅ PASS(注:引擎冷启动就绪前首开菜单只有 app 内置项——每次打开重拉,就绪后即全量;老缺陷非本批引入,观感可后续加载态优化) |
| **073** | `@` 装配弹窗四节(添加/AGENT/文件/扩展),agent 中文降噪+内置签(`04-assemble.png`);点「计划模式」→「⊗ 计划」chip + placeholder 切换(`05-plan-chip.png`);Shift+Tab 关闭;**build 组件已消失**(工具条 chips 无 agent 项);+ 按钮同弹窗 | ✅ PASS |

## 遗留(不阻断归档,已知/新登记)

1. `/` 菜单引擎就绪前首开呈现不全(重开即恢复)——加载态观感,视用户体感决定是否立项;
2. REQ-070 存量机器 endpoints 刷新依赖下次登录(设计内);B 关旧域前置 = C 部署 + 升级率(已在档);
3. REQ-069 残单「Image #4 UI 细节」始终未获用户复现,随本批关闭(再现即新报障)。
