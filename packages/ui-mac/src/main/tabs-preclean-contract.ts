// #926 漂移闸:main 侧 tabs 预清(src/main/tabs-preclean.ts)的 tier-1 形状判据,与上游
// packages/app(滚动 pin,ADR-034)的 Tab 类型绑成一条会红的判据 —— pin bump 改了 tab 形状而
// 判据没跟,ui-mac typecheck 当场红,而不是像 #926 的 dirBase64 那样悄悄漂成「专剔合法数据、
// 用户重启丢标签页」。全部 import type,编译期擦除,零运行时。
//
// 本文件 #926 起被迫寄放在 renderer:在 src/main 侧 import "@opencode-ai/app" 会翻转
// `Window.api` 的全局声明顺序,renderer 侧当场 379 条假红。#932 把那个顺序钉死之后
// (tsconfig 的 `files` 让 src/renderer/env.d.ts 恒定第一个进 program),这条限制没了,
// 判据搬回它守护的代码旁边。
//
// 反孤儿(#929 审计 Major):本文件曾是孤儿 —— 没人 import,删掉它 typecheck 与全量测试都不红,
// gate-files.tsv 又只收测试文件,结构上没有任何东西拦得住它消失。现在两条腿钉死:
//   ① 契约类型的唯一定义在 src/shared/tabs-preclean-contract.ts,main 的谓词从那里派生;
//   ② 本文件由 src/main/tabs-preclean.ts 的 type-only import 钉进 program —— 删掉本文件 =
//     那边 TS2307 当场红(绕过实验实测,见 PR #929 / #932)。

import type { useTabs } from "@opencode-ai/app"
import type { ElectronAPI } from "../preload/types"
import type { DraftTabContract, SessionTabContract } from "../shared/tabs-preclean-contract"

type UpstreamTab = ReturnType<typeof useTabs>["store"][number]
type UpstreamSessionTab = Extract<UpstreamTab, { type: "session" }>
type UpstreamDraftTab = Extract<UpstreamTab, { type: "draft" }>
type Assert<T extends true> = T
type IsNever<T> = [T] extends [never] ? true : false
type KeysExact<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never] ? true : false

// 防空转:上游若改掉 type 标签,Extract 得 never,never 对任何断言都真空通过 —— 先钉住「两型都还在」。
export type _SessionTabStillExists = Assert<IsNever<UpstreamSessionTab> extends false ? true : false>
export type _DraftTabStillExists = Assert<IsNever<UpstreamDraftTab> extends false ? true : false>
// 方向一:上游写出的每个 tab 都满足预清契约(上游删键/改字段类型 ⇒ 红)。
export type _UpstreamSessionSatisfiesContract = Assert<[UpstreamSessionTab] extends [SessionTabContract] ? true : false>
export type _UpstreamDraftSatisfiesContract = Assert<[UpstreamDraftTab] extends [DraftTabContract] ? true : false>
// 方向二:键集精确相等(上游加键、或契约要求上游没有的键 —— #926 的 dirBase64 即此形 ⇒ 红)。
export type _SessionKeysExact = Assert<KeysExact<UpstreamSessionTab, SessionTabContract>>
export type _DraftKeysExact = Assert<KeysExact<UpstreamDraftTab, DraftTabContract>>

// ── #932 声明顺序闸 ────────────────────────────────────────────────────────────────────
// 上面那行 `import ... from "@opencode-ai/app"` 正是 #932 的危险条件:它把上游 app.tsx 里那份
// 极简可选的 `Window.api` 全局声明拉进 program,而本文件位于 src/main(字母序早于 src/renderer)。
// 没有 tsconfig 的 `files` 兜底,上游那份就会先进 program 并赢下合并 —— skipLibCheck 吞掉声明处
// 的 TS2717,唯一的症状是 renderer 侧几百条与改动无关的 `window.api` 假红。
//
// 下面三条断言直接问「合并之后 `Window["api"]` 到底是什么」,不看任何声明文件的文本。
// 它们必须留在 `.ts` 里:写进 `.d.ts` 会被 skipLibCheck 一起吞掉,等于没写。
type HasKey<K extends string> = [K] extends [keyof Window["api"]] ? true : false

// ① 合并后的全局就是 alpha 那份完整面(上游那份赢 ⇒ 结构不兼容 ⇒ 红)。
export type _WindowApiIsAlphaElectronAPI = Assert<[Window["api"]] extends [ElectronAPI] ? true : false>
// ② 上游那份是 `api?:`(整枝可选)。这条单独钉住「不可为 undefined」—— ①若哪天被放宽成双向
//    兼容也拦不住可选性回潮,而可选性正是 162 条 TS18048 的来源。
export type _WindowApiIsNotOptional = Assert<[undefined] extends [Window["api"]] ? false : true>
// ③ 独立字面量锚:这三个键只在 alpha 那份上有(上游只有 setTitlebar / exportDebugLogs 两个可选键)。
//    期望值是手写字面量、不从被测类型派生,所以「把 ElectronAPI 改空」也杀不掉这条。
export type _WindowApiHasEndpoints = Assert<HasKey<"endpoints">>
export type _WindowApiHasAuth = Assert<HasKey<"auth">>
export type _WindowApiHasKillSidecar = Assert<HasKey<"killSidecar">>
