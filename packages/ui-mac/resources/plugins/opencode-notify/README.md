# vendored: opencode-notify@0.3.1(REQ-023 T2 离线资产通道)

- 来源:npm `opencode-notify@0.3.1`(MIT,社区插件)—— 文件 = 包内 `dist/index.js` 原样(其构建已内联唯一依赖 `detect-terminal`,满足 ADR-006 自包含要求,零改动)。
- **省略 `OpenCodeNotifier.app`**(224KB mach-o 原生通知器):未签名二进制进签名 Resources 会威胁公证;代码自带 osascript 回退,通知功能保留(样式降级为系统 AppleScript 通知)。
- 安装:主进程复制本目录 → `~/.alpha/plugins/opencode-notify/` → `plugin[]` 写 **绝对路径**(经 `~/.opencode/opencode.jsonc`)→ 引擎直接加载,**零网络**。npm@钉版仍是无 vendored 资产条目的 fallback。
- 升级:手动重新 `npm pack opencode-notify@<new>` 替换本文件并 bump catalog 钉版。
- 许可:MIT,见 resources/NOTICE.txt。
