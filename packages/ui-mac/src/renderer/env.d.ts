// `window.api` 在 ui-mac 的 program 里被声明**两遍**,两份互不兼容(#932):
//   ① 本文件:`api: ElectronAPI`(alpha 自己的完整面,renderer 有 160+ 个使用点);
//   ② 上游 `packages/app/src/app.tsx`(经项目引用产出的 `.ts-dist/src/app.d.ts`):
//      `api?: { setTitlebar?; exportDebugLogs? }` —— 极简且整枝可选。
// 两处都是 `.d.ts`,`skipLibCheck: true` 把本该报在声明处的 TS2717 一起吞掉 ⇒ **没有任何红**,
// 而合并后 `Window["api"]` 取的是**先进 program 的那一份**。实测(2026-08-11,见 PR):
// 任何在本文件之前进入 program 的文件只要 import 到 `@opencode-ai/app` 的根出口(app.tsx 在其
// 传递依赖里),上游那份就抢先赢下 ⇒ renderer 侧 `window.api.*` 当场 **381 条 error TS**,
// 而它们与肇事改动毫无关系 —— 看起来像「你把代码改坏了」。
//
// 修法:`tsconfig.json` 的 `files` 把本文件钉成 rootNames 的第一条(`files` 排在 `include`
// 展开之前),于是 alpha 这份恒定先进 program,谁 import 上游都不再翻转天平。
// 兜底判据不在这里(`.d.ts` 里的错会被 skipLibCheck 吞掉,写在这里等于没写):
// 见 `src/main/tabs-preclean-contract.ts` —— 它在 `src/main` 侧真的 import 了上游根出口,
// 并断言 `Window["api"]` 仍解析成 `ElectronAPI`。把上面那行 `files` 删掉,那三条断言当场红。
import type { ElectronAPI } from "../preload/types"

declare global {
  interface Window {
    api: ElectronAPI
  }
}
