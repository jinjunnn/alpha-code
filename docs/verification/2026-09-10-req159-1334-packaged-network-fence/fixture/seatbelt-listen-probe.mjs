import net from "node:net"
import fs from "node:fs"
const out = { started: true }
const srv = net.createServer((sock) => { out.accepted = (out.accepted ?? 0) + 1; sock.end("SERVED") })
srv.on("error", (e) => { out.listen = `ERR ${e.code}`; report(); process.exit(0) })
srv.listen(0, "127.0.0.1", () => { out.listen = "ok"; out.port = srv.address().port; report() })
function report() { fs.writeFileSync(process.env.PORTFILE, JSON.stringify(out)) ; console.log("STARTED " + JSON.stringify(out)) }
setTimeout(() => { fs.writeFileSync(process.env.PORTFILE, JSON.stringify(out)); console.log("FINAL " + JSON.stringify(out)); process.exit(0) }, 4000)
