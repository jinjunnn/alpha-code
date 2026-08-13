// [#940] 枚举闸:src/main 里「读平台 Response 产出 error 字符串」的出口必须全部经
// platform-error-code 咽喉,**新增出口默认被拒**。
//
// 为什么需要它:#918 在 authed() 修过一次同样的缺陷,dispatchExplicitCloudUpload 又长出
// 第二个实例 —— 逐实例修对新成员默认放行,这道闸把边界挪到咽喉点(对新成员默认拒绝)。
//
// 两条互相独立的检索轴(CLAUDE.md《本机验证陷阱》:单一正则会漏):
//   轴① `http-<status>` 的**铸造点**(反引号模板 `http-${…}`)只允许出现在咽喉模块 ——
//        任何新出口把拒绝压成裸数字,这里当场红;
//   轴② 咽喉的**消费者集合**钉死为枚举清单 —— 成员摘掉咽喉(revert 到裸拼)轴①红;
//        新文件接入咽喉则轴②红,强迫把新成员显式登记进清单(登记 = 有人看过这条路)。
//
// 诚实声明(闸门不假装比自己强):这是源码级绊线,不是运行时安全边界 —— 故意绕(把
// res.status 存进变量再拼)能骗过轴①;它防的是「顺手又写一个压平出口」这类真实发生过
// 两次的失效,不防蓄意。行为判据由 platform-error-code.test.ts 与 alpha-cloud-jobs.cases.ts
// 的真实调用链承担。
import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const MAIN_DIR = join(import.meta.dir)

/** 轴①的指纹:反引号模板铸造 `http-${…}`。负向排除唯一的类型位写法 `http-${number}`。 */
const MINT_PATTERN = /`http-\$\{(?!number\})/

/** 轴②的指纹:import 咽喉模块。 */
const THROAT_IMPORT = /from "\.\/platform-error-code"/

/** 咽喉模块自己 —— 全仓唯一允许铸造 http-<status> 的地方。 */
const THROAT_FILE = "platform-error-code.ts"

/** 经咽喉的出口枚举(轴②钉死)。新增出口 ⇒ 这里红 ⇒ 显式登记,不许静默接入。 */
const ENUMERATED_MEMBERS = [
  "alpha-account-request.ts",
  "alpha-artifact-download.ts",
  "alpha-cloud-jobs.ts",
  "alpha-cloud-schedules.ts",
  "alpha-platform-models.ts",
]

/** 递归枚举 src/main 生产源(测试与用例文件被 tsconfig 排除在 typecheck 外,也不在本闸辖区)。 */
function productionSources(dir: string, prefix = ""): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...productionSources(join(dir, entry.name), rel))
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".cases.ts")) out.push(rel)
  }
  return out
}

const mintsRawHttpStatus = (source: string): boolean => MINT_PATTERN.test(source)

describe("platform error code throat — enumeration gate (#940)", () => {
  const files = productionSources(MAIN_DIR)

  test("轴①:http-<status> 只在咽喉模块铸造 —— 新的压平出口即红", () => {
    const minters = files.filter((f) => mintsRawHttpStatus(readFileSync(join(MAIN_DIR, f), "utf8")))
    expect(minters.sort()).toEqual([THROAT_FILE])
  })

  test("轴②:咽喉消费者恰好是枚举清单 —— 成员摘咽喉或新出口静默接入都红", () => {
    const importers = files.filter((f) => THROAT_IMPORT.test(readFileSync(join(MAIN_DIR, f), "utf8")))
    expect(importers.sort()).toEqual(ENUMERATED_MEMBERS)
  })

  // 元判据:先证明观测手段测得出已知的坏,再用它判未知的好(《观测手段自己有盲区》)。
  test("扫描器抓得住 #940 修掉的那行,并放得过唯一的类型位写法", () => {
    // dispatchExplicitCloudUpload 在本票之前的原文 —— 已知的坏。
    expect(mintsRawHttpStatus("if (!response.ok) return { error: `http-" + "${response.status}` }")).toBe(true)
    // authed() 在 #918 之前的原文变体。
    expect(mintsRawHttpStatus("const fallback = `http-" + "${res.status}`")).toBe(true)
    // alpha-artifact-download.ts 的类型位写法 —— 已知的非成员,不许误伤。
    expect(mintsRawHttpStatus("| `http-" + "${number}`")).toBe(false)
    // 字符串字面量比较(deleteCloudSchedule 的 404 容忍)—— 不是铸造,不许误伤。
    expect(mintsRawHttpStatus('r.error !== "http-404"')).toBe(false)
  })

  test("扫描器对含字面 NUL 的内容不瞎(ac#760:grep 会静默返回空,readFileSync 不会)", () => {
    // 若有人把铸造点藏进带 NUL 的文件,grep 轴会假阴;本闸的读取器必须仍然看得见。
    // (源码里写转义 \0 —— 运行时是真 NUL,文件字节里不是,不给下一个人的 grep 埋雷。)
    expect(mintsRawHttpStatus("pre\0amble `http-" + "${res.status}`")).toBe(true)
  })
})
