# 2026-07-12 REQ-094/095/096 视觉验收(S44)

> 真机 dev 实例(CDP 9222)取证,对应 jinjunnn/alpha-code#186 / #187 / #188。
> 演示 run 经真实 ArtifactService.registerDownloadedArtifact API 种入
> (job_visualdemo1:report.md + page.html,已验证态),取证后已清理。

- `50-workbench-open.png`:侧栏「产物」入口 → 产物工作台(run rail + 项目选择器 + 用量表)。
- `53-md-card.png`:run 选中 → 产物卡(已验证徽章/字节数)→ **markdown 渲染**
  (标题/表格/代码高亮,零 innerHTML 管线);**诚实离线横幅**「平台产物列表不可用——
  仅显示本地产物」;预览/源文/元数据三 tab;双层用量(项目 5 GiB/run 512 MiB 上限)。
- `55-html-open.png`:html 路由 → 隔离预览卡(「无脚本、无网络、无表单,与主应用零共享」)。
- `58-isolated-preview-window.png`:**隔离窗口本体**(独立 BrowserWindow,一次性 token
  自定义协议 `alpha-artifact-preview://<32hex>/page.html`)。**CSP 活性探针**:fixture
  内嵌 `<script>` 会把页面改写为红色「SCRIPT EXECUTED — CSP FAILED」——真机 DOM 探针
  返回 `red:false`,脚本被 CSP 拦截,内联样式(style-src 'unsafe-inline')正常渲染。
- IPC 探针:`htmlPreview.open` → `{ok:true, previewId:"hp_…"}`(renderer 仅拿 opaque id)。
