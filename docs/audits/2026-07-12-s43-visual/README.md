# 2026-07-12 REQ-092/093 A 侧视觉验收(S43)

> 真机 dev 实例(CDP 9222)取证,对应 jinjunnn/alpha-code#184 / #185。

- `30-ipc-probe.png` + 探针返回:`window.api.runArtifacts = {list, inspect, usage, projectUsage}`
  只读面就位;`cloud.downloadArtifact`/`cancelArtifactDownload` 就位;**旧 base64 通道
  `cloud.fetchArtifact` 已不存在(undefined)**;`runArtifacts.list()` 对不存在 run 返回诚实空态
  `{ok:true, entries:[], legacyFiles:[], warnings:[]}`。
- `40-session-dark.png`:`prefers-color-scheme: dark` 模拟下 AlphaHome(REQ-085 surface)
  深色完整渲染 —— 同时补 REQ-085 AC#6 深色回归数据点。
- 端到端云下载真机演证依赖已部署平台提供新 content endpoint(平台代码已合并
  jinjunnn/alpha-platform#42,部署为运维动作);单元层已covering 三重限额/断流/取消/
  sha256 不符/token 卫生(34 项)+ compat 等价性。100 MiB 峰值 RSS 实测留待部署后
  live run(下载器为 O(chunk) 无全量缓冲设计)。
