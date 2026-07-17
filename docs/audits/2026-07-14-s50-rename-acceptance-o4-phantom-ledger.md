# S50 正名真机验收 + O4 幽灵旧账修复取证(2026-07-14)

- Issue:jinjunnn/alpha-code#195(REQ-103 切片内正名 dd326d63/e2a9f4e4 的真机验收环节)
- 分支:`feat/195-req103-hub-governance`
- 范围:① governance→ext-inventory / builtin-policy 双正名的真机行为验收(dev 模式 CDP 驱动);
  ② 验收白捡的存量 bug O4(内置治理写路径全砖)的根因、修复与钉测。

## 1. 正名验收(读面全 PASS)

方法:dev 真机(`electron-vite dev -- --remote-debugging-port=9222`)+ playwright-core
connectOverCDP(Node 下驱动;Bun 下 WS 会超时)截图 + DOM 探针。

- 主界面/定制中心/已安装三态/内置(上游)面板/详情页所有权+来源签名段全渲染;
  全程 DOM 扫描零裸 i18n 键(`alpha.builtin.*` 全落中文文案)。
- `inventoryView`/`builtinRead` 改名通道端到端通(已安装·5 芯片、面板列 build/general/plan、
  customize-opencode 出厂禁用带恢复、/init /review 重写)。
- 落盘守卫:`~/.alpha/governance.json`(含缺 `allowFactory` 的旧格式)读入自愈;验收全程
  三个真实配置文件 md5 零变化。正名 diff 逐行核过 = 纯标识符替换,无行为变化。

## 2. O4:幽灵旧账砖死治理写路径(真机白捡,非正名回归)

**现场**:点「隐藏 plan」→ 面板红字 `Can not delete in empty document`,任何 apply/重置治理
永久失败。

**根因链**:

1. 老 `governance.json`(REQ-037 期)`skills.deny` 含出厂项 customize-opencode,
   `governance-materialized.json` 记了 4 键(permission.skill.\*、permission.skill.customize-opencode、
   command.customize-opencode.description/template)——当年物化进**当时的**目标文件;
2. REQ-059 迁真源后,新真源 `~/.alpha/alpha.jsonc` 没有这些键(账实分离);
3. REQ-067 的 `normalizeBuiltinPolicy` 把出厂项从 deny 洗掉(设计内自愈)→ 任何一次 apply
   里这 4 键全变 stale 删除;
4. jsonc-parser 的 `modify(text, path, undefined)` 对**父路径缺失**的删除直接
   throw(`edit.js:47`,报错文案误导)→ 一个幽灵键砖死整笔事务,且每次 apply 重算出同一组
   stale → 永久失败。单测未覆盖是因为缺"账实分离"这一真机状态组合。

**修复**(`ext-config.ts` `applyBuiltinPolicyEdits`):删除编辑在当前文档解析不到路径时跳过
(与 onlyIfAbsent 同款 parse 姿势);删除本就不入 `applied`,记账语义不变;成功 apply 后
`r.applied` 收敛记账,幽灵键自愈出账。codex M1 注释「删不存在的键无害」自此成立。

## 3. 钉测(撤修复 4 红,恢复全绿)

- `ext-config.test.ts`:① 父链缺失的幽灵删除跳过、同笔真实写入存活、不凭空造父对象;
  ② 父在叶缺同样跳过、真实叶子照常删除+空壳剪枝;③ 目标文件不存在的纯删除事务不 throw。
- `alpha-builtin-policy.test.ts`:O4 现场复刻(幽灵 4 键旧账 + 真源无键 + 老 governance 形状)
  → apply ok、真实写入生效、记账收敛只剩实际写入;同现场 reset ok、记账清空、用户内容原样。

## 4. 修后真机复验(同机同现场)

| 步骤 | gov.hide | gov.deny | 记账 keys | alpha.jsonc |
|---|---|---|---|---|
| 修前点隐藏 | [] 不变 | 不变 | 4 幽灵键不变 | 不变(事务回滚)+ 面板红字 |
| 修后点隐藏 | ["plan"] | [](REQ-067 自愈洗净) | [["agent","plan","hidden"]](幽灵出账) | +agent.plan.hidden |
| 修后取消隐藏 | [] | [] | [] | hidden 键净除(空壳剪枝) |

屏上零报错;customize-opencode 仍显「已禁用」(出厂禁走内置默认,与 deny 无关)。
权威门 `scripts/alpha-check.sh` 全绿(1433 测试 = 原 1428 + 新 5)。
