# 推理档位(`variant`)的可达面:谁能设、设错了会不会被告知

> 2026-09-06 勘破,起因 [`#1249`](https://github.com/jinjunnn/alpha-code/issues/1249)
> 「`--variant` 打在没有档位的模型上静默无效」。全部坐标当日实读,命令附在每节。
> 结论落在这里是因为它决定了**这道缺陷要不要在 alpha 修、能在哪一层修** —— 而这个判断
> 不在票面里,票面只描述了症状。

## 1. 上游那条链:收得下,查不到,不吭声

```
packages/opencode/src/cli/cmd/run.ts:212-215
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
```

CLI 无条件收下任意字符串,**不对照模型的档位表**。值一路带到:

```
packages/opencode/src/session/llm/request.ts:84-87
  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
```

模型没有 `variants` ⇒ 取 `{}`;有 `variants` 但键不存在 ⇒ 取 `undefined`。两条都直接进
`mergeOptions`,**没有任何一处比对合法档位、没有一处报错**。档位表本身由
`packages/opencode/src/provider/transform.ts:711` 的 `variants(model)` 产出。

三处全在 `UPSTREAM_PATHS` 里。`request.ts` 虽然已由 ADR-041/REQ-134 逐文件收编
(`scripts/north-star-guard.sh:99` 的 exclude),**技术上改得动**,但见 §4:它修不到任何
一个我们的用户到得了的状态。

## 2. 第零问:走我们自己的代码和 runbook,到得了 `--variant` 吗?——到不了

| 问题 | 实读 | 结论 |
| --- | --- | --- |
| alpha 出 CLI 吗? | `packages/ui-mac/package.json` 无 `bin` 字段 | 否 |
| 安装包里带可执行 CLI 吗? | `packages/ui-mac/electron-builder.config.ts:79-133` 的 `extraResources` 共 8 条:`skills/` `factory-skills/` `office-mcp/` `agents/` `NOTICE.txt` `extension-seed/` `alpha-ext/` `db-expected-migrations.json` | 否 |
| 应用起引擎时传 argv 吗? | `packages/ui-mac/src/main/server.ts:293-295`:`fork(sidecar, [], …)` | 传的是 `[]` |
| 那个 sidecar 是 CLI 吗? | `packages/ui-mac/src/main/sidecar.ts:118` `const { Server } = await import("virtual:opencode-server")` | 是**服务器**,不解析 argv |
| runbook 里有人用它吗? | `grep -rn -- "--variant" docs/ .claude/` → **0 命中** | 否 |

⇒ `--variant` 是**上游 CLI 的表面**,不是 alpha 产品的表面。用户拿不到那个二进制,
我们自己的 runbook 也一次都没提过它。开发机上 `bun run packages/opencode/src/index.ts run --variant …`
当然能复现 —— 那是**开发路径**,不是产品路径。

诚实边界:应用内有终端(`session-rail/terminal`)。用户如果**自己**另外装了 opencode,
可以在那里敲这条命令 —— 但那时跑的是他自己的那份二进制,不是我们发的。

## 3. 产品这一侧的对应表面:composer 的档位 chip

用户在 alpha 里表达「用高强度思考」的唯一入口是 composer 上那颗档位 chip。这条路径上
**结构性地发不出引擎不认识的档**:

| 位置 | 代码 | 作用 |
| --- | --- | --- |
| `alpha-ui/model-picker-core.ts:74-78` | `withModelVariant`:`variant && model.variants.includes(variant) ? variant : undefined` | 选档时就丢掉非法值 |
| `alpha-ui/composer-state.ts:232-233` | `setComposerModel`:换模型时 `m.variant && !m.variants.includes(m.variant)` ⇒ 清空 | 换模型不留下陈旧档 |
| `alpha-ui/composer-state.ts:318` | `buildPromptRequest`:`input.effort && input.model.variants.includes(input.effort) ? { variant: input.effort } : {}` | 发送前最后一道(C28) |
| 档位来源 | `model-picker-core.ts:70/109` `Object.keys(platform.variants)` | 只可能是该模型真有的键 |

**这一半已经有闸**:`composer-state.test.ts` 的「无档模型 → 绝不携带 variant(C28)」与
「模型有档但档名不存在 → 不携带」,以及 `model-picker-core.test.ts` 的
`withModelVariant(projected, "不存在").variant === undefined`。

## 4. 那为什么不去改上游那三处

- **改不到任何可达状态。** 我们自己发的产品结构上产不出「未知档位」这个输入(§3),
  在 `request.ts` 加一个 loud-fail 等于给一个到不了的状态立闸;而它守的那条 CLI 路径
  我们不发货(§2)。这正是 `CLAUDE.md`《第零问》点名的形状 ——
  **「在合成夹具里能复现 ≠ 在这个系统里到得了」**。
- **代价是真的。** `transform.ts` 自 2026-06-01 有 24 个上游 commit、内容全是推理档/采样参数
  (见 `docs/design/req-153-output-capability.md` §1.5),动它是「何时冲突」而不是「会不会冲突」。
- **`request.ts` 虽已收编,收编面是有边界的**:ADR-041/REQ-134 收它是为了 `{workspace}` 与
  工具身份,不是把它变成 alpha 想改就改的文件(ADR-029 §3:新增收编须自己的 ADR)。

## 5. 真正没被守住的那一半:「告诉用户为什么没生效」

`alpha-composer.tsx` 的 `EffortChip` 已经做了这件事:

- `:414-415` `supported() = variants().length > 0`;
- `:434` / `:441` / `:449` chip 上 `title` 走 `alpha.composer.effortUnsupported`、
  `data-muted={supported() ? undefined : ""}`、值位显示 `—`;
- `:501` 弹层里 `alpha.composer.effortUnavailableHint` **点名那个模型**
  (zh:「「{{model}}」未提供推理档位;请换用带档位的模型。」)。

**但这一半在 2026-09-06 之前没有任何判据。** 而它不是边角:`packages/ui-mac/src/main/alpha-models.json`
当天 12 个平台模型里,只有 `claude-opus-4.8` 与 `gpt-5.4-mini` 有 `variants`,**另外 10 个没有**。
把 `supported()` 改成恒真、或把弹层那段 hint 换成空,用户点开档位入口看到的就是一片空白 ——
和票面描述的沉默同形,而当时没有任何东西会变红。

判据因此补在 `packages/ui-mac/test-component/alpha-composer-model.cases.ts`
(真挂 `AlphaComposerRuntime`,由已登记的 `alpha-composer-model.component.test.ts` 起子进程跑):
无档位模型 ⇒ chip muted + `—` + title 说明原因 + 弹层点名模型 + **零个可点档位**;
同一条用例里以**有**档位的模型作控制组(否则「弹层根本没渲染」也能满足全部否定断言)。
变异实测(2026-09-06):拿掉 `data-muted` / `supported()` 恒真 / hint 置空,三条各自变红。

## 6. 处置

`#1249` 描述的「静默无效」在 alpha 产品上**到不了**,而它在产品上的对应表面
(档位 chip 的不支持态)**行为已正确、现在也有闸了**。上游 CLI 的那条路径按
「已知不修」记在本文件 §1/§4,前提是「alpha 不发 CLI」——
**这个前提若变(哪天我们真的发一个命令行入口),本条必须重开。**
