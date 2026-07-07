---
id: REQ-058
title: sidecar 惰性 cwd — 消除启动期 home Instance 的单次 watcher
type: perf
priority: P3
repo: A
created: 2026-07-07
sprint: —
source: B4 verified 复核时排查发现(2026-07-07)
---

## 背景/证据
B4(巨型目录当项目治理)数据层过滤已把 `/`、home 从**项目列表**剔除、hidden 项目零请求(S20 verified 半边)。但 2026-07-07 复核 B4 验收句③(「冷启动 bootstrap 日志无 `~` 级 Instance」)时,真机 + 代码排查发现**仍有一个 home Instance**在启动期被创建:

- **发起链**:renderer 挂载 → `sidebar/use-projects.ts` 的 `loadProjects()` 调 `c.project.list()`(**无 directory 参数**)→ 上游把 `project.list` 归进 `InstanceContextMiddleware` group(`server/routes/instance/httpapi/groups/project.ts:83`)→ 缺省 directory 回退 `process.cwd()`(`middleware/workspace-routing.ts:87`)→ `InstanceStore.load({directory: home})` 建实例 + bootstrap(vcs/snapshot/project 的 fs-events watcher)。
- **为何落 home**:alpha 主进程开机 `process.chdir(homedir())`(`main/index.ts:180`,ripgrep 兼容)+ sidecar fork 继承 cwd(`main/server.ts:164` `cwd: process.cwd()`)→ 引擎 `process.cwd()` 被钉成 `/Users/<name>`。
- **性质**:**单次、有界**(InstanceStore 按 directory 缓存,启动期所有无-directory 请求 coalesce 到同一 home 项,只建一次;非 REQ-053 那种循环)。数据层过滤在结构上拦不到它——过滤是对 `project.list` **响应**做的,而这个 Instance 在**请求路由阶段**(无 directory → cwd)就已创建,上游于过滤点。

## 与 B4 的关系(边界澄清)
B4 治理的是「巨型目录当**项目**→ 无界多 watcher 内存问题」,已达成(侧栏只渲染真实项目、home/`/` 不入列、hidden 零请求)。**本项是更窄的另一问题**:引擎默认-directory 回退产生的**单个** home watcher,与「项目」无关。B4 验收句③字面被此单次 Instance 触碰,故 B4 保持 shipped(不因此单项判 verified),该残留移出 B4、独立为本 REQ 跟踪。

## 验收标准
1. 启动期引擎不再对 home(`/Users/<name>`)建 Instance + 递归 watcher(bootstrap 日志无 home 级 `creating instance`);
2. ripgrep/工具执行行为不回归(工具用 session 的 directory,不是 sidecar cwd);
3. 零改上游源码(只调 alpha 侧 sidecar fork 的 cwd)。

## 候选修法(排查推荐,低风险)
- `main/server.ts:164` `cwd: process.cwd()` → 指向 userData 下一个专用**空** scratch 目录 → 无-directory 回退 Instance 落在惰性空目录(bootstrap 极快、watcher 平凡),而非整个 home 树。
- **注意**:`main/index.ts:180` 的 `chdir(home)` 是给**主进程** ripgrep 用的,与 sidecar cwd 解耦后互不影响 —— 但落地前须真机实测确认 ripgrep + 工具执行不回归(故本项需独立验证周期,不在 verify batch 内顺手改)。
- **不可**简单「不 chdir」让 cwd 退回 `/` —— 回退 Instance 会落 `/`(watcher 面更大,更糟)。

## 非目标
- 不 patch 上游把 `project.list` 移出 `InstanceContextMiddleware`(改上游契约,破北极星);
- 不追求「零 Instance」——单次惰性空目录 Instance 可接受,只求它不挂 home 树 watcher。
