// REQ-137 (`#1337`) —— 在**出货 sidecar 的运行时**(Electron 内嵌 node,ELECTRON_RUN_AS_NODE=1)里跑的网络探针:
// 装上生产渲染的 profile(经生产 .node 模块),然后逐条试「唯一放行的那扇门」与逃逸语料。
// 判据不在这里 —— 这里只做动作并把自报打成 JSON(每条带 errno / 状态码 / 耗时);判在 network-egress-fence.test.ts。
//
//   argv: <addonPath> <mode: bare|fenced> <profileFile> <targetName> <targetPort> <proxyPort> <closedV6Port>
//   env : 由测试进程按生产 sidecarEgressProxyEnv(port) 注入(HTTP(S)_PROXY / NO_PROXY …),本文件不自设。
//
// 步骤(每步各自 try/catch,一步失败不影响下一步;`started` 由本进程 pid 自证 —— 空输出 ≠ 拦住):
//   listen        net.createServer().listen(0,"127.0.0.1"),把端口打成一行 `LISTENING <port>` 给测试进程,
//                 等外面(未被围栏)的客户端连进来并回 SERVED —— 票面硬要求一(bind / inbound 必须放行)。
//   proxyFetch    http.setGlobalProxyFromEnv()(= sidecar.ts useEnvProxy 的形状)后 fetch(http://<targetName>:<targetPort>/):
//                 名字只有代理那一侧解得开 ⇒ 200 说明流量真的经代理汇出去了。
//   proxyConnect  裸 TCP 连 127.0.0.1:<proxyPort> 发 CONNECT <targetName>:<targetPort> —— TCP 层的「那扇门」。
//   directTcp     net.connect(127.0.0.1:<targetPort>):绕开代理直连靶站 ⇒ 围栏下 EPERM。
//   rawIp443      net.connect(1.1.1.1:443):直连 raw-IP ⇒ EPERM。
//   udp           dgram.send 到 1.1.1.1:53 ⇒ EPERM。
//   v6OtherPort   net.connect([::1]:<closedV6Port>):loopback 上**非代理端口** ⇒ EPERM(bare 臂 ECONNREFUSED)。
//   dns           dns.lookup("example.com") ⇒ 围栏下解析失败(mDNSResponder 的 unix socket 被 (deny network*) 拦,`#1334` Q2)。
import { createRequire } from "node:module"
import dgram from "node:dgram"
import dns from "node:dns"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"

const [addonPath, mode, profileFile, targetName, targetPortRaw, proxyPortRaw, closedV6PortRaw] = process.argv.slice(2)
const targetPort = Number(targetPortRaw)
const proxyPort = Number(proxyPortRaw)
const closedV6Port = Number(closedV6PortRaw)
const out = { runtime: `node ${process.versions.node} (electron ${process.versions.electron ?? "-"})`, mode, pid: process.pid, steps: {} }
const emit = () => console.log(JSON.stringify(out))
const fail = (why) => {
  out.fatal = why
  emit()
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

const timed = async (fn) => {
  const t0 = Date.now()
  try {
    const value = await fn()
    return { ok: true, ...value, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, code: e?.code ?? e?.cause?.code ?? null, message: String(e?.cause?.message ?? e?.message ?? e), ms: Date.now() - t0 }
  }
}
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${label} probe timeout ${ms}ms`), { code: "PROBE_TIMEOUT" })), ms))])

/** TCP connect 结果:连上 ⇒ {connected:true};错 ⇒ 抛(带 errno)。 */
const tcp = (host, port) =>
  withTimeout(
    new Promise((resolve, reject) => {
      const s = net.connect({ host, port })
      s.once("connect", () => {
        s.destroy()
        resolve({ connected: true })
      })
      s.once("error", (e) => reject(e))
    }),
    4000,
    `tcp ${host}:${port}`,
  )

// listen —— 先于一切网络探针,因为它是「引擎还起得来吗」这一格(`#1334` Q1.1)。
out.steps.listen = await timed(
  () =>
    new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => {
        sock.once("data", (d) => {
          sock.end(`SERVED:${d.toString().trim()}`)
          srv.close()
          resolve({ accepted: 1 })
        })
      })
      srv.once("error", reject)
      srv.listen(0, "127.0.0.1", () => {
        out.listenPort = srv.address().port
        console.log(`LISTENING ${out.listenPort}`)
      })
      setTimeout(() => {
        srv.close()
        reject(Object.assign(new Error("no external client within 8s"), { code: "NO_CLIENT" }))
      }, 8000)
    }),
)

// proxyFetch —— 生产 sidecar 的形状:先 setGlobalProxyFromEnv,再用全局 fetch。
out.steps.proxyFetch = await timed(async () => {
  http.setGlobalProxyFromEnv()
  const r = await withTimeout(fetch(`http://${targetName}:${targetPort}/`), 6000, "proxyFetch")
  return { status: r.status, body: (await r.text()).slice(0, 80) }
})

// proxyConnect —— TCP 层那扇门。
out.steps.proxyConnect = await timed(
  () =>
    withTimeout(
      new Promise((resolve, reject) => {
        const s = net.connect({ host: "127.0.0.1", port: proxyPort })
        let text = ""
        s.once("error", reject)
        s.once("connect", () => s.write(`CONNECT ${targetName}:${targetPort} HTTP/1.1\r\nHost: ${targetName}:${targetPort}\r\n\r\n`))
        s.on("data", (c) => {
          text += c.toString()
          const sep = text.indexOf("\r\n\r\n")
          if (sep < 0) return
          const status = Number(text.split(" ")[1] ?? 0)
          s.destroy()
          resolve({ status, head: text.slice(0, sep).split("\r\n")[0] })
        })
      }),
      4000,
      "proxyConnect",
    ),
)

out.steps.directTcp = await timed(() => tcp("127.0.0.1", targetPort))
out.steps.rawIp443 = await timed(() => tcp("1.1.1.1", 443))
out.steps.udp = await timed(
  () =>
    withTimeout(
      new Promise((resolve, reject) => {
        const s = dgram.createSocket("udp4")
        s.once("error", (e) => {
          s.close()
          reject(e)
        })
        s.send(Buffer.from("ac1337"), 53, "1.1.1.1", (e) => {
          s.close()
          e ? reject(e) : resolve({ sent: true })
        })
      }),
      4000,
      "udp",
    ),
)
out.steps.v6OtherPort = await timed(() => tcp("::1", closedV6Port))
out.steps.dns = await timed(
  () =>
    withTimeout(
      new Promise((resolve, reject) => dns.lookup("example.com", (e, address) => (e ? reject(e) : resolve({ address })))),
      6000,
      "dns",
    ),
)

emit()
process.exit(0)
