// `#1374`:共享 `window.api` 桩与 preload 真面的**键集合**判据。
//
// ── 治的是什么 ───────────────────────────────────────────────────────────────────
// 给 preload 加一个新能力而忘了给组件测试的共享桩补上,后果不是「少测一点」:挂 composer
// 的那批 cases 文件会在某个**与你的改动无关**的用例里炸 `undefined is not an object`,
// 红法长得像自己刚把渲染逻辑改坏了(`#1353` 实测)。本文件让这件事在 typecheck 就红,
// 并**逐字点名**那个没表态的键。
//
// ── 锚点为什么是 `keyof ElectronAPI` ─────────────────────────────────────────────
// `preload/index.ts:30` 写的是 `const api: ElectronAPI = { … }`,末行 `exposeInMainWorld("api", api)`。
// 对象字面量赋给带类型的变量 ⇒ 编译器**双向**钉死:缺键报缺、多键报多。所以
// `keyof ElectronAPI` 就是 renderer 在运行期真正拿到的那一组顶层键,不是它的手写副本
// (仓规:不要给别人的文法手写替身)。
//
// ── 判据自证 ─────────────────────────────────────────────────────────────────────
// 下面第二个断言带 `@ts-expect-error`:人为从「已提供」里拿掉一个键,这道判据**必须**红。
// 它若哪天变成哑弹(恒 true),那条指令会因为「未被使用的 @ts-expect-error」自己报错。
// 与同目录 `upload-surface.typecheck.ts` 同形。
//
// 为什么从 src 反向 import 一个测试目录:被判的就是那份桩,而 `test-component/` 不在
// ui-mac 的 tsconfig `include` 里(cases 文件不进 typecheck)。把判据放在这里,是让它
// 搭上 alpha-check 已有的 `typecheck ui-mac` 那一步 —— 不新增闸门入口。判据本身不被
// preload 的构建入口(electron.vite.config.ts 只列 index/recovery 两个)引用,不进产物。
import type { AbsentOnPurposeKey, ProvidedKey } from "../../test-component/preload-stub"
import type { ElectronAPI } from "./types"

/** 既没进共享桩、也没登记为「刻意不提供」的 preload 能力。 */
type Unclassified<Provided extends keyof ElectronAPI> = Exclude<keyof ElectronAPI, Provided | AbsentOnPurposeKey>
/** 空集 ⇒ `true`;非空 ⇒ 注解退化成那几个键名,`true` 赋不上去,错误里就是它们。 */
type MustBeEmpty<Keys> = [Keys] extends [never] ? true : Keys

// 新增 preload 能力而共享桩没表态 ⇒ 本行红,点名缺的那个键。
const everyPreloadCapabilityIsClassified: MustBeEmpty<Unclassified<ProvidedKey>> = true
void everyPreloadCapabilityIsClassified

// @ts-expect-error 自证:从「已提供」里拿掉 `models`,本判据必须红。
const classificationGateIsNotADud: MustBeEmpty<Unclassified<Exclude<ProvidedKey, "models">>> = true
void classificationGateIsNotADud

// 反向:preload 删掉某个能力后,登记表里不许留僵尸条目(单向的表会变成僵尸,见
// scripts/alpha-path-residue.tsv 抬头同一条理由)。
const noZombieAbsentEntries: MustBeEmpty<Exclude<AbsentOnPurposeKey, keyof ElectronAPI>> = true
void noZombieAbsentEntries

// @ts-expect-error 自证:表里混进一个真面没有的键,上一条必须红。
const zombieGateIsNotADud: MustBeEmpty<Exclude<AbsentOnPurposeKey | "notAPreloadKey", keyof ElectronAPI>> = true
void zombieGateIsNotADud

// 两张表不许重叠 —— 同一个键既「提供」又「刻意不提供」时,上面两条各自都还是绿的。
const tablesAreDisjoint: MustBeEmpty<Extract<ProvidedKey, AbsentOnPurposeKey>> = true
void tablesAreDisjoint
