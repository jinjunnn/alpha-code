import { expect, test } from "bun:test"
import { join } from "node:path"

// #1507 票面 ①-A 的 35 坐标;重复的同一文案按实际出现次数核对。`#1556` 删掉随包 `platformProvider.pico` 后,其中 alpha-models.json 的 `"letter": "C"` 一格随之消失。
const copy = [
  ["packages/ui-mac/src/renderer/alpha-ui/Banner.tsx", "title=\"Code Puppy platform contract is incompatible\"", 1],
  ["packages/ui-mac/src/main/alpha-models.json", "\"name\": \"Code Puppy\",", 1],
  ["packages/ui-mac/src/main/data-clear-boot.ts", "\"Code Puppy 自有配置中指向已清除数据的悬空连接器/插件引用会一并清理。\\n\" +", 1],
  ["packages/ui-mac/src/main/ext-ipc.ts", "message: \"此项目自带 Claude Code / .agents 生态内容,导入为本项目的 Code Puppy 扩展?\",", 1],
  ["packages/ui-mac/src/main/alpha-builtin-policy.ts", "v.push({ kind: \"agent\", name: n, reason: `受保护:${n} 是 Code Puppy 注入的功能载体(自动化等),禁用会使其静默失效,已拒绝` })", 1],
  ["packages/ui-mac/src/main/alpha-builtin-policy.ts", "v.push({ kind: \"agent\", name: n, reason: `受保护:${n} 是 Code Puppy 注入的功能载体,隐藏会使其入口消失,已拒绝` })", 1],
  ["packages/ui-mac/src/main/alpha-builtin-policy.ts", "const successor = n === \"customize-opencode\" ? `定制 Code Puppy 请改用 /customize-code-puppy(Code Puppy 自带的定制指南技能)。` : \"\"", 1],
  ["packages/ui-mac/src/main/alpha-builtin-policy.ts", "edits.push({ path: [\"command\", n, \"description\"], value: `(已禁用)该技能已在 Code Puppy 治理中禁用` })", 1],
  ["packages/ui-mac/src/main/alpha-builtin-policy.ts", "edits.push({ path: [\"command\", n, \"template\"], value: `该技能(${n})已在 Code Puppy 的治理设置中被禁用。请告知用户:此技能不可用;如需恢复,到 定制中心 → 已安装 → 内置(上游) 解除禁用。${successor}不要尝试其它方式执行该技能。` })", 1],
  ["packages/ext/src/context-injection.ts", "export const FACTORY_DENY_COMMAND_DESCRIPTION = \"(已弃用)请使用 /customize-code-puppy\"", 1],
  ["packages/ext/src/context-injection.ts", "\"该技能({name})已弃用。定制 Code Puppy 请改用 /customize-code-puppy。\"", 1],
  ["packages/ui-mac/src/main/ext-fs-installer.ts", "if (!dir) return { ok: false, reason: \"refused: path escapes Code Puppy root\" }", 2],
  ["packages/ui-mac/src/main/ext-fs-installer.ts", "if (!destDir) return { ok: false, reason: \"refused: path escapes Code Puppy root\" }", 3],
  ["packages/ui-mac/src/main/ext-fs-installer.ts", "if (!candidate) return { ok: false, reason: \"refused: path escapes Code Puppy root\" }", 1],
  ["packages/ui-mac/src/main/ext-install-planner.ts", "return { ok: false, reason: \"{alphaResources} is reserved for the bundled Code Puppy Office server entrypoints — refused\" }", 1],
  ["packages/ui-mac/src/main/ext-install-planner.ts", "reason: `entry ${entry.id} installs an engine plugin — Code Puppy no longer installs executable plugins into the engine (ADR-040); refusing`,", 1],
  ["packages/ui-mac/src/main/ext-install-planner.ts", "reason: `asset ${asset.id} is an engine plugin — Code Puppy no longer installs executable plugins into the engine (ADR-040); refusing`,", 1],
  ["packages/ui-mac/src/main/ext-mcp-policy.ts", "if (!connector) return { ok: false, reason: \"unknown Code Puppy Office connector mode (REQ-133 fail-closed)\" }", 1],
  // #1564 AC1:写策略不再比对目录卡片的命令,这一句拒绝随之消失(0 次 = 它不会再出现在用户面前)。
  ["packages/ui-mac/src/main/ext-mcp-policy.ts", "return { ok: false, reason: `${connector.name} command differs from the pinned Code Puppy stdio command (REQ-133)` }", 0],
  ["packages/ui-mac/src/main/ext-mcp-policy.ts", "return { ok: false, reason: `${connector.name} bundled server escaped Code Puppy resources (REQ-133)` }", 1],
  ["packages/ui-mac/src/main/package-admission.ts", "reason: `package admission: component \"${component.id}\" installs an engine plugin — Code Puppy no longer installs executable plugins into the engine (ADR-040); refusing the whole package`,", 1],
  ["packages/ui-mac/src/main/package-admission.ts", "reason: `component \"${component.accepted.component.id}\" installs an engine plugin — Code Puppy no longer installs executable plugins into the engine (ADR-040); refusing`,", 1],
  ["packages/ui-mac/src/shared/office-advisories.ts", "return { ok: false, reason: `${connector.name} requires the workspace marker or absolute managed workspace plus an absolute Code Puppy resource root (REQ-134)` }", 1],
  ["packages/ext/src/plugin.ts", "return { title: \"alpha_register\", output: \"refused: project Code Puppy root identity drifted\", metadata: { ok: false } }", 1],
  ["packages/ext/src/cloud-websearch-kill.ts", "return cloudWebSearchDenied(env) ? \"the Code Puppy web search kill switch (ADR-009 B2) is set\" : undefined", 1],
  ["packages/ext/src/cloud-websearch-kill.ts", "\"the Code Puppy web search kill switch (ADR-009 B2) is set; it turns off Code Puppy's own web search tools \" +", 1],
  ["packages/ui-mac/src/main/alpha-workdir.ts", "return { status: \"retired-home\", reason: \"project Code Puppy root is related to the retired global root\" }", 1],
  ["packages/ui-mac/src/main/alpha-workdir.ts", "return { status: \"unknown\", reason: \"project Code Puppy endpoint is not a real directory\" }", 1],
  ["packages/ui-mac/src/main/alpha-workdir.ts", "return { status: \"unknown\", reason: \"project Code Puppy endpoint is a canonical alias\" }", 1],
  ["packages/ui-mac/src/main/alpha-workdir.ts", "return { status: \"unknown\", reason: \"project Code Puppy root identity cannot be confirmed\" }", 1],
  ["packages/ui-mac/src/main/ext-project-entry.ts", "return { ok: false, reason: \"fail closed: project Code Puppy root identity drifted\" }", 1],
] as const

test.each(copy)("#1507 AC1:①-A 显示文案 %s / %s", async (file, value, count) => {
  const source = await Bun.file(join(import.meta.dir, "../../../..", file)).text()
  expect(source.split("\n").filter((line) => line.trim() === value)).toHaveLength(count)
})
