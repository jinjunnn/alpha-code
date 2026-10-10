# REQ-229 / REQ-230 界面截图对照已批设计稿(L2 机器截图)

- 需求:REQ-229(#1471)工作过程折叠 · REQ-230(#1472)弹出层收成四种
- 已批稿:[`docs/design/2026-10-10-timeline-process-fold/frame.html`](../../design/2026-10-10-timeline-process-fold/frame.html)(§①–⑦)
- 代码基线:`alpha` @ `b48e8ee`(v0.1.18 之后)
- 采集日期:2026-10-10

## 证据是怎么来的(以及它不是什么)

- **挂的是生产组件**:`SessionTimelineView`(内含 `ProcessRow` 工作过程)、`PermissionDialog`、
  `AlphaComposerRuntime`(含权限 / 模型 / 思考强度芯片菜单)、`ToastViewport`、`Tooltip`,
  CSS 是组件自己 import 的那几份(`session-timeline.css`、`cards.css`、`permission-dialog.css`、
  `alpha-composer.css`、`tooltip.css` …)加上生产 `index.tsx` 全局在场的 `home.css` / `composer-reskin.css`。
- **只桩了数据与 IPC**:消息 / part 夹具(18 步研究回合沿用 `test-component/process-fold.fixture.ts`,
  与 `process-fold.test.ts` 同一份)、`window.api`(沿用 `test-component/preload-stub.ts`)、模型目录
  (`src/main/alpha-models.json`)、`ModelContract`、`useCommand`。行投影走生产 `projectTimelineRows`。
- **harness**:[`packages/ui-mac/test-visual/`](../../../packages/ui-mac/test-visual/)(Vite + vite-plugin-solid,
  不在 `src/` 下,不进 `bun test src`)。重跑:`cd packages/ui-mac && bun test-visual/capture.ts`。
- **截图**:headless Chromium(Playwright,`/opt/pw-browsers/chromium-1194`),1280 宽,`locale=zh-CN`,
  浅色;多数场景另截深色(`data-color-scheme="dark"`)。已批帧 `frame.html` 各节同一浏览器、同一宽度截图。
- **它不是**:打包后的 Electron app 真机截图(L3)。字体是 Linux 容器里的回退字体,与 macOS 不同;
  会话页外层布局(侧栏、顶栏、右栏)不在 harness 里,时间线与输入框按会话页的上下关系摆放。
  控制台唯一报错是首屏一次 404(页面图标),与组件无关。

文件命名:`shots/app-<场景>-<light|dark>.png` 是生产组件;`shots/frame-<节>-<light|dark>.png` 是已批稿。

## 逐条对照

结论用三档:**一致** / **一致,有细节偏差**(偏差逐条列出) / **不一致**。

### REQ-229(#1471)

| AC | 生产截图 | 已批帧 | 结论 |
| --- | --- | --- | --- |
| AC1 回答前一行摘要 | `app-fold-collapsed-{light,dark}.png` | `frame-compare-light.png`(右栏) | 一致,有细节偏差 ① |
| AC2 每步一行 / 合并 / 再点看详情 | `app-fold-expanded-*.png`、`app-fold-search-detail-light.png`、`app-fold-step-detail-*.png` | `frame-expand-light.png` | 一致,有细节偏差 ②③④ |
| AC3 成功不挂状态,行尾三种 | 同上 | `frame-expand-light.png`、`frame-steps-light.png` | 一致(结束态);进行中见 ⑤ |
| AC4 进行中 | `app-live-running-*.png`、`app-live-waiting-*.png` | `frame-live-light.png` | 一致,有细节偏差 ⑤⑥ |
| AC5 第三方 / 插件来源 | `app-provenance-light.png` | `frame-steps-light.png`「不是我们的工具」 | 一致,有细节偏差 ⑦ |
| AC6 答完的提问 / 审批超时 | 未截 | `frame-steps-light.png` | **未覆盖**(见文末) |

**一致的部分**(截图里能直接看到):

- 收起态只有一行:「搜索 16 次 · 2 步没成功 · 3 分 27 秒」,琥珀色只用在不顺之处;回答与脚注在外面。
- 展开后正好 12 行,顺序与帧 ② 左栏逐行相同:思考 6 段、搜索 4/2/4/4/2、打开网页 2 次合成一行;
  只有那组 2 分多钟的搜索在行尾写「2 分 15 秒」,其余成功步骤行尾为空。
- 合并行先展开成每项一行,再点一项看正文;搜索的详情是结果列表(标题 + 域名),和帧 ② 右栏同一形态。
- 进行中:标题「正在搜索 4 个问题 · 第 4 步 · 3:27」带脉冲点;更早的步骤收成「前面还有 1 步」;
  正在跑的每一步单独一行各自转圈;超过 10 秒的写「已等 2:10 / 2:08」。思考没有露出原文。
- 等你批准:标题整块换成琥珀色、带暂停图标,等的那一步(运行 `rm -rf dist && bun run build`)同色高亮,
  行尾「等你批准」——与帧 ③「等你批准」格同形。
- 第三方 MCP 行是「插头 + notion + search_pages」,插件行是「拼图 + acme-lint + lint_fix」;
  同屏的我方「读取」「打开网页」行不带服务名、不带插头 / 拼图图标;第三方行没有显示输入输出。
- 深色主题下上述各帧配色正常,琥珀 / 强调色都有对应的深色值。

**偏差(逐条)**:

1. **摘要里的失败措辞**:生产写「2 步没成功」,帧写「2 个网页没打开」。生产的组件测试
   (`process-fold.fixture.ts` 头注释)就按「2 步没成功」断言,所以这是实现与帧的有意或无意分叉,需要 owner 定哪个算准。
2. **合并失败行的行尾**:生产「都没成功」,帧「都没打开」;展开后的单项行尾生产「没打开」,帧「连不上这个网站」。
3. **失败步骤的详情**:帧是「先人话原因(连不上这个网站),原始报错放在底部一行,带『复制』」;
   生产仍是旧卡片正文——红色「工具执行失败」标题 + 红色原始报错 `Transport error (GET …)` 占正文,
   底部「开发者详情」。设计稿 §2「失败的详情先给人话原因,原始报错放在底部一行,可复制」**未实现**。
   (`app-fold-step-detail-light.png` 对 `frame-expand-light.png` 右下。)
4. **步骤行的对象样式**:生产对象一律等宽字体、显示第一项全文;帧是正文字体、超长省略,合并的打开网页行写
   「docs.typesafe.ai/api · docs.typesafe.ai/primi…」两项。思考行生产附带了模型给的小标题
   「Planning the lookup」,帧该格没有——设计 §2 允许附小标题,属夹具差异,不算偏差。
   云端搜索步骤生产用云图标,帧用地球图标(帧的「今天」栏才有云徽标);设计 §6 只规定「不带服务名」,图标选择需确认。
5. **进行中、未满 10 秒的步骤**:生产行尾写「运行中」+ 转圈;帧 ③「工具在跑」格只有行首转圈、行尾为空。
   设计 §3 只规定超过 10 秒写「已等」,没写 10 秒内要不要「运行中」二字。
6. **等你面的文案**:生产标题「等待你的决定 · 生成已暂停,到审批窗口里选择」;帧「等你批准 · 在下方输入框里批准或拒绝」。
   后半句生产的说法与 owner 后来改定的批准位置(全局面板)一致,帧这半句已过时;但前半句「等你批准」与
   AC4 原文「标题变为琥珀色的等你面」/ 设计 §3「标题换成琥珀色『等你批准』」字面不一致。
7. **第三方工具进摘要时用的是技术名**:收起摘要写「search_pages 1 次 · lint_fix 1 次 · 读取 1 次」——
   第三方工具名原样进了摘要,并且数到 1 也写「1 次」。帧里没有含第三方工具的摘要样例,无法判定对错,列出待定。

### REQ-230(#1472)

| AC | 生产截图 | 已批帧 | 结论 |
| --- | --- | --- | --- |
| AC1 菜单一套外观 | `app-menu-perm-*.png`、`app-menu-model-*.png` | `frame-overlays-light.png` ② | 一致,有细节偏差 ⑧ |
| AC2 提示一种外观 | `app-toast-tooltip-light.png`(左下) | `frame-overlays-light.png` ① | **不一致** ⑨ |
| AC3 通知一套 | `app-toast-tooltip-light.png`(右下) | `frame-overlays-light.png` ④ | 一致 |
| AC4 批准面板不遮时间线 | `app-approval-{light,dark}.png` + 下方 DOM 事实 | `frame-overlays-light.png` ③ | 位置与行为一致;外观不一致 ⑩ |

**一致的部分**:

- 权限菜单与模型菜单都是同一种浮层(同底色、同圆角、同阴影),朝上开在芯片上方,浮在时间线之上而不是被裁剪。
- 通知右下角一套:成功一条带绿点、错误一条带红点,各自带关闭按钮,版式与帧 ④ 同形;
  错误通知 DOM 为 `role="alert"`、`aria-live="assertive"`、`data-persistent="true"`(不自动消失、立即朗读)。
- 批准面板(采集脚本在浅色场景里读 DOM,原始输出见 `capture-log.txt`):
  - `data-anchored="composer"`,面板底边 730px、输入框顶边 742px —— 停在输入框之上;
  - 全页 `[inert]` 0 个、`[aria-modal="true"]` 0 个,时间线顶部那一点 `elementFromPoint` 命中的是时间线 —— 没有遮罩、没有冻结;
  - 时间线滚动容器仍可滚动;
  - 焦点落在「允许一次」。
  - 时间线上方同时显示琥珀色等你面,两者同屏不冲突。

**偏差(逐条)**:

8. **菜单选中态**:帧在选中项前打勾(✓ 请求审批);生产不打勾,选中项改用强调色文字,并给三档各配了盾牌图标。
9. **悬停提示在 harness 里是一块看不见字的黑条**:悬停「+」按钮后出现的 `.a-tip`(文案「装配:引用 · 附加 · 模式…」)
   计算样式为 `background` 与 `color` 同为 `rgb(24,24,27)`。原因是同权重的两条规则:`tooltip.css` 的
   `.a-tip { color: var(--a-bg-canvas) }` 与 `base.css` 的 `.a-ui { color: var(--a-text) }`(提示元素同时带 `a-ui` 类),
   谁后出现谁赢;多份组件 CSS 各自 `@import "./base.css"`,打包后 base 的 `.a-ui` 很可能排在 tooltip 之后。
   **这一条依赖 CSS 合并顺序,本次没有在打包版 app 上复核**,但生产组件 + 生产 CSS 在本 harness 里确实复现,建议真机看一眼。
   另外帧 ① 的提示带快捷键(「复制回答 ⌘C」)、「已复制」反馈与「为什么不能点」的可见说明,本次都没有截到。
10. **批准面板的外观与帧 ③ 差距大**:
    - 帧:一张紧凑卡片,琥珀色边框,暂停图标 +「允许这次操作吗?」,一句人话说明(「运行命令(删除 dist 目录后重新构建)」)、
      一个命令块,三个按钮右对齐「拒绝 / 始终允许 / 允许一次」。
    - 生产:约 460px 高的大卡,中性边框、时钟图标;五项事实各占一块,标签是英文大写开发术语
      「ACTION / CAPABILITY」「RESOURCES」「SCOPE」「EXPIRY」;有效期显示 ISO 时间串与毫秒时间戳 `1791630934272`;
      底部说明含 `grantExpiresAt = null`;「拒绝」单独靠左。
    - AC4 要求「五项事实全显示」,生产做到了;但「外观与模型提问卡同族」与帧 ③ 的样子没有做到,
      且 CLAUDE.md 前端纪律写明「UI 文案禁开发术语」。

## 本次没有覆盖的

- REQ-229 AC6(答完的提问写出问题和选择、审批超时人话):未构造夹具,无截图。
- 帧 ④ 结束态(回合失败、被打断、只有产物、只思考)与帧 ⑤ 中大部分工具类别(编辑、写入、子任务、云端任务等)。
- 「回答开始输出即收成一行」「过渡话移入工作过程」这类**过程**,截图只能拍静态帧,由组件测试覆盖。
- REQ-230 AC1 的键盘行为(上下键、Esc 还焦点、同时只开一个)与 AC3 的计时行为:截图证明不了,由组件测试覆盖。
- 「+ / @」补全列表没有截图。
- 打包版 Electron 真机(L3)。

## 文件清单

- `shots/app-*.png`:生产组件,19 张(11 个场景,其中 8 个另有深色)
- `shots/frame-*.png`:已批帧 7 节 × 浅 / 深色,14 张(其中 `frame-rules-*` 为 §⑦ 收纳规则,仅供参照)
- `capture-log.txt`:采集脚本输出(每张图的控制台错误、批准面板 DOM 事实)
