---
title: D5 — C1/C3 正常网络下载源实测记录(真机)
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-22
review_after: 2027-01-16
---

# D5 正常网络两格实测(download-source cells)

真机:macOS(Darwin 25.3.0,arm64),node v22.22.3,npm 10.9.8,正常网络。
执行日期:2026-07-22。执行环境:主机直跑(非沙箱,有网络)。

**格子编号对照**:任务下发方把两格叫 "C1(默认内核)/C2(--browser chrome)";本文件同时标注 `verify.md` 矩阵原编号——默认内核×正常网络 = **C1**,`--browser chrome`×正常网络 = **C3**。弱网两格(verify.md 的 C2/C4)需 `sudo pfctl`,本次未执行,见文末。

隔离手法:所有下载被 `PLAYWRIGHT_BROWSERS_PATH` 指到 scratch 目录,**未动**用户真实缓存 `~/Library/Caches/ms-playwright`(其中既有 `chromium-1134` 等条目全程只读)。

---

## 首要发现(改写 `_verify` 前提)

**`_verify` 的断言「默认下载 Chromium(~150MB)」在本版本 + Chrome 已装的机器上不成立。**

实测:`@playwright/mcp@0.0.77` **不带任何 `--browser` 参数**时,首个 `browser_navigate` 直接启动**系统已装 Chrome**(`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`),**零内核下载**,3.3 秒返回真实页面(example.com 标题正确)。代码层面印证:该版 MCP 是 `playwright-core@1.62.0-alpha-2026-06-29` coreBundle 的薄壳,默认 channel 解析为 `channel ?? "chrome"`(coreBundle.js 内实测 grep 到 `channel = "chrome"` / `channel ?? "chrome"`)。

即:**默认行为 ≡ `--browser chrome`**。bundled Chromium 内核下载只发生在(a)显式走 `install-browser` / `npx playwright install chromium`,或(b)系统无 Chrome 时用户按报错指引安装。弱网风险面因此比 `_verify` 假设的小:Chrome 已装的机器上首个 navigate **不产生任何内核 egress**。

## CELL C1(verify.md C1)— 默认内核 × 正常网络

### Step A:空内核目录 + 首个 browser_navigate(缺内核行为)

```
PLAYWRIGHT_BROWSERS_PATH=<空 scratch 目录> node node_modules/@playwright/mcp/cli.js --headless
→ JSON-RPC: initialize → tools/call browser_navigate https://example.com
```

- 结果:**成功**,+3.3s 返回 `Page URL: https://example.com/ / Page Title: Example Domain`,`isError` 无。
- 原因:未走 bundled Chromium——`DEBUG=pw:browser` 复跑抓到启动命令行:executable = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,`--user-data-dir=~/Library/Caches/ms-playwright-mcp/mcp-chrome-e682f65`(该 profile 目录为本次运行新建,创建时间 06:15:41 与首跑时刻一致)。
- 空的 `PLAYWRIGHT_BROWSERS_PATH` 目录跑完仍为空 → 确证零下载。
- 日志:scratch `d5-c1/c1-step-a-missing-kernel.log`、`c1-step-a2-debug-launch.log`。

### Step B:bundled Chromium 内核真实下载(block-list 数据源)

命令(走 MCP 自己的安装路径;`cli.js` 把 `install-browser` 映射为 `playwright install`):

```
PLAYWRIGHT_BROWSERS_PATH=<新空目录> DEBUG=pw:install \
  node node_modules/@playwright/mcp/cli.js install-browser chromium
```

- **实测下载 URL(live 抓取,非猜测)**,三个产物全部来自 `cdn.playwright.dev`:

| 产物 | URL | 字节 | 下载耗时 |
| --- | --- | --- | --- |
| Chrome for Testing 150.0.7871.24(playwright chromium v1229) | `https://cdn.playwright.dev/builds/cft/150.0.7871.24/mac-arm64/chrome-mac-arm64.zip` | 180,912,374(172.5 MiB) | ≈175s |
| FFmpeg v1011 | `https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-mac-arm64.zip` | 1,097,141 | ≈2.4s |
| Chrome Headless Shell 150.0.7871.24(v1229) | `https://cdn.playwright.dev/builds/cft/150.0.7871.24/mac-arm64/chrome-headless-shell-mac-arm64.zip` | 98,934,987(94.4 MiB) | ≈44s |

- 内核身份:**Chrome for Testing** 构建(CfT),不是老式 `chromium-<rev>` snapshot;`_verify` 的「~150MB」实为 **~268 MB 下载 / 541 MB 落盘**(三产物合计,`du -sh` 实测)。
- 全程 HTTP 200,非 chunked;**总墙钟 3m43.55s**(`time` 实测,正常家用网络,~1 MB/s 高峰段)。exit=0。
- npm 包层(前置):`npm install @playwright/mcp@0.0.77` 3 个包 9s,来源 registry.npmjs.org。

