/**
 * REQ-108(#244)—— 查看器的生产 IO(唯一与 window.api 对话的文件;files 面板的路径纪律
 * 不变:这里只递 workspace **相对**路径 + opaque id,绝对路径由 main 解析并圈禁)。
 */

import type {
  RailPreviewBounds,
  RailPreviewClosedEvent,
  RailPreviewKind,
  RailPreviewOpenResult,
  RailPreviewStatus,
} from "../../../../shared/file-viewer"
import type { FileViewerIO } from "./file-viewer-state"

export interface FileViewerOverlayIO {
  open: (path: string, kind: RailPreviewKind, bounds: RailPreviewBounds) => Promise<RailPreviewOpenResult>
  setBounds: (previewId: string, bounds: RailPreviewBounds) => void
  /** #1173:强模态期间让位(隐藏而非销毁 —— 模态关闭后原样恢复,用户不必重开文件)。 */
  setVisible: (previewId: string, visible: boolean) => void
  close: (previewId: string) => void
  status: (previewId: string) => Promise<RailPreviewStatus>
  onClosed: (cb: (event: RailPreviewClosedEvent) => void) => () => void
}

export function createFileViewerIO(directory: string): FileViewerIO {
  return {
    openRead: (path) => window.api.workspaceFile.openRead(directory, path),
    readChunk: (readId, offset, length) => window.api.workspaceFile.readChunk(readId, offset, length),
    closeRead: (readId) => void window.api.workspaceFile.closeRead(readId),
    openExternal: (path) => void window.api.workspaceFile.openExternal(directory, path),
    reveal: (path) => void window.api.workspaceFile.reveal(directory, path),
    saveCopy: (path) => void window.api.workspaceFile.saveCopy(directory, path),
  }
}

export function createFileViewerOverlayIO(directory: string): FileViewerOverlayIO {
  return {
    open: (path, kind, bounds) => window.api.railPreview.open(directory, path, kind, bounds),
    setBounds: (previewId, bounds) => void window.api.railPreview.setBounds(previewId, bounds),
    setVisible: (previewId, visible) => void window.api.railPreview.setVisible(previewId, visible),
    close: (previewId) => void window.api.railPreview.close(previewId),
    status: (previewId) => window.api.railPreview.status(previewId),
    onClosed: (cb) => window.api.railPreview.onClosed(cb),
  }
}
