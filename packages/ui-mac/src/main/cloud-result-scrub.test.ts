// #1113(REQ-092 AC1 桌面消费侧)—— status/artifact-list 开放 `result` 清洗接线闸的子进程宿主。
// 真断言在 cloud-result-scrub.cases.ts(须 mock electron ⇒ mock.module 会污染同进程的其它
// 测试文件,子进程跑,cloud-ipc.test.ts 同款)。
//
// ── `#1294`:满载跑全量 ui-mac 套件时本宿主间歇红,根因**不是**派生失败 ─────────────────
// 当时的判断是「4800 条大套件的负载下派生子进程失败」。那是猜的;把那一次 pre-push 的完整
// 日志翻出来看,子进程**跑起来了**:
//     1 pass / 2 fail / 5 expect() calls / Ran 3 tests across 1 file. [45.00ms]
// 纯函数那条(扫描器标定)照常 pass,而两条走真 HTTP 的用例双双停在
//     expect(status.job_id).toBe("job_scrub1113a")   Received: undefined
// —— `job_id` 为 undefined 意味着 alpha-cloud-jobs 的 `authed()` 回了错误信封。夹具是**本进程
// 自己起的** `Bun.serve`(canned 路由固定、401 不可能、schema 是编译进包的常量),所以
// contract-incompatible / unauthorized / 404 都到不了 ⇒ 只剩 catch 分支的 `{ error: "network" }`:
// **对 loopback 那一跳,响应根本没形成**。而状态读那一跳生产里就是 maxAttempts = 1
// (alpha-cloud-jobs.ts:100),一次瞬态失败即定案。
//
// 正向指认(不是排除法收尾):把 cases 文件里的 origin 提前 `stop(true)`,人为让响应形不成,
// 复跑的签名与红那次逐项吻合 —— `1 pass / 2 fail / 5 expect() calls`、两条都停在同一个
// `job_id` 断言、耗时 8.79ms / 0.57ms(红那次 10.33ms / 0.49ms)。
// **但错误码本身当时看不见**:cases 文件只断言 `job_id`,信封里的 `error`(network /
// http-4xx / contract-incompatible 是三种完全不同的病)一个字都没打出来 —— 所以上面这段
// 只能靠排除法收口。本次一并补上:cases 里两条 HTTP 用例先断言「没有错误信封」,
// 下次它再犯,日志里直接是 `Expected: null · Received: "network"`,不必再推一遍。
//
// 于是修法是给**子进程整体**一个有界重试:瞬态失败重跑一次拿新的 server/新的 socket,
// 恒定失败三次全败仍然红。两条纪律钉在实现里:
//   ① 上限是硬的(MAX_ATTEMPTS),没有「跑到绿为止」;
//   ② 重试**不许静默** —— 每一次失败把原因整段打出来,成功那次再打一行「第 N 次才绿」。
//      否则这就不是修好 flake,是把它藏进绿色里,下次它变频繁也没人知道。
// 反向判据在本文件第二条 test:恒定的坏必须三次全败并逐次点名,派生失败必须以可辨识的
// 原因红,瞬态的坏必须留痕。**不登记 known-fails.tsv**(那是把真闸对这条调成恒绿,#1094 AC3/AC4)。
import { expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** 硬上限。改大它之前先问:是不是把一个恒定的坏当成瞬态在磨。 */
const MAX_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 250

type AttemptFailure = { attempt: number; reason: string }

/**
 * 跑一个子进程判据,瞬态失败有界重试。返回绿那一次的输出与此前失败的逐次原因;
 * 全部尝试都失败则抛 —— 抛出的消息里带**每一次**的退出码/信号/耗时与子进程自陈的输出。
 */
function runChildWithBoundedRetry(opts: {
  label: string
  cmd: string[]
  cwd: string
  mustContain: string[]
}): { output: string; failures: AttemptFailure[] } {
  const failures: AttemptFailure[] = []
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) Bun.sleepSync(RETRY_BACKOFF_MS * (attempt - 1))
    let output = ""
    let reason = ""
    try {
      const started = performance.now()
      const result = Bun.spawnSync({ cmd: opts.cmd, cwd: opts.cwd, env: process.env })
      const ms = Math.round(performance.now() - started)
      output = `${result.stdout.toString()}${result.stderr.toString()}`
      if (result.exitCode !== 0) {
        reason = `子进程退出码 ${result.exitCode}(signal=${result.signalCode ?? "none"}, ${ms}ms)\n${output}`
      } else {
        const missing = opts.mustContain.filter((needle) => !output.includes(needle))
        if (missing.length > 0) {
          reason = `子进程退出码 0,但输出里没有 ${missing.map((n) => JSON.stringify(n)).join(" / ")}(${ms}ms)\n${output}`
        }
      }
    } catch (error) {
      // 派生本身失败(可执行文件不存在、资源耗尽…)。Bun.spawnSync 这时**抛**,不是回非零码 ——
      // 不接住的话本条会以一个与被验行为无关的栈红掉,原因还看不出是派生。
      reason = `派生失败(Bun.spawnSync 抛):${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
    }
    if (!reason) {
      if (failures.length > 0) {
        console.log(
          `[${opts.label}] 子进程第 ${attempt}/${MAX_ATTEMPTS} 次才绿 —— 前 ${failures.length} 次失败的原因已在上方逐条打出。` +
            `这一行存在的意义:重试发生过这件事必须留在日志里,#1294 的 flake 若变频繁,要看得见。`,
        )
      }
      return { output, failures }
    }
    failures.push({ attempt, reason })
    console.log(`[${opts.label}] 第 ${attempt}/${MAX_ATTEMPTS} 次失败:\n${reason}`)
  }
  throw new Error(
    `[${opts.label}] 子进程 ${MAX_ATTEMPTS} 次全部失败 —— 这不是瞬态,是恒定的坏。逐次原因:\n` +
      failures.map((f) => `── 第 ${f.attempt}/${MAX_ATTEMPTS} 次 ──\n${f.reason}`).join("\n"),
  )
}

