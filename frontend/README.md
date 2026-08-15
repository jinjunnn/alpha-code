# 前端 pin + 补丁(ADR-034 B 方案)

`packages/{app,ui}`(上游 opencode 前端)**不再冻结**,改为**跟随一个显式上游 pin + alpha 前端补丁序列**,
以持续白嫖上游前端更新,同时保留 alpha 的前端定制。取代 ADR-020 的冻结机制。

## 载体
- **`frontend-pin.lock`** — 被跟随的上游 SHA(`pin=<sha>`)。`packages/{app,ui}` 恒等于 pin 的上游态 +
  下述补丁。
- **`alpha-patches/alpha-frontend.patch`** — alpha 前端定制相对 pin 的**完整 delta**(单文件,**唯一 SOT**)。
  内容 = AppSurfaces typed surface seam(ADR-027)+ Settings/Recovery/Permission seam + `./surface/session`
  窄导出等。**改前端 seam = 改 `packages/{app,ui}` 后重生此补丁**(见下),不要手改本文件。
  **必须用 `git diff --binary` 生成**:`packages/app/vendor/*.tgz` 这类二进制在 pin 里不存在、却被
  `packages/session-ui/package.json` 以 `file:` 直接依赖 —— 普通 `git diff` 不携带二进制内容,补丁看似
  完整实则重建不出可安装的树。文件因此在 `.gitattributes` 里标了 `-whitespace`:unified diff 的空
  context 行本就是「一个空格」,不是尾随空白(其描述内容的空白由 `packages/{app,ui}` 源头受检)。

## 日常 sync(自动,只进引擎)
`sync-upstream.yml` 每次 sync 合并上游 dev 后,`apply_alpha_frontend_delta` 把 `packages/{app,ui}` 还原为
`pin + alpha-frontend.patch`。补丁 3-way apply 失败(pin 与补丁漂移)→ loud-fail 阻断 sync,提示跑月更 bump。

## 月更 bump(升 pin,人门禁)—— 流程
每月一次(或需要上游新前端修复时手动)把 pin 升到近期上游。

下面每个命令块都**自带 `set -e` 与 `cd "$(git rev-parse --show-toplevel)"`,与当前工作目录无关,
逐字复制粘贴即可执行**;失败即中断,不会带着半截状态往下走。

**1) 取新上游前端 + 贴 alpha 补丁(3-way),并记下新 pin**

```sh
set -e
cd "$(git rev-parse --show-toplevel)"
NEWPIN=$(git rev-parse upstream/dev)   # 或换成一个近期稳定上游 SHA
git checkout "$NEWPIN" -- packages/app packages/ui
echo "pin=$NEWPIN # $(date +%F)" > frontend/frontend-pin.lock
git apply --3way --whitespace=nowarn frontend/alpha-patches/alpha-frontend.patch
```

**pin 必须写在 apply 之前**:`git checkout "$NEWPIN"` 之后树已经是新 pin 的上游态,lock 就该说这件事。
反过来(先 apply 后写 pin)有一条静默的坏路径:apply 冲突时 `set -e` 会跳过写 pin,而**块 4 从
lock 读 pin**,于是补丁会以**旧 pin** 为基底重生 —— 里面裹上全部上游差异,round-trip 判据照样绿,
月更实际没升 pin。

apply 冲突(尤其 app.tsx 高 churn 枢纽)时这一步会停,此时 pin 已是新的、补丁尚未贴上:手动/codex
把 alpha 的叶注入 seam(createSessionRoute / createDraftRoute / AppSurfaces)重架到上游新路由,
dialog/settings/permission seam 同理。冲突文件在 `git status` 里,`git apply --3way` 已把能自动合的
部分留在工作树、冲突处留 `<<<<<<<` 标记;解完(工作树里不再有冲突标记)直接进块 2,**不要重跑本块**
——重跑会把已解的树再按上游覆盖一遍。后面的块都从 lock 读 pin,不依赖本块的变量。

放弃本次 bump(回到上一个 pin,等价于什么都没做):

```sh
set -e
cd "$(git rev-parse --show-toplevel)"
git restore --source=HEAD --staged --worktree -- frontend/frontend-pin.lock packages/app packages/ui
```

**2) 重钉 L1 变换 + 锚点(上游改名/搬文件时)**

```sh
set -e
cd "$(git rev-parse --show-toplevel)/packages/ui-mac"
bun scripts/gen-upstream-anchors.ts
```

`scripts/{patch-upstream,brand-i18n}.ts` 的 loud-fail 目标随上游 build 失败时重钉;锚点失配测试
逐条判「真断」还是「陈旧快照」。

**3) 全门禁(真环境)**

```sh
set -e
cd "$(git rev-parse --show-toplevel)"
bun install
bun run --cwd packages/ui-mac typecheck    # 0 错
bun run --cwd packages/ext typecheck        # 0 错
(cd packages/ui-mac && bun test src)        # 0 fail
(cd packages/ui-mac && bun run build)       # electron-vite full build 通过
```

**4) 重生 SOT 补丁 + round-trip 判据(机械可跑,也是日常自检)**

判据是「pin + 补丁重建出来的 `packages/{app,ui}` == **HEAD** 里的那两棵树」,由
[`scripts/assert-frontend-patch-roundtrip.sh`](../scripts/assert-frontend-patch-roundtrip.sh) 执行。
那个脚本同时是 `scripts/alpha-check.sh` 的第 `[2/10]` 步与 alpha-ci `upstream-guard` job 的一步 ——
**这里跑的和门禁跑的是同一份字节**,不是两份会各自漂移的副本。`--binary` 不可省(见「载体」)。

