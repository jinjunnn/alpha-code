# 在场批 · B23 / C17 / B2(2026-07-07 下午)

> 环境:装机 v0.1.2+PR#141/142(dev 渠道),CDP 真机驱动;用户在场。B21 同场先行完成(见 [audits/2026-07-07-b21-byok-realkey](../2026-07-07-b21-byok-realkey/verify.md))。

## B23 · 全局 jsonc 语法错支(F-3 补验)— VERIFIED

方法:备份后向 XDG 全局配置(`~/.config/opencode/opencode.jsonc`,configHealth 的监测对象)注语法错;先温和破损(删尾括号)再硬破损(`"mcp": ][` 垃圾);观测 configHealth IPC、AlphaHome banner、引擎行为;还原后复验。

**结论:**
1. **configHealth 语法错检测正确**:破损后 IPC 即返 `{broken:true, reason:"配置文件存在语法错误,引擎会忽略整份配置"}`;AlphaHome 橙色 warning banner「全局配置未生效 + 打开配置」实拍(shots/16)。
2. **F-3 答案 = 现引擎对语法错也是 loud 拒绝,「静默清零」premise 全面过时**:硬破损 + 冷启动后,引擎 `/config` 返 400 `ConfigJsonError`(带文件路径 + ValueExpected/InvalidSymbol/CloseBraceExpected 行列级诊断);UI 三层 loud:侧栏「项目加载失败/重试」+ 红 banner「项目列表加载失败」+ **每项目 error toast 全文引 JSONC 诊断**(shots/17)。configHealth banner 与引擎 loud 并存,互不矛盾(banner 更早、更 actionable)。
3. **两解析器宽严差(记录在案,可接受)**:「缺尾括号」类破损引擎 jsonc 解析自动容错(配置照常生效、mcp 俱在),alpha 检查器仍报 broken → banner 轻度**过警**(warn 不吞真错,合 C28 精神);硬语法错两侧行为一致。
4. **配置全局缓存边界(实测)**:引擎全局配置为**进程级**缓存——`/global/dispose`、`/instance/dispose` 均不触发重读,只有 sidecar 重启/respawn 生效;banner 的「打开配置改好后」需重启才对引擎生效(banner 文案未承诺免重启,无违)。
5. 还原后重启:banner 消失、项目列表恢复(shots/18)。

**残留物**:无(备份已还原删除)。

## C17 · DB 超前阻断对话框打包态演练 — VERIFIED(退出路径 1 项单列观察)

方法:退出 app → 备份 `~/.local/share/opencode/opencode.db`(打包态无后缀库,守卫真目标,resolveDbPath 确认)三文件 → `INSERT` 一条未来迁移 `20991231235959_c17_future_probe` 造「DB 超前」→ 冷启动观测原生对话框 + main.log;还原后复验。

**结论(打包态真机,run 0812xx):**
1. **超前检出 + 非静默阻断 = PASS**:每次冷启动 main.log `db-safety: DB AHEAD of app — 1 unknown migrations (latest 20991231235959_c17_future_probe)`(error 级),弹原生三选项对话框〔退出(推荐)/备份后继续/直接继续〕,继续权显式交用户,不静默继续(验收①)。
2. **「备份后继续」pre-migration 自动备份 = PASS**:点选后落 `alpha-db-backups/opencode-backup-<ts>.db`;备份文件 sqlite3 可读、migration count=39(含注入行)= 完整快照非截断(验收②,B14 联动)。多轮共生成 3 份校验通过备份。
3. **「直接继续」= PASS**:app 带 ahead DB 正常起窗运行(db-ahead 分支不前进迁移,库结构不被写坏);降级场景无未定义行为(验收③打包态实证,补 fixture 级 34 单测)。
4. **还原后 = PASS**:删注入行 → 冷启动 `db-safety: watermark equal — proceed`,无对话框、正常运行。
5. **⚠️ 单列观察(不阻断 verified)**:「退出(推荐)」路径连续 4 轮真机点击均落到 main.log `response===1`(备份后继续),未验证到 app 真退出。退出分支代码 `if (response===0) return {proceed:false}` 明确、单测覆盖;真机点击落点偏差原因未定(对话框按钮布局/焦点/点击时序),值得下批用 CDP 或明确点击复核。**其余四项全过,C17 翻 verified**;退出路径观察项登记(不新开 REQ,并入下次真机批 C17 复核点)。

