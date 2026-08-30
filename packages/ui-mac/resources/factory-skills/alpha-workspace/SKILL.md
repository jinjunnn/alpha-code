---
name: alpha-workspace
description: Write summaries, journals, and memory notes into the user's code-puppy workspace (~/code-puppy) following its directory contract (Journal/Memory/Outputs). Use when the user asks to summarize the day or a session, keep a journal/diary, remember something for later, or save notes/results without naming a target path.
license: MIT (Code Puppy original)
---

# code-puppy 工作目录写入约定

`~/code-puppy` 是用户的默认工作目录(可见,非隐藏)。当用户要求**总结、记日记、记住某事、保存笔记/结果**而没有指明目标路径时,按下面的契约写入。凡用户明确给了路径,以用户为准,本约定让位。

## 目录契约(ADR-025)

| 位置 | 内容 | 规则 |
|---|---|---|
| `~/code-puppy/Journal/YYYY-MM-DD.md` | 按日期的总结/日记 | **同日追加,不覆盖**;文件不存在则创建 |
| `~/code-puppy/Memory/<slug>.md` | 长期记忆,一事一文件 | kebab-case 文件名;更新已有条目优先于新建重复条目 |
| `~/code-puppy/Outputs/` | 云任务/自动化交付物 | **系统写入区,不要主动往这里写** |

规则:

1. **只追加、不删改**用户已有内容;追加到 Journal 时在末尾加 `## HH:mm` 小节头再写正文。
2. 目录/文件不存在就创建(含 `Journal/`、`Memory/` 子目录);日期用系统当天日期。
3. 总结写事实:做了什么、结论是什么、遗留什么。不编造未发生的事,不写空话。
4. Memory 条目开头用一行说明这条记忆是什么、何时记录(绝对日期),便于用户直接阅读与编辑;相关条目间可用 `[[slug]]` 互链。
5. 用户在其他项目目录里工作时,这套约定同样指向 `~/code-puppy`(用户的个人数据主目录),除非用户要求写进当前项目。
6. `~/code-puppy` 下的 `.code-puppy/` 是引擎运行时产物目录,不要读写它。

## 触发示例

- 「总结一下今天」「把今天的工作写进日记」→ `Journal/今天日期.md` 追加
- 「记住我偏好 X」「下次记得 Y」→ `Memory/` 一事一文件
- 「把这个结论存下来」(未给路径)→ 先问是进 Journal(按日)还是 Memory(长期),默认 Journal