test("cloud result scrub cases run green in an isolated child process", () => {
  const { output } = runChildWithBoundedRetry({
    label: "#1113 cloud-result-scrub",
    cmd: [process.execPath, "test", join(import.meta.dir, "cloud-result-scrub.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    mustContain: [" 3 pass", " 0 fail"],
  })
  expect(output).toContain(" 3 pass")
  expect(output).toContain(" 0 fail")
})

// `#1294` 的反向判据:证明上面那个重试**测得出已知的坏**,而不是把宿主调成恒绿。
// 三条臂全部用**真** Bun.spawnSync(不手写替身):恒定坏 / 派生失败 / 瞬态坏。
// 下面几行 `[反向判据…]` 开头的失败输出是**故意的**,不是本次运行出了问题。
test("#1294 有界重试:恒定的坏三次全败、派生失败可辨识、瞬态的坏留痕", () => {
  const cwd = join(import.meta.dir, "../..")

  // ── 臂 ①:恒定的坏(点名一个不存在的 cases 文件,bun 每次都退 1)────────────────────
  let constantBad: unknown
  try {
    runChildWithBoundedRetry({
      label: "反向判据①(预期内的坏)",
      cmd: [process.execPath, "test", join(import.meta.dir, "cloud-result-scrub.does-not-exist.cases.ts")],
      cwd,
      mustContain: [" 3 pass", " 0 fail"],
    })
  } catch (error) {
    constantBad = error
  }
  expect(constantBad).toBeInstanceOf(Error)
  const constantMessage = (constantBad as Error).message
  expect(constantMessage).toContain(`${MAX_ATTEMPTS} 次全部失败`)
  // 逐次点名:少一次就说明有哪一次被吞了。
  for (const attempt of [1, 2, 3]) expect(constantMessage).toContain(`── 第 ${attempt}/${MAX_ATTEMPTS} 次 ──`)
  expect(constantMessage).toContain("子进程退出码 1")
  // 子进程**自陈**的输出必须原样带出来(banner 只可能来自子进程),否则失败原因不可辨识。
  expect(constantMessage).toContain("bun test v")

  // ── 臂 ②:派生本身失败(可执行文件不存在)—— 仍以可辨识的原因红,不是静默绿 ───────────
  let spawnFailed: unknown
  try {
    runChildWithBoundedRetry({
      label: "反向判据②(预期内的坏)",
      cmd: [join(tmpdir(), "alpha-1294-no-such-binary"), "test"],
      cwd,
      mustContain: [" 3 pass"],
    })
  } catch (error) {
    spawnFailed = error
  }
  expect(spawnFailed).toBeInstanceOf(Error)
  const spawnMessage = (spawnFailed as Error).message
  expect(spawnMessage).toContain(`${MAX_ATTEMPTS} 次全部失败`)
  expect(spawnMessage).toContain("派生失败(Bun.spawnSync 抛)")
  expect(spawnMessage).toContain("ENOENT")

  // ── 臂 ③:瞬态的坏(第一次失败、第二次绿)—— 必须回绿,并且那一次失败必须留痕 ──────────
  const marker = join(tmpdir(), `alpha-1294-transient-${crypto.randomUUID()}`)
  const script =
    `if [ -e "${marker}" ]; then echo " 3 pass"; echo " 0 fail"; ` +
    `else : > "${marker}"; echo "transient failure injected by #1294 判据" >&2; exit 1; fi`
  try {
    const transient = runChildWithBoundedRetry({
      label: "反向判据③(预期内的坏)",
      cmd: ["bash", "-c", script],
      cwd,
      mustContain: [" 3 pass", " 0 fail"],
    })
    expect(transient.failures.length).toBe(1)
    expect(transient.failures[0]!.attempt).toBe(1)
    expect(transient.failures[0]!.reason).toContain("transient failure injected by #1294 判据")
    expect(transient.output).toContain(" 3 pass")
  } finally {
    rmSync(marker, { force: true })
  }
})