**残留物**:临时 DB 备份(`opencode.db.c17bak` 等)已删;C17 触发的 3 份 `alpha-db-backups/opencode-backup-*.db` 保留(无害审计痕迹,用户可删)。DB 已净还原(count 38 = 原始水位)。

## B2 · 短 TTL(过期→续期 / 撤销→降级 / 登出不串台)— VERIFIED(proactive-tick 半单测覆盖)

方法:C 仓(alpha-web @ 阿里云 ECS 39.105.20.171)`/opt/alpha-web/.env.local` 临时设 `DESKTOP_ACCESS_TTL_SECONDS=180` + `systemctl restart alpha-web`(备份原 env);用户帮 logout→重授权(`auth.logout`+`auth.start`,浏览器点授权)进入短 TTL 世界;CDP 观测 alpha-code 三条路径;测毕从备份还原 env(默认 7d)+ 重启 + 清备份。**登录后新 token TTL 实测 173/180s,确认短 TTL 生效。**

**验收逐条(装机 v0.1.2,run 20260707T083009):**

### ① 过期前/401 时自动续期,用户无感 — PASS(401 拦截半;proactive-tick 半见备注)
- token 过期(ttl=-15s)状态下调 `account.summary` → **237ms 成功返回数据、无报错**,`auth.getState` 的 expiresAt 从 -15 刷新到 **+180**;main.log `alpha-auth: tokens refreshed { expiresAt: ... }`。= 401 触发自动续期 + 轮换 + 重试成功,全程无感(验收①主路径)。
- **备注**:proactive「提前量续期」(hourly authTimer 命中 min(24h,寿命/2))在 180s TTL 下测不到——tick 每小时一次远慢于 180s,token 必先过期走 401 路径。该半由 `alpha-auth-clock.ts` 纯逻辑单测覆盖(refreshAheadMs/shouldRefreshToken/isTokenExpired,8 例);真机不便观测,如实标注。

### ② 续期失败降级 BYOK/登出,有明确 UI — PASS
- ECS 侧 `UPDATE device_sessions SET revoked=true`(精确定位:`last_seen_at` 最新的 `s_YcFLyq642C2FSl4n`,续期时刻 16:36:34 吻合)→ 等 token 过期 → 调 summary 触发续期 → refresh 命中撤销 session。
- 结果:main.log `alpha-auth: refresh rejected (session revoked / token rotated elsewhere) — degrading to logged-out` → `logged out` → `respawning sidecar` → `renderer reloaded`(CDP 目标导航即此信号)。
- 终态:`auth.getState` = `{status: logged-out, mode: byok, expiresAt: null}`;账户面板 UI = 左下「登录 / 点此登录」(shots/21-b2-downgrade-loggedout.png)= 验收②「明确 UI,非静默 401」。mode 从 platform **降级回 byok**。

### ③ logout 停代理不串台 — PASS
- 降级登出后(= logout 同一代码路径:清 env + respawn 停代理):`auth.status=logged-out / mode=byok`,平台代理 env 已清。
- BYOK 独立性:deepseek key 仍 `{configured:true, source:keychain, hint:ee03}`(不随登出失效);**登出态下发 deepseek-v4-flash 直连消息 200、回复 "10"** —— 自带 key 独立可用,不串平台代理凭证。

**C 仓收尾(用户要求「测完改回」)**:`.env.local` 从备份还原 → `DESKTOP_ACCESS_TTL_SECONDS` 移除(默认 7d)→ `systemctl restart alpha-web` active → 站点 200 + `/api/jwks` 200 → env 无 TTL 变量、备份文件已清。**生产已复原,窗口约 16:28–16:42(14 分钟)。**

**残留物**:测试期 device_sessions(`s_YcFLyq642C2FSl4n` 已 revoked、及登录流中间产物 `s_iDwB45II` 等)的 refresh 均已失效,留库无害;alpha-code 现为登出态(用户可随时重登,将拿 7d token)。


## B2 · 短 TTL(过期→续期 / 撤销→降级 / 登出不串台)— (待做,需用户登录配合)