### Step C:下载后的 bundled 内核可用性(补测)

`--browser chromium` 在 0.0.77 **被接受**(README 只列 chrome/firefox/webkit/msedge,但实测有效),且启动的正是刚下载的 kernel:`<PLAYWRIGHT_BROWSERS_PATH>/chromium-1229/chrome-mac-arm64/Google Chrome for Testing.app/…`,navigate +6.3s 成功。→ 下载产物即真实使用的内核,链路闭环。日志:`c1-step-c-bundled-chromium.log`。

**弱网阻断表派生(给 verify.md C2/C4)**:

| 层 | 实测主机 | 说明 |
| --- | --- | --- |
| npm 包层 | `registry.npmjs.org` | `npx -y @playwright/mcp@0.0.77` 首跑拉包 |
| 内核层 | `cdn.playwright.dev` | 唯一实测命中的内核下载主机(路径前缀 `/builds/cft/…`;代码内默认常量 `https://cdn.playwright.dev/dbazure/download/playwright` 亦指同主机) |

可用 `PLAYWRIGHT_DOWNLOAD_HOST` / `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST` 改内核源(coreBundle 支持,实测 grep 确认存在)。

## CELL C2(verify.md C3)— `--browser chrome` × 正常网络

```
PLAYWRIGHT_BROWSERS_PATH=<另一空目录> node node_modules/@playwright/mcp/cli.js --browser chrome --headless
→ browser_navigate https://example.com
```

- 结果:**成功**,+2.8s;`DEBUG=pw:browser` 抓到 executable 与默认跑**逐字节相同**:`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,同一 profile 目录。
- 空 browsers 目录跑完仍空 → **零下载,确证复用系统 Chrome**。
- 信任面注记(verify.md 类 C 修正):跑的是用户系统 Chrome **二进制**,但 **profile 是 MCP 专属新建的持久目录**(`~/Library/Caches/ms-playwright-mcp/mcp-chrome-<hash>`),**不是**用户日常 Chrome profile——用户已登录态/扩展不进 MCP 会话。信任面变化 = 二进制来源(Google 更新通道 vs playwright CDN),不是用户数据混用。
- 日志:scratch `d5-c1/c3-browser-chrome.log`。

### 系统无 Chrome 分支(代码勘破,未真机复现)

本机装有 Chrome,无法卸载复测。coreBundle 内失败路径为**响亮报错**:
`Chromium distribution 'chrome' is not found …`,并给出 `… install-browser <target>` 指引;无任何静默回退下载逻辑(coreBundle 中无自动装 channel 的代码路径)。→ 满足不变量 1/3 的**代码证据**,真机复现留给手工跑(可用无 Chrome 的干净账户/机器)。

## 不变量判定(正常网络两格)

| 不变量 | C1 | C3 | 依据 |
| --- | --- | --- | --- |
| 1 响亮失败 | 通过(代码级) | 通过(代码级) | 缺 channel 报 `distribution not found` + 安装指引;正常网络未触发失败态 |
| 2 可诊断 | 通过 | 通过 | `DEBUG=pw:install` 全程输出 URL/字节/状态码;`pw:browser` 输出完整启动命令行 |
| 3 绝不假成功 | 通过 | 通过 | navigate 返回真实页面标题;无空壳成功 |
| 4 预检文案诚实 | **不足** | **不足** | 详情页只显 node ✓;且 `_verify` 本身对默认行为的描述已过时(见首要发现) |

## 遗留给真机手工跑(需要 sudo,本次未执行)

verify.md 的 **C2/C4(弱网/中国区两格)**:需 `sudo pfctl` 封锁上表两主机(`cdn.playwright.dev`、必要时 `registry.npmjs.org`)出站,先按 verify.md 的 block-bites precheck 用 `curl` 探针确认阻断咬住,再复跑两格。另:**系统无 Chrome 的失败态真机复现**(C3/C4 的无 Chrome 分支)也未做,需无 Chrome 环境。

## PREFLIGHT-COPY 输入(给 CODE 子票的实测结论)

- 「内核在首次使用时下载」的文案前提**只对无 Chrome 的机器成立**;Chrome 已装机器默认零下载。诚实文案应写成:默认复用系统已装 Chrome;若系统没有 Chrome,首次使用前需一次约 270 MB 的浏览器内核下载(三个产物,来源 cdn.playwright.dev,落盘约 541 MB),网络受限时可能较慢或失败。
- `installSpec` confirm-as-is:command/runtimeDep 无需变更(与实测一致)。
- `_verify`(`alpha-catalog.json` mcp:playwright 条目)措辞需按「首要发现」改写:默认 = 系统 Chrome channel,非 bundled Chromium。
