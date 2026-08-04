# 真实 Claude 插件语料的组件规模(勘破)

ADR-040 把 **Bundle** 定成扩展安装的唯一形状,于是「一个真实插件会变成几个组件」
成了一条承重数字 —— 信封的组件上限直接照它定。这份文档记录**那个数字是怎么量出来的**:
用的哪把尺子、量的是哪一堆东西、哪些东西**故意没量**,以及这个数在什么条件下会翻倍。

> 散文断言不算勘破。下面每个数都能用两条互相独立的路径复算,方法写在 §6。

## 1. 先说结论

| 问题 | 答案 |
| --- | --- |
| 组件数**超过 16** 的插件 | **0 / 62** |
| **最大**组件数 | **13**(`claude-for-financial-services/.../financial-analysis`) |
| **中位数** | **2** |
| 合计组件 | 221 = 159 skill + 43 agent + 10 mcp-local + 9 mcp-remote |

⚠️ **「0/62」比它看上去脆弱得多。** 最大的那个插件的 `.mcp.json` **不是合法 JSON**
(少一个逗号、少一个右括号),所以它今天按 0 个 server 计。那份文件的字节里躺着
**12 个 https server**;文件一旦修好,这个插件就是 `13 + 12 = 25` 个组件 —— 直接越过 16。
拿「最大 13」去定界而不知道这一条,定的是一个**偶然值**。详见 §5。

## 2. 口径(v1)—— 这是本文最重要的一节

**今天合法的 profile 只有四个**:`skill` / `agent` / `mcp-local` / `mcp-remote`
(见 `packages/ui-mac/src/shared/host-extension-package-contract/profiles/`)。
组件数**只数这四个**:

| 组件 | 从哪来 |
| --- | --- |
| `skill` | `<插件根>/skills/<名字>/SKILL.md`,一个目录一个 |
| `agent` | `<插件根>/agents/**/*.md`,一个文件一个 |
| `mcp-local` | `<插件根>/.mcp.json` 里**声明了 `command`** 的每一个 server |
| `mcp-remote` | `<插件根>/.mcp.json` 里**声明了 `url`** 的每一个 server |

**一个 `.mcp.json` 里的每个 server 各算一个组件**,不是整份算一个。

**故意不计入**(今天没有任何 profile 描述得了它们):

| 种类 | 实测规模 | 为什么不计入 |
| --- | --- | --- |
| `commands/**` | 22 个插件 / 100 个文件 | 没有 profile。把它算进组件数,会得出一个**没有对应现实**的数 |
| `hooks/**` | 12 个插件 / 31 个文件 | 引擎里根本不存在这个概念 |
| 非标准布局的 `SKILL.md` | 1 个(`.claude/skills/verify/SKILL.md`) | 不在 `skills/<名字>/` 下,本地 intake 也把它当不支持布局具名拒绝 |

**统计口径**:62 个插件 = 语料里含 `.claude-plugin/plugin.json` 的目录。
语料里另有 **2 个无清单插件**(`receipts`、`session-report`,各 1 个 skill),
不在这 62 个里 —— 加上它们,三个数一个都不变。

## 3. 分布

```
组件数:  0  1  2  3  4  5  6  7  8  9 10 12 13
插件数:  8 20  4  6  4  3  5  2  2  3  2  2  1
                                              ↑ 上限 16 在这条线右边,今天没有插件越过
```

最大的十个:

| 插件 | skill | agent | mcp-local | mcp-remote | 组件数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `claude-for-financial-services/plugins/vertical-plugins/financial-analysis` | 13 | 0 | 0 | 0 | **13** |
| `claude-for-financial-services/plugins/agent-plugins/pitch-agent` | 11 | 1 | 0 | 0 | **12** |
| `tide-plugin` | 10 | 1 | 0 | 1 | **12** |
| `claude-for-financial-services/plugins/vertical-plugins/private-equity` | 10 | 0 | 0 | 0 | **10** |
| `claude-plugins-official/plugins/plugin-dev` | 7 | 3 | 0 | 0 | **10** |
| `claude-for-financial-services/plugins/partner-built/lseg` | 8 | 0 | 0 | 1 | **9** |
| `claude-for-financial-services/plugins/vertical-plugins/equity-research` | 9 | 0 | 0 | 0 | **9** |
| `claude-for-financial-services/plugins/vertical-plugins/investment-banking` | 9 | 0 | 0 | 0 | **9** |
| `claude-plugins-official/plugins/claude-security` | 1 | 7 | 0 | 0 | **8** |
| `claude-plugins-official/plugins/code-modernization` | 0 | 8 | 0 | 0 | **8** |

