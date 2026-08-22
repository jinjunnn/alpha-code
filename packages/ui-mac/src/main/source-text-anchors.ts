// `#968` —— 「读仓内源码文本做断言」这一类的**分类登记簿**(判据在 gate-file-registry 的第 ⑤ 层)。
//
// 这个文件为什么**不是**测试文件:第 ⑤ 层的两张表以「测试文件路径」为键,而 gate-file-registry
// 自己是登记在册的闸门文件 —— 它的第 ③ 层「引用绊线」读的是**未剥注释的原始 body**,凡出现的
// `*.test.ts` 都必须已被分类成 REGISTERED / NOT_GATES / REFERENCED_BUT_UNREGISTERED 三者之一。
// 把这些路径写进那个文件,23 条一个都满足不了三条出口(它们不进 TSV;NOT_GATES 有 GATE_NAME_TOKENS
// 前置断言而这些文件名多数不命中;REFERENCED_BUT_UNREGISTERED 的公开含义是「这条保证今天没有 CI
// 在跑」,而它们每次 `bun test src` 都在跑 —— 塞进去是假话)。表放在**非测试模块**里,路径字面量
// 就不在任何已登记闸门文件的 body 里了,既不用给绊线开第四个出口,也不动它的语义。
//
// ── 这一类是什么 ──────────────────────────────────────────────────────────────────────
// 一个测试读仓内某个 `.ts`/`.tsx` 源码文件的**文本**,然后 `indexOf` 比下标、`toContain` 比字符串。
// 本仓对这类断言的裁决(`#218` / `#966` / `#968`)分两种,取决于**断言的主语**:
//
//   · **减速带(ANCHOR)** —— 主语是**运行期行为**(顺序 / 接线 / 生命周期 / 呈现),而算子是文本。
//     一个语义等价但写法不同的实现骗得过它;一个文本一模一样而行为被掏空的实现**也**骗得过它。
//     这类必须如实降级:测试标题带 `ANCHOR (not a gate): ` 前缀,并在下面登记「守不住什么」。
//
//   · **文本就是产物(KEPT)** —— 主语**就是文本本身**:负全称(「全仓不存在第二处 X」)、唯一性
//     计数、跨文件/跨包逐字一致、声明式配置的字面声明。这类没有更细的粒度,源码文本正是正确的
//     粒度,不降级。**选它不是免费的**:同样要写清为什么,同样要给一个能解析的证据指针。
//
// ── 为什么 `packages/ui-mac/src/main/index.ts` 那一批必须降级(实测,不是推断)────────────
// `index.ts:8` 静态具名 import `node:tls` 的 `setDefaultCACertificates`,而装着的 bun 1.3.14 没有它。
// 三条互相独立的执行路径全部失败:①直接 import ⇒ `SyntaxError: Export named 'setDefaultCACertificates'
// not found in module 'node:tls'`;②在动态 import **之前**注册 `mock.module("node:tls", …)` ⇒ 同一条
// SyntaxError,`0 pass / 1 fail`;③`Bun.plugin` 的 `build.module` ⇒ bun 明文拒绝
// `module() cannot be used to override builtin module "node:tls"`。
// ⇒ **bun 侧不存在把 index.ts 链接起来的办法**;`Effect.runFork(main)`(文件最后一行)只是第二堵墙。
// 也就是说这批锚不是「暂时还没写真判据」,是**结构上写不了**。boot/respawn 悬空 sweep → fork
// 的真闸门已落在 `#982`:`dangling-sweep-latch.ts` + `spawnLocalServer` 消费 credit(可 import,
// bun 可测)。本文件里的 ANCHOR 条目仍只是索引,不是那道闸。
//
// ── 边界(闸门不假装比自己强)────────────────────────────────────────────────────────────
//   · 谓词判的是**一行代码里同时出现读调用与一个 `.ts`/`.tsx` 路径字面量**。两支逃逸,都登记在 `#983`:
//     ①路径经变量/助手间接传入(`const F = "index.ts"; read(F)`);
//     ②**目录遍历** —— `readdirSync` 递归枚举出一批源文件名,再逐个 `readFileSync(join(dir, f))`,
//       行内一个路径字面量都没有。今天树上的活实例:`platform-error-code-gate.test.ts`
//       (它对 `src/main/` 全树的源码文本做负全称/唯一性断言,按本分类法归 KEPT)。
//     不靠放宽正则修:实测放宽会把命中从 39 打到 62/110 并把精度打崩(那就是「手写别人文法的替身」)。
//   · 范围今天锁死在 `packages/ui-mac/src/main/` 与 `packages/ui-mac/test-component/`。往全仓推是 `#981`。
//   · 分类是**按文件**的。一个文件里既有锚又有正当的文本闸时,归 ANCHOR(fail-closed),并由
//     `why` 说清哪几条是哪种。

