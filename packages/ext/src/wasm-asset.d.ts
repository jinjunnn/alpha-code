// Bun 的 `import x from "*.wasm" with { type: "file" }`:值是该资源在磁盘上的路径 ——
// `bun test` 里是源包里的绝对路径,`Bun.build` 之后是相对 bundle 的路径(资源被复制到 outdir)。
// 引擎侧同一写法见 packages/opencode/src/audio.d.ts;ext 是自包含 bundle(ADR-006),声明得自己带一份。
declare module "*.wasm" {
  const path: string
  export default path
}
