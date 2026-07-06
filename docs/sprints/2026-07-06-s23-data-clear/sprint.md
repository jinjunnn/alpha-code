# Sprint 2026-07-06 S23 —— C16 数据清除入口 + E2/E6 国产/数据库 MCP 条目

> **抽取(2026-07-06,S22 收批后顺承)**:P0 空、发布短名单余项均为 verified-pending 或 parked(B16 待用户拍板)→ 按 ADR-018 抽 ready 池**可离线交付**项:**C16(headline,P2 debt/security)** + **E2/E6(顺带,同为定制中心供给域,R3 已解锁)**。用户上轮点名的 B22 复现 / D5 内核实测 / REQ-005 真机核验均需真机 → 攒下一真机批,不抽。WIP=1 满足(S22 已收尾,PR #119)。
> **顺带登记**:REQ-045(S22 撤条目的远程补货,仓 C,registered)——上轮收口检查发现的唯一漏登记意图。
> **纪律**:零改上游;清除引擎 electron-free 可单测;破坏性动作前必过原生确认 + 先备份提示(B14 同屏);排除/跳过必留痕(B11 反静默);E2/E6 以**官方源核实**为上架门,核实不过=诚实不加、阻塞写回 BACKLOG。

## Task 表

| # | 项 | 验收 | 状态 |
|---|---|---|---|
| T1 | REQ-045 登记(BACKLOG 行 + 需求档 + 计数器 bump REQ-046) | 行/档/计数器三处一致 | ✅ |
| T2 | C16 清除引擎(main,electron-free 核心):残留清单枚举(分级:凭证 / 全部)+ 体积统计 + 清除执行(fail-closed,逐项结果留痕 main.log) | 单测:分级清单正确;不越出白名单根;symlink 不跟随;失败不静默 | ✅(data-clear.ts,13 单测) |
| T3 | C16 入口:「数据」菜单(B14 同屏)加「清除数据…」→ 原生对话框分级选择 + 先备份提示 + 二次确认;清除后凭证级=登出态生效,全部级=引擎停后清+退出 | 菜单可达;确认文案如实(列将删内容+体积);清除后 du 复核逻辑在册 | ✅(data-clear-boot.ts;全部级仅打包态,B14 同款理由) |
| T4 | C16 卸载指引:docs/UNINSTALL.md 残留路径全清单(userData / ~/.alpha / ~/.opencode 桥 / 钥匙串项)+ 与 app 内清除的关系;DISTRIBUTION 索引 | 路径清单与引擎白名单同源一致 | ✅(菜单加「卸载与数据残留说明」直达;dmg 内嵌指引未做,随下次真实发版评估) |
| T5 | E2 钉钉 MCP + E6 数据库 MCP catalog 条目(钉版本、license、requiredEnvVars {file:} 化、install-only 不进预设、runtimeDep 预检) | 包名/版本/license 经 npm 正源核实在册;核实不过=该条不加、阻塞写回 BACKLOG | ✅(E2=dingtalk-mcp@1.1.21,官方 org 发布但源码不可审计→_verify 载供应链警示;E6=@bytebase/dbhub@0.12.0 钉「最后支持 --readonly CLI」版,DSN 走 env;+ alpha-catalog.test.ts 完整性回归锁 6 例) |
| T6 | 回写:BACKLOG C16/E2/E6 翻 shipped(+PR)· sprint.md 勾选 · CHANGELOG [Unreleased] · C16 需求档 frontmatter 同步 | 四件套齐 | ✅(PR #120) |
| T7 | **(追加,用户质询挖出)** C 侧 catalog-src 同步:撤 REQ-044 半边漏撤的三条目 + 空壳 bundle:design;上架 E2/E6(两侧逐字一致);build+ed25519 重签 | C 发布产物 23 entries、撤下条目零残留;合并后 deploy 生效 | ✅(alpha-web PR #7;deploy 随其 merge) |
| T8 | **(追加)** REQ-046 登记:catalog 双作者源无同步守卫(两次漂移实证);计数器 bump REQ-047 | 行/档/计数器三处一致 | ✅ |

## Gates
- 北极星守卫 + typecheck + 单测全绿(`scripts/alpha-check.sh`);
- ship gate:PR → alpha-ci 四关 → merge → 删分支;**同场再附 B16 PIPL go/no-go 决策请求**(S21/S22 两轮遗留,仍待用户拍板);
- 真机递延:清除对话框/登出态/重启后首启像素 + E2/E6 安装预检走查 → 下一真机批(C16/E2/E6 verified 门)。

## 明确不做
- 不做卸载 hook/系统级 uninstaller(macOS 无标准通道;文档 + app 内清除已覆盖验收);
- 不自动删钥匙串项(safeStorage 密钥项由系统管理,加密文件删除后该项无泄密面 → 文档说明手动删除法);
- 不碰用户项目内 `.alpha/`(ADR-019 §4:项目产物属用户项目,卸载指引只列出、不代删);
- E2/E6 不进 `injectAlphaConfig` 出厂预设(与 E14 playwright 同策略:仅定制中心可装)。

## 结果(2026-07-06 回填)

**C16 + E2/E6 全落(A 侧 PR #120,C 侧 alpha-web PR #7)= shipped**:
- **C16**:逻辑核 `main/data-clear.ts`(electron-free,manifest 单一真源 = UNINSTALL.md 派生源;lstat 不跟 symlink、执行前 realpath 复核守卫根、TOCTOU 链换实体拒删、shared 项 opt-in、单项失败不中断且逐项留痕 `[c16-data-clear]`)+ 接线层 `data-clear-boot.ts`(分级对话框;凭证级=clearByok→撤密钥 env→删文件→logout,防 respawn syncSecretFiles 复活残件;全部级=仅打包态,先备份提示→红色终确认+共享面 checkbox→停引擎→清→退出)+ 菜单同屏(B14 验收④)。13 单测。
- **E2/E6**:双侧上架(A 内置=离线底座、C catalog-src=联网生效)。E2=dingtalk-mcp@1.1.21(供应链警示如实入 _verify);E6=@bytebase/dbhub@0.12.0 --readonly(版本钉选理由入 _verify;DSN 走 env {file:})。+ `alpha-catalog.test.ts` 完整性回归锁(id 唯一/bundle 零悬空/npx·uvx 钉版本/REQ-044 撤下条目不回流/dbhub --readonly 在场)。
- **T7(用户质询挖出的真漂移)**:REQ-044 撤架只撤了 A 内置半边——A 侧远端整份替换内置,联网用户仍在看 C 下发的三条恒失败条目;C 侧 catalog-src 撤架 + E2/E6 上架 + ed25519 重签随 alpha-web PR #7,合并后 deploy 生效。根因(catalog 双作者源无同步守卫)登记 [[REQ-046]](P1,流程拍板留用户)。
- **登记**:REQ-045(撤下条目远程补货,C,P3)+ REQ-046(双作者源守卫,X,P1);计数器 → REQ-047。

**gates**:北极星守卫 ✓ typecheck ✓ 单测全绿(455 + 19 新增);alpha-ci 四关随 PR。

**verified 门(真机递延)**:清除对话框实拍/凭证级登出态/全部级 du 复核 + E2/E6 hub 安装与首调用(dbhub 写拒绝走查)→ 下一真机批。

**待用户拍板**:① B16 PIPL go/no-go(S21/S22/S23 三轮遗留);② REQ-046 流程方案(单一作者源 vs 双写+CI 守卫);③ alpha-web PR #7 合并后需跑 `deploy/deploy.sh` 生效(C 侧 prod 动作)。
