# S36 — REQ-077 Windows 正式构建通道(CI windows runner 出含原生件包)

> 开批:2026-07-09(用户「处理 req-077」;REQ-077 ready → in-sprint)
> 需求档:[requirements/REQ-077](../../requirements/REQ-077-windows-build-channel.md);上游约束证据 = S35 残单
> WIP 检查:S35 已收尾(PR #166 merged),无在批 sprint。

## 目标

`.github/workflows/alpha-windows-build.yml`(alpha 自有新增,GitHub 托管 `windows-latest`,
`workflow_dispatch` 手动触发):bun install(win32 optionalDeps 原生装齐)→ `ship:windows` →
**win32 原生件断言**(pwsh,缺即红)→ artifact 上传。合并后实跑一次作验收①②实证。

## 任务表

| # | 任务 | 状态 |
|---|---|---|
| T1 | workflow 文件(runner/缓存/REQ-027 flag 序/原生件断言/artifact;签名自跳与不 publish 注记) | ✅ |
| T2 | 机制核查:上游 sign-windows.ps1 无密钥优雅自跳(无需加闸);bun 自动跑 pre 脚本(实测,无需显式 prebuild 步) | ✅ |
| T3 | PR 合并后 `gh workflow run` 实跑:断言步过 + artifact 产出(验收①②) | ☐(合并后执行,run URL 回填于此) |
| 收口 | BACKLOG 回写 shipped + 四件套 | ☐ |

## Gates

1. alpha-check 绿(workflow 是纯新增 yml,代码零改动 —— 北极星守卫/typecheck/测试不受影响)。
2. 实跑一次全绿:断言步 PASS + artifact 可下载(验收①②);**验收③(真机可装)随 REQ-076 真机批**,
   本批不承诺。
3. 不踩已知坑:runner 用 GitHub 托管池(非 Blacksmith);`bun run --cwd X Y` flag 序(REQ-027);
   无 GH_TOKEN 不 publish。

## 结果(收口回填)

- (T3 后回填 run URL 与断言结果)

## 回写清单

- [ ] BACKLOG:REQ-077 in-sprint → shipped(PR 号)+ 实跑 run 注记
- [ ] 本文件 T3/收口勾选 + 结果回填
- [ ] CHANGELOG:并入 REQ-076 Windows 条目补一句(正式包通道就位)
- [ ] requirements/REQ-077 frontmatter status 同步
