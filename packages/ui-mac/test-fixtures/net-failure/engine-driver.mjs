// `#1572` AC4 真栈:在 **Electron 内嵌 node**(= 出货 sidecar 的 utilityProcess 运行时)里起真引擎。
// 引擎是 packages/opencode/script/build-node.ts 同一配方现打的 node bundle(出货 sidecar 的 virtual:opencode-server
// 就是它);出网走法与 sidecar.ts 的 useEnvProxy 相同:env 里的代理变量 + http.setGlobalProxyFromEnv()。
// argv: <engine bundle node.js> <port> <password>
import http from "node:http"
import { pathToFileURL } from "node:url"

const [bundle, port, password] = process.argv.slice(2)
http.setGlobalProxyFromEnv()
const { Server } = await import(pathToFileURL(bundle).href)
await Server.listen({ port: Number(port), hostname: "127.0.0.1", username: "opencode", password })
console.log(`LISTENING ${port} node=${process.versions.node} electron=${process.versions.electron}`)
