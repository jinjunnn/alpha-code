// REQ-159 (`#1321`) —— 在**出货 sidecar 的运行时**(Electron 内嵌 node,ELECTRON_RUN_AS_NODE=1)里跑的探针:
// 装上生产渲染的 profile(经生产 .node 模块),然后用引擎派生子进程的四类原语各写一次界内 / 界外。
// 判据不在这里 —— 这里只做动作并把自报打成 JSON;落没落盘由测试进程 ls 实读(process-fence-apply.test.ts)。
//
//   argv: <addonPath> <mode: bare|fenced> <profileFile> <ws> <esc> <ptyModulePath>
//
// 四类(勘破 §3 表右列的创建原语):
//   shell   = node:child_process.spawn(zsh -c …)          ← shell 工具 / prompt !cmd 的形状
//   cross   = node:child_process.spawn 经 sh 再起 sh(孙进程)← MCP SDK / LSP 走 cross-spawn → cp.spawn,深度 2
//   detach  = spawn({ detached:true })                    ← nohup 一类脱离会话组
//   pty     = @lydell/node-pty spawn(/bin/zsh -c …)与 spawn(/bin/sh -c …)  ← 终端(缺省 shell / 带 command)
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const [addonPath, mode, profileFile, ws, esc, ptyModulePath] = process.argv.slice(2)
const out = { runtime: `node ${process.versions.node} (electron ${process.versions.electron ?? "-"})`, mode, steps: {} }
const fail = (why) => {
  out.fatal = why
  console.log(JSON.stringify(out))
  process.exit(3)
}

if (mode === "fenced") {
  const m = { exports: {} }
  process.dlopen(m, addonPath)
  const r = m.exports.apply(fs.readFileSync(profileFile, "utf8"))
  out.buildId = m.exports.buildId
  out.apply = r
  if (r.rc !== 0) fail(`apply rc=${r.rc}: ${r.error}`)
}

const probe = (name) => ({ inside: path.join(ws, `${name}-${mode}.txt`), outside: path.join(esc, `${name}-${mode}.txt`) })
const write = (p) => {
  try {
    fs.writeFileSync(p, "x")
    return "wrote"
  } catch (e) {
    return `error:${e.code}`
  }
}
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts })
  return { status: r.status, stderr: (r.stderr ?? "").trim().slice(0, 160) }
}

// 0) 进程自身
{
  const p = probe("self")
  out.steps.self = { inside: write(p.inside), outside: write(p.outside) }
}
// 1) shell 形状
{
  const p = probe("shell")
  out.steps.shell = { inside: run("/bin/zsh", ["-c", `echo x > "${p.inside}"`]), outside: run("/bin/zsh", ["-c", `echo x > "${p.outside}"`]) }
}
// 2) 孙进程(深度 2,cross-spawn → sh → sh 的形状)
{
  const p = probe("grandchild")
  out.steps.grandchild = {
    inside: run("/bin/sh", ["-c", `/bin/sh -c 'echo x > "${p.inside}"'`]),
    outside: run("/bin/sh", ["-c", `/bin/sh -c 'echo x > "${p.outside}"'`]),
  }
}
// 3) detached
await (async () => {
  const p = probe("detached")
  const one = (target) =>
    new Promise((resolve) => {
      const c = spawn("/bin/sh", ["-c", `echo x > "${target}"`], { detached: true, stdio: "ignore" })
      c.on("exit", (code) => resolve({ status: code }))
    })
  out.steps.detached = { inside: await one(p.inside), outside: await one(p.outside) }
})()
// 4) PTY:缺省 shell 形状(zsh -c)与带 command 形状(sh -c)
await (async () => {
  const require = createRequire(import.meta.url)
  let pty
  try {
    pty = require(ptyModulePath)
  } catch (e) {
    return fail(`node-pty load failed: ${e.message}`)
  }
  const one = (cmd, args) =>
    new Promise((resolve) => {
      let err
      try {
        const term = pty.spawn(cmd, args, { cols: 80, rows: 24, cwd: ws, env: process.env })
        term.onExit(({ exitCode }) => resolve({ status: exitCode }))
      } catch (e) {
        err = e
        resolve({ status: null, spawnError: String(e.message ?? e) })
      }
    })
  const p1 = probe("pty-zsh")
  out.steps.ptyDefault = { inside: await one("/bin/zsh", ["-c", `echo x > "${p1.inside}"`]), outside: await one("/bin/zsh", ["-c", `echo x > "${p1.outside}"`]) }
  const p2 = probe("pty-cmd")
  out.steps.ptyCommand = { inside: await one("/bin/sh", ["-c", `echo x > "${p2.inside}"`]), outside: await one("/bin/sh", ["-c", `echo x > "${p2.outside}"`]) }
})()

console.log(JSON.stringify(out))
