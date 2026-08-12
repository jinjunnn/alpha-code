// #926 漂移闸:main 侧 tabs 预清(src/main/tabs-preclean.ts)的 tier-1 形状判据,与上游
// packages/app(滚动 pin,ADR-034)的 Tab 类型绑成一条会红的判据 —— pin bump 改了 tab 形状而
// 判据没跟,ui-mac typecheck 当场红,而不是像 #926 的 dirBase64 那样悄悄漂成「专剔合法数据、
// 用户重启丢标签页」。全部 import type,编译期擦除,零运行时。
//
// 为什么放 renderer 而不是紧挨着判据放 main:上游 app.d.ts 里有一个 `Window.api` 的极简可选
// 全局声明,与本包 env.d.ts 的 ElectronAPI 声明冲突;skipLibCheck 吞掉声明处冲突后**谁先进
// program 谁赢**。src/main 字母序先于 src/renderer,在 main 侧 import "@opencode-ai/app" 会让
// 上游声明抢先装载 ⇒ renderer 379 处 window.api 使用点假红(2026-08-11 实测)。renderer 侧
// import 与现状同序,不动这架天平。

// 反孤儿(#929 审计 Major):本文件曾是孤儿 —— 没人 import,删掉它 typecheck 与全量测试都不红,
// gate-files.tsv 又只收测试文件,结构上没有任何东西拦得住它消失。现在两条腿钉死:
//   ① 契约类型的唯一定义搬进 src/shared/tabs-preclean-contract.ts,main 的谓词从那里派生
//     (不能定义在本文件再让 main 反向 import:那会把 "@opencode-ai/app" 传递进 src/main 的
//     解析链,踩中下述声明顺序地雷 —— 2026-08-11 实测正好 379 条假红);
//   ② 本文件由 renderer/index.tsx 的 type-only import 钉进 program —— 删掉本文件 = 入口
//     TS2307 当场红(绕过实验实测,见 PR #929)。

import type { useTabs } from "@opencode-ai/app"
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
