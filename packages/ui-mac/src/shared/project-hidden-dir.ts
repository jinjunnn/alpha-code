// 项目隐藏目录名的唯一来源(REQ-236 `#1553` AC8;方案 docs/design/req236-results-and-attachments.md §2.6)。
// main 的 alpha-workdir.ts(解析器与身份复验)、ext 与 renderer 的附件路径都读它;零依赖,ext 经相对路径 import。
// 改名与按项目迁移归命名迁移票(owner 2026-10-30 裁决 `.code-puppy` → `.codepuppy`),本票只引入常量、值保持现名。
export const PROJECT_HIDDEN_DIR = ".code-puppy"