/** 降级标签。测试**标题**里必须出现这一串(只写在注释里不算 —— 注释拆得掉,CI 输出里读不到)。 */
export const ANCHOR_TEST_LABEL = 'test("ANCHOR (not a gate)'

/** 第 ⑤ 层的辖区。往外推 = `#981`,不是在这里加前缀。 */
export const SOURCE_TEXT_SCOPE_PREFIXES = [
  "packages/ui-mac/src/main/",
  "packages/ui-mac/test-component/",
] as const

/** 读调用的形状。刻意**不**去排除写(没有任何 `writeFileSync` 特判)—— 过度命中由 KEPT 表吸收。 */
const READ_CALL = /\b(?:Bun\.file|read[A-Za-z]*)\s*\(/

/** 仓内源码路径字面量(单/双/反引号三种)。 */
const SOURCE_PATH_LITERAL = /(['"`])([^'"`\n]*?\.tsx?)\1/g

/** 测试/用例文件的路径字面量不算 —— 那是第 ③ 层的辖区,而且它不是生产源码。 */
const TEST_PATH_LITERAL = /\.(test|spec|cases)\.tsx?$/

/**
 * 命中的**代码行**(整行注释不算:静态判据约束的是代码,注释里允许举例说明 —— 与第 ③ 层
 * `codeLines` 同款理由。少了这一步,一句解释性的抬头就能把自己算进来)。
 */
export function sourceTextReadLines(source: string): string[] {
  const hits: string[] = []
  for (const line of source.split("\n")) {
    if (/^\s*(\/\/|\/?\*)/.test(line)) continue
    if (!READ_CALL.test(line)) continue
    SOURCE_PATH_LITERAL.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = SOURCE_PATH_LITERAL.exec(line))) {
      if (TEST_PATH_LITERAL.test(match[2]!)) continue
      hits.push(line.trim())
      break
    }
  }
  return hits
}

export type SourceTextEntry = {
  /** 这个文件的源码文本断言守不住什么(ANCHOR 必须点名 ≥2 个不会让它变红的变异)。 */
  why: string
  /** 可解析的证据指针:`#<数字>`,或一个盘上真实存在的 `docs/…` 路径。 */
  evidence: string
  /** 今天命中的**行数**。同一文件里新增一处同形态断言 ⇒ 数字对不上 ⇒ 当场红。 */
  lines: number
}

/**
 * **减速带**:文件里至少有一条源码文本断言的主语是运行期行为。
 * 每个条目对应的文件必须真的带上 `ANCHOR (not a gate): ` 标题前缀(第 ⑤ 层机械校验)。
 */
export const DOWNGRADED_ANCHORS: Record<string, SourceTextEntry> = {
  "packages/ui-mac/src/main/alpha-config-injection.test.ts": {
    why: "锚 sidecar.ts 里 ready 上报的取值与调用顺序。sidecar.ts 顶层就跑 registerHooks / getParentPort(),import 即副作用 ⇒ 没有单测驱动得了它。两个不会让它变红的变异:①在 postMessage 那一行之前把 injection 整个覆盖成空对象(被比较的文本逐字未变);②给 start() 加一条早退 return,ready 一次都不发。",
    evidence: "#613",
    lines: 1,
  },
  "packages/ui-mac/src/main/alpha-contract-health.test.ts": {
    why: "锚的是 renderer 三个文件里「那几个标识符在不在」。它证不了 banner 真的渲染、也证不了 role=alert 真的可达。两个不会让它变红的变异:①把 <ContractFailureBanner /> 挪进一个恒假分支;②把 providers 里的订阅回调改成不更新状态。真判据要走组件测试道(本文件今天没有)。",
    evidence: "#224",
    lines: 3,
  },
  "packages/ui-mac/src/main/alpha-root-retirement.test.ts": {
    why: "3 处里 2 处(全树扫描退休 sentinel/alias)是**负全称**,文本就是被守的产物;第 3 处是锚 —— index.ts 里 bootEnforcementGap 的赋值 / 判定 / spawn 三段下标先后。两个不会让它变红的变异:①把 if (bootEnforcementGap) 整块删掉(赋值那句仍在,而断言只比下标);②把 gap 判定改成永远取到空值。index.ts 结构上进不了 bun(见本文件抬头)。",
    evidence: "#428",
    lines: 3,
  },
  "packages/ui-mac/src/main/artifact-quick-look.test.ts": {
    why: "锚 artifact-ipc.ts 与 preload 入口里「那两串字面量在不在」。两个不会让它变红的变异:①把 registerArtifactQuickLookIpcHandler({…}) 的调用包进一个从不为真的条件;②preload 里把 quickLook 挂到一个没有被 exposeInMainWorld 的对象上。同文件下半场有真实的拒收行为判据,但它们跑的是 handler 本体,不跑注册这一跳。",
    evidence: "#520",
    lines: 2,
  },
  "packages/ui-mac/src/main/catalog-liveness.test.ts": {
    why: "锚 index.ts 里看门狗的武装 / 停表 / 裁决消费接线(含两处出现次数)。两个不会让它变红的变异:①把 armCatalogLivenessWatchdog 的函数体整个换成 no-op(两处调用文本仍在、次数仍是 2);②把 decideCatalogLiveness(…) 的返回值算出来后丢掉不执行动作。index.ts 结构上进不了 bun。",
    evidence: "#564",
    lines: 1,
  },
  "packages/ui-mac/src/main/deep-link-wiring.test.ts": {
    why: "3 处读 index.ts / windows.ts / deep-links.ts。两条 test 是锚(每个 OS 入口都喂同一个队列、retained-copy 协议两半都接上),另两条是唯一性/负全称锁(.send(\"deep-link\") 恰好一次、index 里不得出现 trackDeepLinkRenderer)—— 后者本票不降级。锚的两个不会变红的变异:①把 deepLinks.ingest(process.argv) 挪到 whenReady 之后(文本仍在,顺序不被断言);②把 acknowledge 的实现改成空函数。",
    evidence: "#638",
    lines: 3,
  },
  "packages/ui-mac/src/main/engine-config-dangling.test.ts": {
    why: "`#218` 已经降级并在测试上方点名三个不会让它变红的变异(丢弃 recordDanglingSweep 的返回值、把 if (bootEnforcementGap) 整块注释掉、把 sweep 结果换成空数组)。本票只是把它并进统一登记,断言内容一个字符没动。",
    evidence: "#218",
    lines: 1,
  },
  "packages/ui-mac/src/main/ext-config.test.ts": {
    why: "锚 index.ts 里社区 Excel 退役必须以 extLedgerReady 为恢复 barrier,且主进程必须在第一次 spawnLocalServer( 前 await 它;ensureGovernedMcpConnectTimeouts() 也仍在第一次 spawn 之前 —— 比的是 indexOf 下标,不是执行序。两个不会让它变红的变异:①把退役或 timeout 函数体改成直接 return(调用文本仍在);②把算出的变更丢掉不写盘。index.ts 结构上进不了 bun;恢复等待/持锁/非终态 journal 的行为证据在 community-excel-retirement.test.ts。",
    evidence: "#551",
    lines: 1,
  },
  "packages/ui-mac/src/main/mcp-workspace-marker.test.ts": {
    why: "锚 index.ts 里 marker reconcile 接在 timeout reconcile 后且排在第一次 spawnLocalServer( 之前。两个不会让它变红的变异:①把 reconcileMcpWorkspaceMarkers 的函数体改成直接 return;②让它返回改写后的文本却丢弃写盘结果。index.ts 结构上进不了 bun。",
    evidence: "#1011",
    lines: 1,
  },
  "packages/ui-mac/src/main/ext-project-adopt.test.ts": {
    why: "锚 ext-ipc.ts 里 adoptProjectLedger(directory 必须排在两条早退之前 —— 同样是下标比较。两个不会让它变红的变异:①把 adoption 调用包进一个恒假分支;②在它前面再加第三条早退。ext-ipc.ts 是可 import 的,换成真判据做得到,但那是 #356 的题目。",
    evidence: "#356",
    lines: 1,
  },
  "packages/ui-mac/src/main/plugin-internal-boot-order.test.ts": {
    why: "锚构建脚本 prebuild.ts 里两段字符串的先后。两个不会让它变红的变异:①把 patch 调用放进一个 if (process.env.SKIP) 分支;②把 patch 改成失败时静默跳过。真判据是打包产物里那段代码有没有被改写,本仓没有那道门。",
    evidence: "#870",
    lines: 1,
  },
  "packages/ui-mac/src/main/renderer-diagnostic-redaction.test.ts": {
    why: "2 处读 windows.ts / logging.ts,锚四条崩溃/故障通道确实调用 safeRouteLabel/safeErrorName(而不是直落 win.webContents.getURL()/details/error/preloadPath)以及 spyRendererConsole 被关闭。两个不会让它变红的变异:①在同一条 writeLog 调用里,除已断言的 safeRouteLabel(...) 字段外再并列新增一个字段直接塞回原始 URL/details(正则只咬旧形态的精确并列写法,咬不到新增的第三个字段);②把 safeRouteLabel/safeErrorName 本身改坏成直接回传入参 —— 调用点文本一字不改,只有本文件的 behavior describe 块(真实调用两个函数并断言输出)才会为此变红。",
    evidence: "#900",
    lines: 2,
  },
  "packages/ui-mac/src/main/recovery-wiring.test.ts": {
    why: "7 处里 3 条 test 是锚(index.ts 的 runDbPreflightBoot({ 早于 mainWindow = createMainWindow()、fatal 事件的固定 reason 接线、recovery-ipc 的安装顺序),其余是 Recovery 窗口的安全开关与负全称/唯一性锁(不降级)。锚的两个不会变红的变异:①把 runDbPreflightBoot 的 await 去掉让它与建窗并发;②把 presentRecovery 的实现改成空函数。index.ts 结构上进不了 bun。",
    evidence: "#445",
    lines: 7,
  },
  "packages/ui-mac/src/main/sidecar-generation.test.ts": {
    why: "锚 index.ts 里终态生产者的武装位置与出现次数。两个不会让它变红的变异:①把 armBootGenerationTerminal 的函数体改成立刻 resolve;②把另一个已 resolve 的 promise 传进去(被比较的 `spawning,` 文本仍在)。index.ts 结构上进不了 bun。",
    evidence: "#577",
    lines: 1,
  },
  "packages/ui-mac/src/main/sidecar-lifecycle.test.ts": {
    why: "两处都锚 index.ts:boot token 代的捕获/结算位置,以及 killSidecar 的收口预算分支。两个不会让它变红的变异:①在 bootForkTokenGeneration = forkTokenGeneration 之后再覆盖一次;②把 current.stop(…) 前面的 await 去掉(那一行文本逐字未变)。index.ts 结构上进不了 bun。",
    evidence: "#600",
    lines: 2,
  },
  "packages/ui-mac/src/main/sidecar-location-prewarm.test.ts": {
    why: "锚 sidecar.ts 里 prewarm → listen → settle → ready 四段的下标先后。两个不会让它变红的变异:①把 await prewarm 的结果丢掉;②把 prewarmInitialLocation 换成立刻 resolve 的空实现。sidecar.ts 顶层有副作用,import 不得。",
    evidence: "#881",
    lines: 1,
  },
  "packages/ui-mac/src/main/sidecar-shared-location-map.test.ts": {
    why: "锚构建脚本 prebuild.ts 里三段字符串的先后。两个不会让它变红的变异:①把 patch 调用包进条件分支;②让 patch 在匹配不到时静默跳过而不是抛。真判据是打包产物,本仓没有那道门。",
    evidence: "#870",
    lines: 1,
  },
  "packages/ui-mac/src/main/sidecar-stop.test.ts": {
    why: "锚 sidecar.ts 的 stop 是否接在共享执行器上(含一条负全称:本文件不得再出现 listener.stop()。两个不会让它变红的变异:①把 stopSidecarListener 的实现改成直接 return;②在别的模块里再关一次连接。sidecar.ts 顶层有副作用,import 不得;同 describe 里上面四条才是真行为判据,这一条只保证生产真的接在那上面。",
    evidence: "#911",
    lines: 1,
  },
}

/**
 * **文本就是被守的产物**,或者「是锚但降级归别的票」。后者必须点名归谁 —— 写「以后再说」等于没写。
 * 选这张表不是零成本:`why` 与 `evidence` 的机械要求与上表完全相同,**而且**以 `.test.ts` 结尾的键
 * 必须登记进 `scripts/gate-files.tsv`(第 ⑤ 层机械校验)—— 这张表说它是真闸门,真闸门不许「删掉不红」。
 * `.cases.ts` 键豁免:它们不进整包计数,由第 ④ 层反向那半(每个 cases 文件必须被一个已登记宿主跑到)兜住。
 */
export const KEPT_SOURCE_TEXT_READS: Record<string, SourceTextEntry> = {
  "packages/ui-mac/src/main/boot-dangling-onboarding-wiring.test.ts": {
    why: "主语是负全称加唯一性:index.ts 每个 `if (!TEST_ONBOARDING)` 块不得包含 boot dangling sweep;REQ-059/065/104 与 ecosystem gate 必须仍在该守卫内;runBootDanglingSweep 恰好一次且排在首个 spawnLocalServer 之前。index.ts 结构上进不了 bun,这份布局就是接线契约。删掉 sweep 调用会由 boot-dangling-sweep.test.ts 的可执行闸变红,本条守的是「调用点不在 skip 里」。",
    evidence: "#1031",
    lines: 1,
  },
  "packages/ui-mac/src/main/alpha-environment.test.ts": {
    why: "两处在同一条 grep 守卫里:main 侧 handler 必须零参数、preload 侧 invoke 必须不带参数,且两侧都**不得**出现任何环境写面通道名。主语是负全称(「不存在第二个写面」)—— 没有比源码文本更细的粒度能表达「全仓没有」。",
    evidence: "#239",
    lines: 2,
  },
  "packages/ui-mac/src/main/cloud-web-search.test.ts": {
    why: "主语是**跨包逐字一致**:主权信道名的声明点在传输层、叶子只转出,两侧字面量对不上就等于信道断掉而没有任何行为测试会红。其中一句 toContain 是接线锚,但同文件另有四条真实驱动拒绝路径的行为判据 ⇒ 它不是那条保证的唯一守卫。",
    evidence: "#650",
    lines: 2,
  },
  "packages/ui-mac/src/main/ext-cas-gc-scheduler.test.ts": {
    why: "断言的是 electron.vite.config.ts 自己的**声明**(worker 第三入口)。配置文件的文本就是产物,不是行为的替身;bun 侧跑不了 electron-vite。残余:声明在而打包产物仍缺入口时本条不红 —— 那是打包级事实,本仓没有那道门。",
    evidence: "#367",
    lines: 1,
  },
  "packages/ui-mac/src/main/ext-security-boundaries.test.ts": {
    why: "五处全部是负全称 / 唯一性:preload 的 import 说明符集合、exposeInMainWorld 恰好一次、窗口硬化三个开关、隔离预览 host 零 bridge、只读通道名在全 main 树里恰好出现在一个文件。「全仓没有第二处」结构上只能对文本断言。",
    evidence: "#494",
    lines: 5,
  },
  "packages/ui-mac/src/main/sidecar-env.test.ts": {
    why: "三处都从 sidecar-env.ts 的源码里**解析出 ALLOW / DENY 清单**,再拿这份清单去驱动真的 createSidecarEnv(或断言成员形状:没有凭据名、全小写)。被守的是那份源码声明的清单本身,文本就是产物;而行为半场是真执行,不是文本比较。",
    evidence: "#639",
    lines: 3,
  },
  "packages/ui-mac/src/main/websearch-copies.test.ts": {
    why: "10 处里 6 处是普查 / 负全称 / 跨包逐字一致(文本即产物);另 4 条是位置锚(闸是出网出口的第一句等)。这 4 条按本票分类法是减速带,但目标模块都是**可 import 的**,换真判据做得到 —— 而这份文件的 describe 自称 #223 R4 主判据,降不降级是那份已批基线的题目,不是本票的边界。如实登记为已知减速带,裁决在 #985。",
    evidence: "#985",
    lines: 10,
  },
  "packages/ui-mac/test-component/local-package-renderer.cases.ts": {
    why: "主语是 preload 暴露的通道名与 main 侧常量**逐字一致**(写错一个字母 = 功能死掉且什么都不红)。跨进程的字符串相等只能对文本断言,没有更细的粒度。",
    evidence: "#791",
    lines: 1,
  },
}
