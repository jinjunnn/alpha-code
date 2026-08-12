// #926/#929 tabs 预清契约类型 —— **唯一定义点**,零 import(main 可安全依赖)。
//
// 为什么单独一个 shared 文件:与上游 Tab 类型的比对(renderer/tabs-preclean-contract.ts)必须
// import "@opencode-ai/app",而任何从 src/main 出发、哪怕 type-only 的传递依赖都会让上游
// app.d.ts 的极简 `Window.api` 全局声明抢先进 program,压过 env.d.ts 的 ElectronAPI ⇒
// renderer 379 处 window.api 假红(2026-08-11 两次实测,含本票审计修复轮)。所以:
//   定义在这里(无上游 import,main/renderer 都能安全 import type);
//   与上游的比对在 renderer 侧比对文件(见其抬头的反孤儿锚说明)。
//
// 判据派生(#929 Major):main/tabs-preclean.ts 的 SESSION_CHECKS / DRAFT_CHECKS 以这两个类型的
// 键集为形状(`-?` 全键必填)。这里改键、那边的 Record 缺键/多键当场 typecheck 红 ——
// 「上游漂了,只改契约文件、不改真正删数据的谓词」这条最省力的绿被结构上封死。

/** tier-1 要求的 session tab 形状(= 现行上游 SessionTab;字段级判据 = SESSION_CHECKS)。 */
export type SessionTabContract = { type: "session"; server: string; sessionId: string }
/** 现行上游 DraftTab 形状(tier-1 只要求 draftID;其余键仅作漂移绊线,见 DRAFT_CHECKS)。 */
export type DraftTabContract = { type: "draft"; draftID: string; server: string; directory: string; worktree?: string }
