---
id: B12
title: Instance 不驱逐 + 递归 watcher 常驻(alpha 侧杠杆)
type: perf
priority: P1
status: shipped
repo: A
created: 2026-07-03
sprint: 2026-07-05-s17-deep-decisions
source: 册 §6.2 / R2(上游归属)
---

## 背景/证据
上游 `instance-store.ts:43` Map 无 TTL/LRU;每 Instance 一个递归 fs-events watcher 永不解绑 → 运行时内存增长头号来源。**上游归属(R2),本体不可改**;alpha 杠杆:① `ui-mac/src/main/server.ts:58` 停止强开 `OPENCODE_EXPERIMENTAL_FILEWATCHER`(评估功能代价);② 配合 B4 垃圾项目治理减少 Instance 数。

## 验收标准
1. `OPENCODE_EXPERIMENTAL_FILEWATCHER` 强开评估:关掉后功能影响清单(文件树/diff 刷新等),决策落文档;
2. 采取杠杆后:常驻 watcher 数与长时运行内存增长实测下降;
3. 明确记录「上游本体接受」结论(不排改上游任务)。

## 关联
B4(前置)、C5(同缓解路径)、NON_GOALS#3。

## 拍板与实施记录(2026-07-05,S17 T5 shipped)
- **影响清单(验收①,代码实证)**:实验 watcher 只供「外部变更感知」——外部编辑器改文件 → 文件树/已开文件自动刷新(frozen `app/context/file/watcher.ts` 消费 `file.watcher.updated`);外部 `git checkout` → 分支显示刷新(`opencode/src/project/vcs.ts:319` 监听 HEAD)。**agent 自己写/改的文件不受影响**(`tool/write.ts:69` 等工具主动 publish 事件)。另实证:`preferAppEnv` 原为 `Object.assign` 硬覆盖 → 用户 `export ...=false` 关不掉(与「真 export 赢」注释矛盾)。
- **拍板(用户,2026-07-05)= 默认开 + 可关**:两个实验 flag(FILEWATCHER/ICON_DISCOVERY)改 set-if-unset(`server.ts preferAppEnv`)——默认行为不变,`export OPENCODE_EXPERIMENTAL_FILEWATCHER=false` 即关(逃生门,硬覆盖矛盾修复);watcher 内存压力主治 = B4 数据层减 Instance(每个被剔项目少一个递归 watcher)。
- **上游本体接受(验收③)**:`instance-store.ts` 无 TTL/LRU 属上游归属(R2),不排改上游任务;若上游引入驱逐机制,sync 时受益。
- **verified 待**(验收②):长时运行内存增长与常驻 watcher 数实测下降 → 真机批。
