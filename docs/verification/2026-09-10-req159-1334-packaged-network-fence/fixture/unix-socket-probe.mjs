import net from "node:net"
const socks = process.argv.slice(2)
console.log("STARTED")
const out = []
let i = 0
function next() {
  if (i >= socks.length) { console.log("RESULT " + JSON.stringify(out)); process.exit(0) }
  const p = socks[i++]
  const c = net.connect(p)
  const t = setTimeout(() => { out.push([p, "TIMEOUT"]); c.destroy(); next() }, 1500)
  c.on("connect", () => { clearTimeout(t); out.push([p, "CONNECTED"]); c.destroy(); next() })
  c.on("error", (e) => { clearTimeout(t); out.push([p, "ERR " + e.code]); next() })
}
next()
