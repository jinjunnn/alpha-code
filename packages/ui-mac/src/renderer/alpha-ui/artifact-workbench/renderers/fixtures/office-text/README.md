# office-text 真实夹具(REQ-123 / #1175)

这些 XML 是**真实产生器产物的逐字节 part 副本**,不是手写桩。断言判据是
「内容串出现」而不是「结构一致」——方案基线(`docs/design/2026-08-29-req123-office-extraction/baseline.md` ①)
实测:Cocoa 产物零 `w:pStyle`、表格拍平成段落、列表是字面「•」,而 python-docx / 真实 Word
用 `w:pStyle` + `w:tbl`,断言结构会被 Cocoa 产物证伪。

| 目录 | 产生器 | 关键形状 |
| --- | --- | --- |
| `cocoa-docx/` | macOS `textutil -convert docx`(Cocoa) | `w:pStyle`×0、`<w:tbl>`×0,表格拍平、列表为字面 `•` 文本 |
| `py-docx/` | python-docx 1.2.0 | `w:pStyle`×3(Heading1/ListBullet)、真 `<w:tbl>`×1 |
| `py-pptx/` | python-pptx 1.0.2,建 3 页后把第 3 页移到最前(真实用户操作) | `sldIdLst` 序 = [rId10→slide3, rId7→slide1, rId9→slide2],**≠ 文件名序**;notes 是独立 part,目标为 `../notesSlides/...` 相对路径;slide2 无 notes |

页序权威只有 `presentation.xml/sldIdLst` 经 rels 解(基线 ②-4);本夹具刻意让文件名序
与权威序不同,使「按文件名排序」的错误实现在页序断言上红。

重新生成:`python3 make-fixtures.py`(需 macOS `textutil`、`python-docx`、`python-pptx`)。
产生器版本变化会改变字节,但断言只依赖内容串与页序,预期仍绿;若产生器形状漂移
(例如 Cocoa 开始写 `w:pStyle`),那是需要重新勘破的事实,不是测试瑕疵。
