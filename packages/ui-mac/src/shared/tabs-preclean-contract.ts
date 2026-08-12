// #926/#929 tabs 预清契约类型 —— **唯一定义点**,零 import(main 可安全依赖)。
//
// 为什么单独一个 shared 文件:与上游 Tab 类型的比对(main/tabs-preclean-contract.ts)必须
// import "@opencode-ai/app";判据本身与那份比对分开,谓词就不会跟着上游的类型图一起漂。
// (历史:#926 时这条分离还兼职躲一个缺陷 —— 从 src/main 出发的传递依赖会让上游 app.d.ts 的
// 极简 `Window.api` 全局声明抢先进 program、压过 env.d.ts 的 ElectronAPI,renderer 数百条假红。
// #932 已把声明顺序钉死,比对文件也随之搬回 src/main;这里的分离只剩「单一定义点」这一个理由。)
//
// 判据派生(#929 Major):main/tabs-preclean.ts 的 SESSION_CHECKS / DRAFT_CHECKS 以这两个类型的
// 键集为形状(`-?` 全键必填)。这里改键、那边的 Record 缺键/多键当场 typecheck 红 ——
// 「上游漂了,只改契约文件、不改真正删数据的谓词」这条最省力的绿被结构上封死。

/** tier-1 要求的 session tab 形状(= 现行上游 SessionTab;字段级判据 = SESSION_CHECKS)。 */
export type SessionTabContract = { type: "session"; server: string; sessionId: string }
/** 现行上游 DraftTab 形状(tier-1 只要求 draftID;其余键仅作漂移绊线,见 DRAFT_CHECKS)。 */
export type DraftTabContract = { type: "draft"; draftID: string; server: string; directory: string; worktree?: string }
