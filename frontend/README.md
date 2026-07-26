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

判据是「从 pin 的 archive 重建出的树 == 当前树」。必须在**干净的临时树**里做:在本仓
`git checkout $PIN -- packages/{app,ui}` 不会删除 pin 里没有、当前树里有的文件(正是那个 .tgz),
会把缺口掩盖成绿。`--binary` 不可省(见「载体」)。改了 `packages/{app,ui}` 之后跑同一个块即可
重生补丁并自证。

```sh
set -e
REPO="$(git rev-parse --show-toplevel)"; cd "$REPO"
PIN="$(sed -n 's/^pin=\([0-9a-f]\{7,40\}\).*/\1/p' frontend/frontend-pin.lock)"
[ -n "$PIN" ] || { echo "frontend/frontend-pin.lock 缺 pin=<sha>"; exit 1; }
git diff --binary "$PIN" -- packages/app packages/ui > frontend/alpha-patches/alpha-frontend.patch
# 判据钉「被 file: 直接依赖的那个精确文件」,不是「有没有随便一个 tgz」:版本换名而补丁还带旧的,
# `ls *.tgz` 照样绿,bun install 却装不上。
VENDORED="$(sed -n 's|.*"file:\.\./app/\(vendor/[^"]*\.tgz\)".*|\1|p' packages/session-ui/package.json | head -1)"
[ -n "$VENDORED" ] || { echo "packages/session-ui 没有 file: 指向 packages/app/vendor 的依赖"; exit 1; }
RT="$(mktemp -d)"
git archive "$PIN" packages/app packages/ui | tar -x -C "$RT"
git -C "$RT" init -q .
git -C "$RT" add -A
git -C "$RT" -c user.email=rt@local -c user.name=rt commit -qm pin
git -C "$RT" apply --binary "$REPO/frontend/alpha-patches/alpha-frontend.patch"
test -f "$RT/packages/app/$VENDORED"                                       # 精确二进制真的重建出来了
diff -r --exclude=node_modules "$RT/packages/app" "$REPO/packages/app"     # 必须零输出
diff -r --exclude=node_modules "$RT/packages/ui" "$REPO/packages/ui"       # 必须零输出
rm -rf "$RT"
echo "round-trip OK: pin=$PIN vendored=$VENDORED"
```

**5)** 开 PR,owner 真机视觉复验(布局切换 / dialog 焦点 / composer / timeline / permission)后合。

**退化模式安全**:bump PR 不合 = 暂时停在上一个 pin(等价于旧冻结态),日常 sync 与产品 PR 不受影响。

## 为什么这么设计
见 [ADR-034](../.claude/rules/adrs/ADR-034-frontend-rolling-pin.md)(supersede ADR-020 冻结,反转 ADR-016
「放弃白嫖上游前端」前提)。更干净的终局(C:app/ui 零 delta、定制全走 ui-mac 组合)可在 B 稳定后滑行过去。
