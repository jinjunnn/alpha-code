# B21 真机验证 · BYOK 改键/删键即时生效(DeepSeek 真 key)

> 2026-07-07 下午,用户在场提供 DeepSeek 真 key(尾号 ee03)。
> 环境:装机 `/Applications/alpha-code.app` v0.1.2 **含当日 PR #141/#142**(asar 构建时间 14:22,dev 渠道 `com.tide.alphacode.dev`,userData=`ai.opencode.desktop.dev`);未登录(纯 BYOK,无代理干扰)。
> 方法:REQ-016 同法 —— 装机二进制 + `--remote-debugging-port` CDP 真鼠标/键入;发消息经引擎 v1 `/session/{id}/message`(阻塞式,scratch 目录 `~/b21-test`,避开 fork 仓生 TS 工具坑 ADR-006);key 变更走 `window.api.providers.setKey/removeKey`(= 表单「保存/移除」同一 IPC)。截图 `shots/`。

## 前置事实(证据链设计依据)

- vault 原有旧 key(hint `f807`),且**旧 key 实测仍有效**(直连 DeepSeek /models = 200)→「新 key 出账」不能只靠聊天成功证明,**判定面 = A6 密钥文件内容**(`<userData>/alpha-secrets/DEEPSEEK_API_KEY`,sidecar {file:} 通道真源)。B21 原 bug 正是「改键后该文件仍镜像旧 key」。

## 验收逐条

### ① 改键/删键免重启生效 — PASS

| 动作 | IPC 耗时 | respawn 链(main.log) | 密钥文件 |
|---|---|---|---|
| 改键(f807→ee03) | 4ms | 15:43:26.397 respawning → 15:43:27.981 `alpha-secrets sync: wrote [DEEPSEEK_API_KEY]` → 15:43:28.878 server ready(**~2.5s**) | tail4 `ee03`,mtime 15:43:27 ✓ |
| 删键 | 3ms | 15:47:34 respawning → `alpha-secrets sync: wrote [] removed [DEEPSEEK_API_KEY]` | **文件已删** ✓ |
| 复键(UI 表单保存) | — | 15:56:55 sidecar respawned + renderer reloaded | tail4 `ee03` ✓ |

全程 app 不重启;respawn 单飞(B5 互斥)三次触发无抢占异常。

### ② picker 状态与 sidecar 实际一致(改键后立即发消息成功)— PASS

- 改键后 keyStatus 即时 `{configured:true, source:"keychain", hint:"ee03"}`;真消息(deepseek-v4-pro,「1+1=?」)**4.6s 回复 "2"**,免重启。密钥文件=新 key,故出账 key=新 key(判定面见前置)。
- 删键后 picker 即时反映:直连 deepseek 4 条模型行**全部消失**,DeepSeek 落「未配置 KEY · 点击配置需 KEY」行(shots/11)。
- 复键后直连 4 行回归(shots/15),真消息 deepseek-v4-flash 3.0s 回复(顺带补答失败期积压问句,反证删键期确实不可用)。

### ③ 删键后模型立即不可用且有明确提示 — PASS(引擎侧 loud;UI 发送侧呈现归 B11)

- picker:需 KEY 行明示「未配置 KEY · 点击配置」(shots/11)。
- 发消息(删键后):引擎 500 `{"name":"UnknownError",...,"ref":"err_fffb3b47"}` —— loud 报错非静默 401。会话内消息在复键后被补答,证明删键期间未以任何残留 key 出账。
- UI 发送侧 banner/toast 实拍归 [[B11]](本批未覆盖)。

### ④ 并发保护复用 B5 respawn 互斥 — PASS(码面 + 单测,PR #48;本场未见双 fork/双 reload)

## 真实 UI 路径实测(REQ-056 修复面)

- **需 KEY 行 → 配置表单**:真鼠标可达(shots/12,DeepSeek 预填 baseURL/模型清单)。
- **测试连接**:真 key 实测「✓ 已接通 · 316ms」(shots/14,main 进程 1-token 真聊天)。
- **保存并启用**:落 keychain → 触发 respawn → picker 即时回归已配置(shots/15)。

## ⚠️ 本场新发现 → [[REQ-061]](P1,已登记)

> 注:本发现最初登记为 REQ-060,后因与并行 session 的「项目级扩展 .alpha-only」编号撞车,改编 REQ-061(ADR-018 ID 不复用)。

**统一 composer 弹层 click-outside 竞态:凡点击会同步卸载「被点按钮」的交互,整层弹窗被误关。** 装机包 3 次复现:
1. 「添加自定义节点/供应商」step1 → 点任意预设行(如 DeepSeek「已配置」)→ 应进表单,实际**整层关闭** → **已配置供应商的改键表单入口不可达**(需 KEY 行路径不受影响,因点击不卸载列表)。
2. 表单「返回」→ 应回 step1,实际整层关闭。
3. (同机制推定)step1「其他/自定义端点」行。

根因(源码级):`alpha-composer.tsx useChip.onDoc` 监听 document click,以 `e.target.closest(".a-pop-wrap,.a-pop")` 判内外;Solid 事件委托下点击处理器同步重渲染把被点按钮 detach 出 DOM 后,`closest` 返回 null → 误判外部点击 → `close()`。`.a-pop` 上的 `onClick=stop` 拦不住(同为 document 级监听,stopPropagation 不阻同节点其它 listener)。**修法:onDoc 改用 `e.composedPath()` 做包含判定**(dispatch 时快照,不受 detach 影响)。

影响:B21 的「改键」用户不能经 UI 完成(可先删键再走需 KEY 行绕行);本验证以 IPC(=保存按钮同一调用)+ 全证据链覆盖后端语义,**B21 翻 verified 不受阻,REQ-061 修复后下一真机批补「已配置行改键」UI 走查**。

## 残留物

- `~/b21-test`(scratch 目录)+ 会话「B21 BYOK 验证」(引擎 DB)——无害,可随时删。
- vault 内为用户真 key(ee03),**保留为可用状态**(用户提供即为启用)。
