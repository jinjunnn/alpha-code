# REQ-083 真机验证 — 模型选择框 respawn 竞态修复(2026-07-10,S39)

> 环境:dev 构建(vite 5173 非陈旧 bundle,`location.href` 已核)+ dev 渠道 userData(真实登录态 PRO + 已配置 deepseek/zhipuai 双 Key)。驱动 = CDP 9222(dev 默认开),脚本断言 + 截图双证。

## 根因复盘(报障当日日志定案)

用户报障(v0.1.2 打包真机,10:37–10:42):已配置 Key 的 DeepSeek/智谱在选择框整体消失;登录 PRO 后代理模型全灰。日志证据链:

1. 5 分钟内 5 次 sidecar respawn(存 Key ×2 / 登出 / 登录 / 点灰行 ×N —— `enableProxy` 无条件 respawn),每次对应 renderer 一波 `Failed to fetch`(main.log + renderer.log 时间戳逐一对齐);
2. ModelPickPop 弹窗打开只拉一次 `config.providers` 且 `.catch(()=>{})` 静默吞 → engineModels 空 → ① configured BYOK 两头落空(不进「需 KEY」区、又无模型行)= 整体不可见;② `proxyLive()` 假 → 代理 13 行全 locked;账户横幅走 main IPC 不受影响,仍显示「PRO 会员」= 矛盾画面;
3. member/balance 态点 locked 行无条件 `window.api.auth.enableProxy()` → 又一次 respawn + renderer reload = **自续循环**(10:42:38.441 上一次 respawn 完成的同一毫秒排入下一次,实锤)。

**排除项(实证)**:非端点域名切换(`alpha-gateway.tidelabs.click` HTTP 200、`ALPHA_BASE_URL` 正确、白名单同步 `byok: unrestricted`);非数据丢失(干净重启后 CDP 直查引擎:deepseek 4 模型 / zhipuai 13 模型 / alpha 13 模型全在,弹窗渲染全对)。

## 修复(三点)

1. **取数诚实 + 自愈**:load 状态机(`engineReady`/`engineStalled`)+ 退避重试(1s/2s/4s/8s 封顶,弹窗存活期间持续;sdk 未就绪同样可重试);非 ok 态顶置「正在连接引擎…」note + configured BYOK 占位行(`已配置 · 模型加载中…`,disabled)。健康路径首拉 ~ms 级不闪占位(stalled 门)。
2. **点灰行不再火上浇油**:`lockedPickAction` 纯函数(login/recharge/activate/none)——仅「引擎在线(engineReady)且代理节点确实缺席(!proxyLive)」才 activate;引擎不可达一律 none。`enableProxy` 唯一调用点即此,main 侧无需改动。
3. **respawn 后自动恢复**:重试循环覆盖(弹窗不重开就地补全);key 保存后 3s 补拉保留(失败进同一重试循环)。

## 断言结果(scripts: scratchpad/verify-req083.ts,全 PASS)

| # | 场景 | 断言 | 结果 |
|---|---|---|---|
| 0 | 基线(引擎健康) | 弹窗 30 行可选 0 locked,BYOK 模型行 19(deepseek+glm),无 note | PASS(01-baseline.png) |
| 1 | 拦截 `/config/providers`(staging 复现 Failed to fetch) | note 出现 + DeepSeek/智谱占位行 ×2 + 代理 13 行 locked | PASS(02-outage-honest-state.png) |
| 2 | 故障态点 locked 代理行 ×1 | 页面未 reload(marker 存活)、弹窗仍开、**零 respawn** | PASS |
| 3 | 解除拦截 | **同一弹窗不重开**自动恢复:note 消失、BYOK 19 行回来、0 locked | PASS(03-self-healed-same-popup.png) |
| 4 | 真死服务器(`killSidecar`)重复 1+2 | 同 1/2 全过 | PASS(04-real-outage-honest-state.png) |
| 5 | `retrySidecar` 恢复 | respawn+reload(预期行为)后基线复核:0 locked / 19 BYOK / 无 note | PASS(05-restored-baseline.png) |

**日志复核**:整场验证 main.log 仅 1 次 `respawning sidecar (proxy activation)` = stage 5 主动恢复;stage 2/4 两次故障态点灰行 **零 respawn**(修复前每点一次触发一次)。

## Gates

- alpha-check 全绿(北极星守卫 + typecheck + 单测 673/673,新增 model-picker-logic 6 例)
- 零改上游文件(全部改动落 `packages/ui-mac` 自有文件)
- UI PR 用户亲验门:dev 已留可用态(登录 PRO + 双 BYOK),待用户 GO 后合并

---

## 2026-07-12 复验(用户委托真机验收)—— FAIL → 补丁 → 全绿

**复跑结果**:stage 0-4 全 PASS;**stage 5(retrySidecar 恢复)FAIL** —— 暴露第四种故障形态「悬挂」:
respawned 引擎无鉴权请求秒回 401(中间件活着),带鉴权 `/config/providers` **永不返回**(捕获请求挂起数分钟
无 resolve/reject;新发 6s 超时请求 TimeoutError)。原修复只覆盖 reject,未覆盖 hang → fetch 既不成功也不
失败 → 状态机进不了 stalled → 无 note 无占位、13 行全灰、BYOK 消失、不自愈(用户当场撞见并截图)。

**补丁(同日)**:
1. `model-picker-logic.ts` 新增 `ENGINE_FETCH_TIMEOUT_MS = 10_000` + 单测 2 例(超时 > 一切退避间隔;取值窗口);
2. `alpha-composer-model.tsx` 取数带 `AbortSignal.timeout` —— 悬挂转成可重试失败进既有重试循环,abort 同时
   关闭底层连接(防 Chromium 连接池复用死套接字);
3. 验收 harness 固化进仓 `packages/ui-mac/scripts/verify-picker-respawn.ts`(S39 复盘病灶 1):新增 **hang 注入
   阶段**(尊重 abort signal 的永不返回 fetch)+ 恢复阶段改**收敛轮询**(修 7-10 脚本定时快照把引擎暖机误判
   为回归的缺陷)+ 断言硬失败退出非零;
4. `scripts/engine-smoke.sh` + sync-upstream.yml 新步(S39 复盘病灶 2):每日 sync 后无头启动引擎 → 打
   `/config/providers` → 硬杀 → 同端口重启 → 再打,红 = 引擎运行时冒烟破(本地实跑绿)。

**复验(补丁后,harness 全量)**:14/14 断言 PASS —— 基线 30 可选/19 BYOK;reject 故障态诚实 + 点灰行零
respawn/reload + 同弹窗自愈;**hang 故障态超时后出诚实 note + 占位(修复盲区闭合)+ 解除后自愈**;真杀
sidecar 同全过;retrySidecar 恢复后收敛回满基线。证据:`docs/audits/2026-07-12-s39-req083-reverify/`(7 png)。

**残余(单独立项追踪,不阻断本 REQ)**:引擎 respawn 后悬挂为**非确定性竞态**(6 个 kill→retry 循环 1 现),
判决实验(僵死瞬间带鉴权外部 curl 分辨引擎僵死 vs renderer 连接池僵死)未能复现完成;UI 层超时补丁使其
用户面退化为「诚实提示 + 自动恢复」,不再是静默全灰。
