// REQ-096(alpha-code#188)—— HTML artifact 隔离预览的公开接缝(Workbench 注册表接线点,
// 由 orchestrator 在 REQ-094 registry 落定后集成):
//   · ArtifactHtmlPreview —— 薄控制组件(经窄 IPC 请求 main 打开隔离预览窗口;零字节、零 iframe);
//   · canPreviewHtml —— 能力判定(注册表据此决定是否给 descriptor 挂本 renderer)。

export { ArtifactHtmlPreview, type ArtifactHtmlPreviewProps } from "./ArtifactHtmlPreview"
export { canPreviewHtml } from "../../../shared/html-preview"