全部 62 行见 §7。

## 4. `.mcp.json` 的真实形状(只有留下字节才看得见)

语料里 22 份 `.mcp.json`,合计 3704 字节,声明 **19 个 server**。它们**不是同一种摆法**:

| 摆法 | 份数 | 长什么样 |
| --- | ---: | --- |
| 有 `mcpServers` 包裹层 | **9** | `{"mcpServers": {"tide": {...}}}` |
| **没有包裹层**,server 直接摆顶层 | **12** | `{"linear": {"type":"http","url":"..."}}` |
| **不是合法 JSON** | **1** | 见 §5 |

⇒ **只读 `mcpServers` 键的实现,在这份语料上会把 19 个 server 数成 7 个。**
这不是理论风险 —— 不带包裹层的那 12 份是**多数形状**,而且全部来自
`claude-plugins-official/external_plugins/`(官方仓库自己的 plugin)。

另外:9 份带包裹层的里有 **2 份是空的** `{"mcpServers":{}}`
(`investment-banking`、`private-equity`)—— 有这个文件不等于有 server。

19 个 server 全部逐个点名(名字 + profile 归类)钉在
`packages/ui-mac/src/main/claude-plugin-corpus-census.test.ts` 的 G2 里。

## 5. 那份不是合法 JSON 的 `.mcp.json`

`claude-for-financial-services/plugins/vertical-plugins/financial-analysis/.mcp.json`
(1172 字节)在第 46/47 行缺一个逗号,并少一个右括号:

```
     46|     }
     47|     "box": {
     48|       "type": "http",
     49|       "url": "https://mcp.box.com"
     50|   }
```

处置:**不猜它想声明什么**(猜就是替别人写文法),按 **0 个 server** 计,并具名登记在这里。

它的字节里有 **12 个 `"url": "https://…"`**。这个插件本身有 13 个 skill,所以:

- 今天(文件坏着):**13 个组件**,是全语料最大值;
- 上游修好那个逗号之后:**25 个组件**,直接越过 16。

**「0/62 超过 16」这句话的有效期,取决于第三方什么时候修一个语法错误。**
任何拿这三个数定界的决定,都必须显式回答「25 怎么办」。

## 6. 怎么复算(两条独立的路径)

数字必须能被一条**不读被测对象**的路径复核,否则就是自指等价链。

**轴一(仓内,自动)** —— `packages/ui-mac/src/main/claude-plugin-corpus-census.test.ts`:
把仓内语料夹具摊成真目录,从**目录树**里数(不是从夹具 JSON 的字段里数),
断言本文所有数字。它同时钉住 22 份 `.mcp.json` 的**字节聚合 sha256**,
所以「字节被降级成只剩 size/mode」当场变红。

**轴二(仓外,手动)** —— 直接对着 `~/.claude/plugins/marketplaces` 用另一种语言数一遍:

```python
# 计四类组件;每个 mcp server 算一个;commands/hooks 单列不计入
skills  = len(glob(f"{root}/skills/*/SKILL.md"))
agents  = len(glob(f"{root}/agents/**/*.md", recursive=True))
doc     = json.load(open(f"{root}/.mcp.json"))          # 不存在/不合法 => 0
servers = doc["mcpServers"] if isinstance(doc.get("mcpServers"), dict) else doc
```

轴一的期望值**就是**轴二算出来的值(包括那个聚合 sha256),两轴独立取得、事后比对一致。

**语料本身怎么来的**:`packages/ui-mac/scripts/gen-claude-plugin-corpus-fixture.ts`
把 `~/.claude/plugins/marketplaces`(排除 `*.bak`)导出成
`packages/ui-mac/test-fixtures/claude-plugin-corpus.json`。
`SKILL.md` / `plugin.json` / `.mcp.json` **逐字保留**(并做 UTF-8 往返校验,失真即停),
其余文件只留 `size` + `mode`。**在这份语料上量任何数之前,先读 §9** —— 那里写清楚
哪一格的字节是真的、哪一格是假的,以及各自会让什么数字失真。

