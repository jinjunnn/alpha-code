// 三个路由叶(home / newSession / session)的共享身份。REQ-089 硬切之后**只有一种组合**:
// 每个 surface 恒为 Alpha 自有叶 —— 没有 legacy 发布态,没有 env / pin 覆盖,也没有崩溃回退开关
// (致命渲染错误进 Alpha Recovery,绝不改变 composition)。该 id 现在唯一的职责是给
// SurfaceBoundary 与失败诊断记录一个稳定名字。
// Pure constants only — NO electron/node imports — so both the main and renderer bundles can
// import this module(镜像 shared/alpha-config.ts 的跨 bundle 模式)。

export type SurfaceId = "home" | "newSession" | "session"
