// REQ-234 `#1531`:把测试进程经 node IPC 接成引擎进程的 `process.parentPort` —— 与出货 sidecar 里 Electron utilityProcess 给的
// parentPort 同形(postMessage / on("message", ({ data }) => …)),于是 @alpha-code/ext 的定制中心桥与重载调度器在这里收发的
// 就是 main ⇄ sidecar 那一族 `alpha.*` 消息。必须在引擎(以及它装载的 ext)之前装上:ext 在模块装载时读它。
if (typeof process.send !== "function") {
  console.error("engine-parent-port-preload: no IPC channel")
  process.exit(3)
}
;(process as unknown as { parentPort: unknown }).parentPort = {
  postMessage: (message: unknown) => process.send!(message),
  on: (_event: "message", listener: (event: { data: unknown }) => void) => process.on("message", (data) => listener({ data })),
}