**补丁必须与源码改动进同一个提交**:判据锚在 HEAD(日常 sync 与上面块 1 重建的正是 HEAD 那棵树),
未提交的 `packages/{app,ui}` 改动不计入 —— 脚本会把它们作为 dirty 清单打出来,但不拿它们判决。

```sh
set -e
cd "$(git rev-parse --show-toplevel)"
PIN="$(sed -n 's/^pin=\([0-9a-f]\{7,40\}\).*/\1/p' frontend/frontend-pin.lock)"
[ -n "$PIN" ] || { echo "frontend/frontend-pin.lock 缺 pin=<sha>"; exit 1; }
git diff --binary "$PIN" -- packages/app packages/ui > frontend/alpha-patches/alpha-frontend.patch
# 提交范围必须钉死在这四条路径上:`git commit` **不带 pathspec 提交的是整个 index**,
# 你手上任何无关的已暂存改动都会被裹进这条署名 chore(frontend) 的提交里 —— 月更 bump 走
# 块 1→5 时,块 1 的 `git checkout $NEWPIN -- …` 就已经在 index 里留了东西。
# `git add` 那行不能省(它才带得上**未跟踪**的新 seam 文件),`--only` 负责把提交范围收窄。
# 2026-08-15 实测(git 2.50.1):add 四条 + `commit --only` 四条 ⇒ 新增的未跟踪文件进了提交,
# 无关的暂存改动**原样留在暂存区**。
# 干净树上这四条路径无改动时 `git commit` 以 1 退出("nothing to commit"),`set -e` 会让它在
# 跑到最后那行自检**之前**中止 —— 所以先问一句有没有东西要提交;不用 `|| true` 吞掉 commit 的
# 失败,那样真正的提交失败(钩子拒绝、pathspec 打错)也会被读成「没什么要提交」。
if [ -n "$(git status --porcelain -- packages/app packages/ui frontend/alpha-patches/alpha-frontend.patch frontend/frontend-pin.lock)" ]; then
  git add packages/app packages/ui frontend/alpha-patches/alpha-frontend.patch frontend/frontend-pin.lock
  git commit --only packages/app packages/ui frontend/alpha-patches/alpha-frontend.patch frontend/frontend-pin.lock \
    -m "chore(frontend): regenerate alpha frontend SOT patch"
else
  echo "  (这四条路径与 HEAD 一致,没有要提交的东西 —— 直接跑自检)"
fi
bash scripts/assert-frontend-patch-roundtrip.sh
```

> **订正(2026-08-14,`#976`)**:本块此前是一段手写的 round-trip —— `mktemp -d` →
> `git archive "$PIN" | tar -x` → `git init` → `git apply` → `test -f "$RT/packages/app/$VENDORED"` →
> 两条 `diff -r --exclude=node_modules`。**那段判据已不再使用**,理由是实测的两条:
>
> 1. 它比的是**文件系统**,而 `diff -r --exclude=node_modules` 在一棵健康的主 checkout 上**今天就红**:
>    `packages/{app,ui}` 各有一个 `.turbo` 构建产物,输出 `Only in …/packages/app: .turbo` 与
>    `Only in …/packages/ui: .turbo`(2026-08-14 实测)。照抄进闸门 = 一道恒红门(`#754` 形态)。
>    反方向也漏:文件系统比对之外,未 `git add -N` 的新文件在 `git diff` 里根本不出现。
> 2. 同一段逻辑存在两份(runbook 一份、闸门一份)时,**能假绿的那一份会被当成通过** ——
>    这正是 `#976` 要消掉的东西。现在验证半场只有脚本一处,生成半场(`git diff --binary`)留在这里。
>
> 换成 git 自己的对象模型之后(临时 `GIT_INDEX_FILE` → `read-tree $PIN` → `apply --cached --binary`
> → `write-tree`,比 **tree sha**),`.turbo` 这类未受版本控制的产物结构性地不参与,而内容、
> 文件模式、增、删、改与两个包一次覆盖。
>
> **仍然成立、没有变的**:`--binary` 不可省;pin 必须写在 apply 之前(见块 1);
> 「被 `file:` 直接依赖的那个 vendored `.tgz` 必须真的重建得出来」这条保证仍在 —— 漏 `--binary` 时
> 补丁只剩一行 `Binary files … differ`,`git apply` 直接拒绝(新判据当场红并说明是二进制没带),
> 另一侧由 `.github/workflows/sync-upstream.yml` 里那条 `VENDORED` loud-fail 接住。

**5)** 开 PR,owner 真机视觉复验(布局切换 / dialog 焦点 / composer / timeline / permission)后合。

**退化模式安全**:bump PR 不合 = 暂时停在上一个 pin(等价于旧冻结态),日常 sync 与产品 PR 不受影响。

## 为什么这么设计
见 [ADR-034](../.claude/rules/adrs/ADR-034-frontend-rolling-pin.md)(supersede ADR-020 冻结,反转 ADR-016
「放弃白嫖上游前端」前提)。更干净的终局(C:app/ui 零 delta、定制全走 ui-mac 组合)可在 B 稳定后滑行过去。
