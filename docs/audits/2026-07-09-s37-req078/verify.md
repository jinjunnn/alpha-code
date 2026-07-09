# S37 / REQ-078 验证记录(dev 渠道 CDP,2026-07-09)

环境:`bun run dev`(vite 5173 新鲜 bundle,CDP 9222),工作区 = alpha-code 仓(有真实 git 变更)。

## 断言(CDP evaluate,DOM 级)

1. **home @ 弹窗**(`req078-home-at.png`):
   - 添加节 = `添加附件(选择图片 / PDF 作为附件)` + `计划模式` —— **无终端死行**(T1);
   - AGENT 节 @general/@explore 照旧;
   - 文件节零查询钉出 **10 条本仓 git 变更文件**(hint「git 变更文件 · 输入 @关键词 搜索全部项目文件」,T3);footer 15 项。
2. **附件真通道**(`req078-attach-chip.png`):合成 ClipboardEvent 粘贴 1×1 PNG → chip `screenshot.png ×` 带缩略图(thumbs=1),输入文字共存(T2)。
3. **诚实拒绝**(`req078-attach-reject.png`):粘贴 `notes.txt(text/plain)` → toast「部分附件未添加 / notes.txt:仅支持图片(PNG/JPEG/GIF/WebP)与 PDF;项目内文件请用 @ 引用」,chip 数不变(C28)。
4. **移除**:点 chip × → chips 0。

## 实现关键发现(端点选型改道)

- 上游 `/file/status` 是**恒返 `[]` 的存根**(`packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts:127-129`,SDK 有形、引擎无实,dev fetch 插桩实证 200+`[]`);真实现 = `/vcs/status`(`handlers/instance.ts:47-49` → `Vcs.Service`,裸 curl 401 = 有鉴权,app 内 SDK client 正常)。T3 已改走 `vcs.status`,实测钉出真实变更文件。

## 残单(→ 真机批)

- session 表面像素(dev 数据无既有会话,发消息会真跑模型于本仓,不做):终端行 gating 与文案已单测锁定(`terminal:true` → `打开终端` + 「输出不会自动进入上下文」),AlphaComposer 传 `surface: props.mode` 一行接线;
- 附件**真实发送**(engine 收 dataUrl part → 模型可见):part 形状与上游 images 通道逐字段一致(单测锁),端到端归真机批;
- 拖拽 hover 虚线态(合成 DragEvent 带 files 受限,逻辑与 paste 同一 addFiles 通道)。
