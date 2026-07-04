# S13 T6 视觉核验(导入 folder/git/npm)

> 2026-07-04 · 隔离实例(OPENCODE_TEST_ONBOARDING,alpha 根/桥全在临时目录)· 真 IPC 端到端 + CDP。

| 断言 | 结果 |
|---|---|
| 合法文件夹导入:SKILL.md frontmatter 校验 → 复制入 .alpha/skills/imported-demo + 桥 + receipt(origin=imported)→ 已安装列表出现 | ✅ t6-01(IPC 返回 files/name 断言) |
| **非法 frontmatter 拒绝**(name=`../escape`):`非法 frontmatter:name 缺失或不合法` | ✅(验收③拒绝路径) |
| 重复导入拒绝:`同名技能已存在,请先卸载再导入` | ✅ |
| Git 弹窗非 https 地址 → **弹窗内行内红字**「仅支持 https Git 地址」,零裸 toast(B11) | ✅ t6-02 |
| Git 真克隆 happy-path:与 folder 共享校验/复制管线;真网络克隆留 T8 真机批(不在 CI 环境拉外网仓库) | ⏳ 如实递延 |
| npm 导入 = persistPlugin 通道(包名白名单在主进程,幂等去重),弹窗带插件风险行 | 代码路径复用,10 条纯函数单测绿 |
| symlink 不复制、.git/node_modules 跳过、10MB/500 文件帽、复制失败半成品回滚 | 实现纪律(collectImportFiles),防逃逸单测覆盖 name 面 |