## 7. 附录:逐插件明细(62 行)

「旧口径」= skill + agent + commands 文件数 + hooks 文件数 + (有 `.mcp.json` 则 +1)。
它就是先前登记的「7/62 超过 16、最大 22」那个口径 —— 列在这里是为了让两个口径**可对照**,
不是为了让它们**可互换**:它把今天没有 profile 的种类算成了组件。

| 插件 | skill | agent | mcp-local | mcp-remote | **组件数** | commands | hooks | 旧口径 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `claude-for-financial-services/plugins/vertical-plugins/financial-analysis` | 13 | 0 | 0 | 0 | **13** | 7 | 1 | 22 |
| `claude-for-financial-services/plugins/agent-plugins/pitch-agent` | 11 | 1 | 0 | 0 | **12** | 0 | 0 | 12 |
| `tide-plugin` | 10 | 1 | 0 | 1 | **12** | 9 | 0 | 21 |
| `claude-for-financial-services/plugins/vertical-plugins/private-equity` | 10 | 0 | 0 | 0 | **10** | 10 | 1 | 22 |
| `claude-plugins-official/plugins/plugin-dev` | 7 | 3 | 0 | 0 | **10** | 1 | 0 | 11 |
| `claude-for-financial-services/plugins/partner-built/lseg` | 8 | 0 | 0 | 1 | **9** | 8 | 0 | 17 |
| `claude-for-financial-services/plugins/vertical-plugins/equity-research` | 9 | 0 | 0 | 0 | **9** | 9 | 1 | 19 |
| `claude-for-financial-services/plugins/vertical-plugins/investment-banking` | 9 | 0 | 0 | 0 | **9** | 7 | 1 | 18 |
| `claude-plugins-official/plugins/claude-security` | 1 | 7 | 0 | 0 | **8** | 0 | 3 | 11 |
| `claude-plugins-official/plugins/code-modernization` | 0 | 8 | 0 | 0 | **8** | 10 | 0 | 18 |
| `claude-for-financial-services/plugins/agent-plugins/earnings-reviewer` | 6 | 1 | 0 | 0 | **7** | 0 | 0 | 7 |
| `claude-for-financial-services/plugins/agent-plugins/model-builder` | 6 | 1 | 0 | 0 | **7** | 0 | 0 | 7 |
| `claude-for-financial-services/plugins/agent-plugins/market-researcher` | 5 | 1 | 0 | 0 | **6** | 0 | 0 | 6 |
| `claude-for-financial-services/plugins/agent-plugins/month-end-closer` | 5 | 1 | 0 | 0 | **6** | 0 | 0 | 6 |
| `claude-for-financial-services/plugins/vertical-plugins/fund-admin` | 6 | 0 | 0 | 0 | **6** | 0 | 0 | 6 |
| `claude-for-financial-services/plugins/vertical-plugins/wealth-management` | 6 | 0 | 0 | 0 | **6** | 6 | 1 | 13 |
| `claude-plugins-official/plugins/pr-review-toolkit` | 0 | 6 | 0 | 0 | **6** | 1 | 0 | 7 |
| `claude-for-financial-services/plugins/agent-plugins/gl-reconciler` | 4 | 1 | 0 | 0 | **5** | 0 | 0 | 5 |
| `claude-for-financial-services/plugins/agent-plugins/meeting-prep-agent` | 4 | 1 | 0 | 0 | **5** | 0 | 0 | 5 |
| `claude-for-financial-services/plugins/agent-plugins/valuation-reviewer` | 4 | 1 | 0 | 0 | **5** | 0 | 0 | 5 |
| `claude-for-financial-services/plugins/agent-plugins/kyc-screener` | 3 | 1 | 0 | 0 | **4** | 0 | 0 | 4 |
| `claude-for-financial-services/plugins/agent-plugins/statement-auditor` | 3 | 1 | 0 | 0 | **4** | 0 | 0 | 4 |
| `claude-for-financial-services/plugins/partner-built/spglobal` | 3 | 0 | 0 | 1 | **4** | 0 | 0 | 4 |
| `openai-codex/plugins/codex` | 3 | 1 | 0 | 0 | **4** | 7 | 1 | 12 |
| `claude-plugins-official/external_plugins/discord` | 2 | 0 | 1 | 0 | **3** | 0 | 0 | 3 |
| `claude-plugins-official/external_plugins/imessage` | 2 | 0 | 1 | 0 | **3** | 0 | 0 | 3 |
| `claude-plugins-official/external_plugins/telegram` | 2 | 0 | 1 | 0 | **3** | 0 | 0 | 3 |
| `claude-plugins-official/plugins/example-plugin` | 2 | 0 | 0 | 1 | **3** | 1 | 0 | 4 |
| `claude-plugins-official/plugins/feature-dev` | 0 | 3 | 0 | 0 | **3** | 1 | 0 | 4 |
| `claude-plugins-official/plugins/mcp-server-dev` | 3 | 0 | 0 | 0 | **3** | 0 | 0 | 3 |
| `claude-for-financial-services/plugins/vertical-plugins/operations` | 2 | 0 | 0 | 0 | **2** | 0 | 0 | 2 |
| `claude-plugins-official/plugins/agent-sdk-dev` | 0 | 2 | 0 | 0 | **2** | 1 | 0 | 3 |
| `claude-plugins-official/plugins/cwc-makers` | 2 | 0 | 0 | 0 | **2** | 1 | 0 | 3 |
| `claude-plugins-official/plugins/hookify` | 1 | 1 | 0 | 0 | **2** | 4 | 6 | 12 |
| `claude-plugins-official/external_plugins/asana` | 0 | 0 | 0 | 1 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/external_plugins/context7` | 0 | 0 | 1 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/external_plugins/fakechat` | 0 | 0 | 1 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/external_plugins/firebase` | 0 | 0 | 1 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/external_plugins/github` | 0 | 0 | 0 | 1 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/external_plugins/gitlab` | 0 | 0 | 0 | 1 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/external_plugins/greptile` | 0 | 0 | 0 | 1 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/external_plugins/laravel-boost` | 0 | 0 | 1 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/external_plugins/linear` | 0 | 0 | 0 | 1 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/external_plugins/playwright` | 0 | 0 | 1 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/external_plugins/serena` | 0 | 0 | 1 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/external_plugins/terraform` | 0 | 0 | 1 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/plugins/claude-code-setup` | 1 | 0 | 0 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/plugins/claude-md-management` | 1 | 0 | 0 | 0 | **1** | 1 | 0 | 2 |
| `claude-plugins-official/plugins/code-simplifier` | 0 | 1 | 0 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/plugins/frontend-design` | 1 | 0 | 0 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/plugins/math-olympiad` | 1 | 0 | 0 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/plugins/playground` | 1 | 0 | 0 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/plugins/project-artifact` | 1 | 0 | 0 | 0 | **1** | 0 | 0 | 1 |
| `claude-plugins-official/plugins/skill-creator` | 1 | 0 | 0 | 0 | **1** | 0 | 0 | 1 |
| `claude-for-financial-services/claude-for-msft-365-install` | 0 | 0 | 0 | 0 | **0** | 8 | 0 | 8 |
| `claude-plugins-official/plugins/code-review` | 0 | 0 | 0 | 0 | **0** | 1 | 0 | 1 |
| `claude-plugins-official/plugins/commit-commands` | 0 | 0 | 0 | 0 | **0** | 3 | 0 | 3 |
| `claude-plugins-official/plugins/explanatory-output-style` | 0 | 0 | 0 | 0 | **0** | 0 | 1 | 1 |
| `claude-plugins-official/plugins/learning-output-style` | 0 | 0 | 0 | 0 | **0** | 0 | 1 | 1 |
| `claude-plugins-official/plugins/mcp-tunnels` | 0 | 0 | 0 | 0 | **0** | 1 | 0 | 1 |
| `claude-plugins-official/plugins/ralph-loop` | 0 | 0 | 0 | 0 | **0** | 3 | 2 | 5 |
| `claude-plugins-official/plugins/security-guidance` | 0 | 0 | 0 | 0 | **0** | 0 | 12 | 12 |

**8 个插件今天是 0 个组件** —— 它们不含任何四个合法 profile 描述得了的东西:
七个只有 `commands` 和/或 `hooks`,第八个(`claude-for-msft-365-install`)是 8 个 command
加一个**非标准布局**的 `.claude/skills/verify/SKILL.md`。
按 ADR-040,它们今天**打不成任何 Bundle**;而信封要求组件数 ≥ 1。

## 8. 语料的边界与漂移

- 语料 = `~/.claude/plugins/marketplaces`,排除 `*.bak`;四个 marketplace 根、62 个插件、
  162 个 `SKILL.md`、888 个文件。
- 语料是**活的第三方内容**,会漂。本轮重生相对上一份夹具:
  文件集合与逐字内容**零变化**;376 个文件的 mode 从 `0o600/0o700` 变成 `0o644/0o755`
  (可执行位语义逐文件不变,已机械核对);`claude-plugins-official/.claude-plugin/marketplace.json`
  从 161310 变成 163121 字节(占位档,无判定读它的内容)。
- 三个数只描述**这一份语料**。它不是全网 Claude 插件的样本,别当分布外推用。

## 9. 语料的保真档位:哪一格的字节是真的

这份语料是一把尺子,而**尺子只有一部分刻度是真的**。在它上面量任何数之前先读这一节。

888 个文件分两档:

| 档位 | 是什么 | 条数 | 字节 |
| --- | --- | ---: | ---: |
| **逐字** | `SKILL.md` 162 + `plugin.json` 62 + `.mcp.json` 22 | **246** | 真实内容 |
| **占位** | 其余全部 | **642** | 6 577 137 B,内容是**填充字节 `'a'`** |

占位档里数量最多的几类:`.md` 352(`commands/**` 100、`agents/**` 43、README/文档若干)、
`.py` 51、`.yaml` 40、`.json` 38(含 4 份 `marketplace.json`)、`.mjs` 33、`.sh` 23、
无扩展名 54,以及 5 个含**字面 NUL 字节**的 `.png`/`.jpg`。完整分类由
`packages/ui-mac/src/main/claude-plugin-corpus-census.test.ts` 的 G6 逐类钉住。

**占位档保住了什么、丢了什么**(两条都是可执行断言,不是自述):

| 维度 | 占位档 | 依据 |
| --- | --- | --- |
| 路径 / 文件名 / 存在性 | ✅ 真 | 逐条记录 |
| **体积**(`size`) | ✅ **逐字节真** | 888 条与真实文件比对,0 条不符 |
| mode / 可执行位 | ✅ 真 | 逐条记录 |
| **内容** | ❌ **已知假**(全 `'a'`) | 摊开时 `Buffer.alloc(size, 0x61)` |

⇒ **可以**在这份语料上量的:文件数、目录数、总字节、单文件最大字节、相对路径深度、
可执行位分布 —— 这些是**真值,不是下界**。
实证:技能侧六个数(162 skill / 40 个多文件 / 单技能最多 18 个文件 / 单技能最大 230 243 B /
最大单文件 64 768 B / 最大相对深度 2)从**夹具**与从**真实语料**分别算,逐个相同。

⇒ **不可以**在这份语料上量的:任何需要**解析这些文件内容**才能得出的数 ——
`agents/*.md` 与 `commands/*.md` 的 frontmatter、hooks 脚本里声明的事件、
`marketplace.json` 里的条目清单。**注意这不是「算出来偏小」** ——
拿 `'aaaa…'` 去解析会得到**一个假的零**,那比下界更坏。

**为什么不干脆全部逐字保留**:那是把第三方内容整个搬进仓(另外 6.5 MB,含带 NUL 的图片),
而今天没有任何判据需要那些字节。**需要哪一类,就补哪一类** —— 补法是把文件名加进生成器的
`VERBATIM`,并同时在 G6 的分类断言里改条数(改了不同步,当场红)。

**已知缺口(今天故意不补,谁要用谁补)**:`agents/**/*.md` 43 个文件的内容不在语料里。
若将来要回答「真实 agent 的 frontmatter 长什么样、`agent` profile 接不接得住」,
必须先把它补进 `VERBATIM` 重生语料,**不能**拿现在的语料去量。

**另一侧的上界**(读的是 alpha-web,本仓不动它):发布端对**每个组件**的资产文件数有硬上限
`maxFilesPerComponent: 512`(`scripts/lib/extension-package-core.mjs:77`,由同文件 1042–1049 的
`validateAssetFiles` 执行)。本语料单技能最多 18 个文件,离 512 很远 ——
**今天卡人的是组件数那一格,不是单组件文件数那一格。**
