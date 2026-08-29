---
title: Office(docx/xlsx/pptx)提取视图 —— 方案基线(REQ-123 / #438)
kind: design
status: proposed
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-29
review_after: 2026-11-29
---

# Office 提取视图 方案基线(REQ-123,`alpha-code#438`)

> L 级需求升 Ready 的门。四段:①只读勘破 ②选定方案与被否决的替代 ③安全面类边界与不变量 ④子票切分。
> owner 2026-08-28 裁决:走**提取视图**,**明写排版不保真**,允许新依赖。
> 勘破原始记录:`/tmp/claude-501/recon-req123.md`(2026-08-29,只读,7 个真实样本)。

## ① 只读勘破(全部实测,非推论)

### 三族的最小节点路径集
| 格式 | 提取正文所需 | 关键事实 |
| --- | --- | --- |
| docx | `w:body/w:p/w:r/w:t` | **textutil/Cocoa 产物零 `w:pStyle`、表格拍平成段落、列表是字面「•」**,而 python-docx / 真实 Word 用 `w:pStyle` + `w:tbl` ⇒ 断言「结构一致」会被 Cocoa 产物证伪 |
| xlsx | `xl/worksheets/sheet*.xml` + `xl/sharedStrings.xml`,靠 `c/@t` 区分(`s`=共享串索引 / `inlineStr` / `n` / `b`) | 公式是 `<f>` + 缓存 `<v>` ⇒ **天然满足「不求值」**,不需要额外闸 |
| pptx | `ppt/slides/slide*.xml` 的文本框;备注在独立 `notesSlides/*` part | **页序唯一权威是 `presentation.xml/sldIdLst` 经 rels 解,不能靠文件名排序** |

### DOMParser 对 DTD / 实体(生产运行时 = Electron 42.3.3 的 Chromium,`executeJavaScript` 真跑)
```
malformed-control    => parsererror:true        ← 正对照:探针测得出已知的坏
doctype-plain        => parsererror:FALSE       ← 静默接受 <!DOCTYPE
internal-entity      => 展开成功(3 层 = 64 字节)
deep-internal-entity => expandedLen = 125000    ← 6 层 = 8×5^6,billion-laughs 向量
external-entity-file => text:"", leaked:FALSE   ← 不取 file:// 外部实体
external-entity-http => sink 零命中              ← 不取 http 外部实体
external-dtd-http    => sink 零命中              ← 不取外部 DTD
```
sink 的「零命中」用 `curl .../known-hit-control` 做过正对照 ⇒ 真阴性,不是探测器坏了。

**三条推论(全部 load-bearing)**
1. `<!DOCTYPE` 拒绝闸**必须在 `parseFromString` 之前的文本层**,Chromium 不会替你拒。
2. 它是**真闸不是减速带** —— 不拦就是把 billion-laughs DoS 放进右栏渲染。
   **闸必须扫「送进 `parseFromString` 的那个字符串」,不是原始字节**(咨询轮 M1):part 若按 UTF-16 编码(带 BOM + `encoding="UTF-16"`),字节层的 UTF-8 正则**零命中**,而解码后的字符串里 DOCTYPE 完好 ⇒ 闸变假。故解码与扫描必须在**同一个函数**里紧挨着做。
3. **经典 XXE 文件读取 / SSRF 经 DOMParser 不可达**,安全边界靠「拒 DOCTYPE 防 DoS + 只放文本节点进 DOM」,不该在防外部实体上投成本。

**运行时陷阱**:`happy-dom`(`bun test` 用的)行为**与 Chromium 相反**(它直接拒实体)。任何依赖 DOMParser 实体行为的断言跑在 `bun test` 下,**量的是 happy-dom 不是生产**。把闸做在文本层可让 `bun test` 忠实覆盖;实体行为本身的断言必须在真 Chromium 跑。

### zip.js 预算现值(`shared/ooxml.ts:7-37` `OOXML_LIMITS`)
20 MiB 容器 / 512 entries / 64 MiB 单 entry / 256 MiB 总量 / ratio 200 / 5 s 墙钟。
超限**抛错 fail-closed,不截断、不返回部分内容**;声明期(中央目录)与解压期(`WritableStream.write`)双帽。

7 个真实样本实测:entries ≤ 46 / 512,解压总量 ≤ 832 KB / 256 MiB,最大 entry ≤ 438 KB / 64 MiB,最大比 32 / 200。
⇒ **现值对真实 Office 文件绰绰有余,本 REQ 不调整任何预算常量。**

### API 缺口(必须先补的基座)
`detectOoxmlContainer` **只返回检测元数据**;解出的字节只为 `[Content_Types].xml` 与 `_rels/.rels` 在 `retained` map 里短暂保留后丢弃(`:320/:397`)。
`grep -c "export.*Uint8Array"` = **0**(幻针 `extractOoxmlPartBytesZZZ_nonexistent` = 0,该文件 NUL 计数 = 0)⇒ **没有任何导出函数吐得出任意 part 的字节**。内容层今天拿不到 `word/document.xml`。

承载面:`artifact-workbench.tsx:251` 在 renderer 侧已持有 `read.bytes` 并调 `detectOoxmlContainer`;`presentOfficeStructure`(`renderers/office-structure.ts`)把 `status:"pass"` 映射为 `quickLook:true`,`rejected` 映射为带 `category` 的降级卡。内容视图接在 `pass` 分支。

## ② 选定方案与被否决的替代

### 选定
1. **取字节:扩展既有 `retained` 机制,不新开解压路径。** `detectOoxmlContainer` 增加一个**调用方传入的白名单**,命中者的字节随检测结果一并返回。复用同一 preflight + 有界 inflate + 双帽,**单趟**,零第二条解压路径。
   **白名单形状(咨询轮 B1 裁决,必须照此实现)** —— pptx/xlsx 的 part 名由容器**内部**的 rels 决定(勘破实测 `rId7→slide1` 不对应),调用方在解容器**之前**给不出精确名单,所以白名单 = **静态精确名 ∪ 受限目录前缀**:
   - 精确名:`word/document.xml`、`xl/workbook.xml`、`xl/sharedStrings.xml`、`ppt/presentation.xml`
   - 受限前缀:`xl/worksheets/`、`ppt/slides/`、`ppt/notesSlides/`,以及对应的 `_rels/`
   咽喉只管**名字匹配 + 既有帽**;**rels 解析与目标校验归提取器**(t2/t3)。**禁止两趟全量 inflate**(双倍 5s 预算与 CPU,且两趟之间字节可变)。
2. **解析:用 renderer 既有的 `DOMParser`,零新依赖。** 三族的最小节点路径集(见①)足够简单,不需要 OOXML 库;且与 ADR-032 已裁「否决 SheetJS 类可视化渲染」一致。owner 说的是**允许**新依赖,不是要求 —— 能不引就不引。
3. **提取器 = 三个纯函数**(docx / xlsx / pptx),**签名只接受字节**,输出结构化文本模型(段落 / 表格 / 页)。不接受路径、URL、回调。
4. **pptx 页序从 `presentation.xml/sldIdLst` 经 rels 解**,不排文件名。
5. **IA:内容视图成为 `pass` 分支的默认呈现,Quick Look 降为次级动作。** 依据 #438 的简明目的原文(「而不是只能把文件交给系统的 Office 应用打开」)与 ADR-032 的统一 IA。

### 被否决的替代
| 方案 | 为什么否 |
| --- | --- |
| 引入 mammoth / SheetJS / officeparser 一类库 | ADR-032 已裁否决可视化渲染;最小路径集实测足够简单,新依赖等于把不可信输入交给一个我们没勘破过的解析器,反而扩大攻击面 |
| 内容层自己解 zip(绕开 `shared/ooxml.ts`) | **直接违反单一咽喉不变量** —— 那些帽就白设了 |
| 依赖 DOMParser 自己拒 DTD | 实测它**静默接受**;这是「前提为假的闸门」,比没有闸门更贵 |
| 在 `bun test` 里断言实体行为 | happy-dom 与 Chromium 相反,量的是 happy-dom |
| 追 rels 外链 / 加载远程图片以求「更完整」 | 把出网面引进提取器;保真本来就不承诺 |
| 按文件名排 pptx 页序 | `sldIdLst` 才是权威,文件名排序会给出错的页序 |

## ③ 安全面:类边界与实现必须守住的不变量

每类都过了第零问「走本系统代码 + runbook,这个状态到得了吗」。**到不了的不列**(纯 SQL 直连、runbook 从不传的参数、非 OOXML 的旧 doc/xls/RTF/ODF)。

| # | 类 | 到得了? | 不变量 |
| --- | --- | --- | --- |
| 1 | Zip bomb / 超大解压 | 是(AI 产物写盘即进 workbench) | 一切解压经 `shared/ooxml.ts` **单一咽喉**;声明期+解压期双帽;超限 fail-closed 返回 rejected,**绝不返回部分内容**;内容层**不得另起第二条解压路径** |
| 2 | 实体展开 DoS / DTD | 是(实测 6 层 125000 字节) | **字节 → `Document` 的唯一通路是单个共享函数**:解码 → 对**解码后的字符串**扫 `<!DOCTYPE` / `<!ENTITY` → `parseFromString`。**提取器不得直接调 `DOMParser`。拒的是文档,不是静默清洗** |
| 3 | 外部实体 / SSRF / 本地文件读取 | **经 DOMParser 不可达**(实测三种全不取) | 仍**只把文本节点放进 DOM,禁止 innerHTML 注入路径**;不把 part 内任何 URL / rels 目标当作可 fetch 的东西 |
| 4 | 路径穿越 / 符号链接 entry | 已被上游拦(`unsafeEntryCode:642`、`ZIP_SYMLINK_ENTRY:531`、`safePartName`) | 内容层按 part 名**精确匹配已知路径**或经校验的 rels 目标取字节,**不接受调用方传入的任意路径** |
| 5 | 文本注入 / 冒充 UI | 是 | 提取结果一律当**纯数据文本**渲染;保真限制对用户如实声明,不伪装成所见即所得 |
| 6 | 超大 / 深嵌套 / 畸形 part | 是 | 沿用既有有界读取范式;畸形/超限给**明确降级态**(诚实错误卡 + 失败原因类别),不空白、不伪造、不冻结 UI。**另设内容层单 part 解析上限 4 MiB**(见下) |

**内容层单 part 解析上限(咨询轮 M2)**:现有 zip 帽的单 entry 上限是 64 MiB,而 `parseFromString` 在 renderer **主线程同步执行** —— 一个 20–30 MiB 的**合法** sheet XML(AI 产多行数据完全可达)过得了全部 zip 帽,却会同步解析数秒,直接违反「不冻结界面」;而「超帽走降级态」救不了它,因为**它不超帽**。故内容层另设 **4 MiB 单 part 解析上限**(比 7 个真实样本的最大 part 438 KB 高一个量级),超过走既有诚实降级卡。**不动 `OOXML_LIMITS`**,与 t1「不碰预算常量」不冲突;不需要 worker。

**贯穿的签名不变量**:提取层 API **只接受字节,不接受路径 / URL / 回调**。理由是 renderer 里 `fetch` 是全局量 —— 签名允许 URL 就等于开了出网面,而这与「DOMParser 本身不出网」是两回事(风险在提取器代码自己)。这是可结构性保证的咽喉;检索类断言(grep 无 `fetch`)**只作辅助减速带,不单独作为可重开的验收面**。

**两条不变量的「红在哪」(咨询轮 M3,不指名就会做成减速带)**
- **单一咽喉** ⇒ 闸 = **import 图检查**:仓内只有 `shared/ooxml.ts` 允许引用 `@zip.js` / `DecompressionStream`;只有类 2 那个共享函数允许调 `DOMParser`。**如实标注它防的是「误开第二条路径」,不是恶意实现** —— 在本威胁模型下够用。
- **AC4 零出网** ⇒ 「提取器代码自己不 fetch」的真证据 = t4 在**真 Chromium** 里带网络观察器跑恶意语料,**零命中 + 正对照**(勘破的 sink 基建现成,已用 `known-hit-control` 验过能记到命中)。这句进 t4 的退出条件,否则那一格的证据只剩 grep。

## ④ 子票切分

| 子票 | 负责 | 边界 | 退出条件 |
| --- | --- | --- | --- |
| `[REQ-123][CODE] OOXML 内容 part 取字节咽喉 + 文本层 DOCTYPE 闸` | AC5 的不变量 1/2/4 **+ AC7**(字节只随 `status:"pass"` 的检测结果返回;`rejected` 分支结构上无字节可拿 —— 这是选定方案的自然属性,写明以免漏掉) | 扩展 `shared/ooxml.ts` 的 retained 白名单;内容 part 前置文本扫描。**不碰预算常量** | 单一咽喉断言 + 变异演练(另起解压路径 ⇒ 红);DOCTYPE/ENTITY 负向夹具红 |
| `[REQ-123][CODE] docx / pptx 文本提取与呈现` | AC1 / AC3 **+ AC6**(保真声明文案)**+ IA 翻转**(选定方案第 5 条:内容视图设为 `presentOfficeStructure` 的 `pass` 分支默认,Quick Look 降次级 —— 本子票本来就要动那个分支) | 两族都是「文本流」形态,共用呈现骨架;pptx 页序走 `sldIdLst` | 真实夹具断言**内容串出现**(段落文本 / 每页文本);Cocoa 与 python-docx 两种产物都过 |
| `[REQ-123][CODE] xlsx 工作表提取与表格呈现` | AC2 | 表格形态与前者不同;共享串 + 数值 + 多 sheet 切换 | 含共享串/数值/多 sheet 的夹具断言;公式只显示不求值 |
| `[REQ-123][VERIFY] 恶意与边界夹具矩阵(真 Chromium)` | AC4 / AC5 证据 | 每类先用**已知坏样本**证明手段能红,再判好;实体行为断言**必须在真 Chromium 跑** | 矩阵执行完;变异演练留痕 |

## 出范围(如实声明,不做无界承诺)

- **保真渲染**(字体 / 分页 / 图形精确还原)—— #438 既有 non-goal,owner 已裁
- **DrawingML / SmartArt / 图表内文字** —— 勘破未逐类枚举,本 REQ 只覆盖段落 / 表格 / 文本框 / 备注的常规正文
- **合并单元格 / 冻结窗格 / 隐藏 sheet 的呈现语义** —— 未取样本,本 REQ 不承诺
- **极端大工作表** —— **本格未取到大样本**(手头最大解压 832 KB)。不断言「任意规模都过帽」;超帽时走既有 fail-closed 降级态
- **脚注 / 尾注** —— 票面 Scope 写「按可行性纳入」,勘破未取样本 ⇒ **本 REQ 显式排除**,避免验收时两种读法
- 编辑能力、宏 / VBA 执行、外部数据连接、非 OOXML 格式

## 实现前要裁的一个小口径(咨询轮可选参考,已采纳为待办)

`ooxml.ts:737` 的现有正则连 `<![CDATA[` 一起拒。对 `[Content_Types]` / rels 合理;对**内容 part**,CDATA 是合法 XML,个别生成器会用。失败面是诚实降级卡(不是拒载启动),风险低。
**要求 t1 实施时先对 7 个真实样本跑一次 CDATA 计数**,据实数据显式写下「拒 / 不拒」的选择并记进代码注释 —— 免得三个提取器各解各的。

## 待实测已闭合

勘破前列的三条(样本 XML 形状 / DOMParser 对 DTD 的行为 / zip.js 预算现值)**全部已实测闭合**,结论在 ① 段。
