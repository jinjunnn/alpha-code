#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// #754: every git call below targets a *sibling* repository, so none of them may inherit this
// repository's git environment. `git push` exports GIT_DIR into the hook process and GIT_DIR beats
// `-C` — see git-cross-repo.ts for the measurement and why the variable list is git's, not ours.
import { gitInRepository } from "./git-cross-repo"

// One entry per upstream contract publisher. Each pins an immutable commit and owns its own lock
// file, vendor subtree, and staged-source directory. `vendor` re-copies bytes from a staged checkout
// of the pinned commit and rewrites that lock; `--check` (the merge gate) re-hashes the vendored
// bytes against the lock and, when a staged checkout is present, against the upstream bytes too.
const UPSTREAMS = [
  {
    // #640 / platform#101: bumped off bcc60bbf for the Ledger V1 hard cut. `LedgerEntryV1` is now the
    // append-only ledger fact (seq/op_id/kind/domain/signed amount/created_at ms); the old mutable
    // {id,type,title,amount_fen,status} row is gone at an unchanged schema_version — a breaking
    // in-place cut with no compatibility shim, so this pin and the desktop decoder move together.
    //
    // platform#177: bumped again for the one-shot token-contract change. `TokenClaimsV1` gained a
    // sixth `oneOf` branch (`mcp_access`, issued to third-party MCP clients) and a new
    // `account.keys.manage` purpose. Only the schema file's bytes move; nothing this repository
    // decodes changes shape. This repository is a CONSUMER of the new branch in one direction
    // only — it must keep rejecting it (see src/contracts.test.ts), because `decodeTokenClaims`
    // is the desktop's own credential path and an `mcp_access` token is not one of ours.
    repo: "jinjunnn/alpha-platform",
    commit: "62c7aa6de5589cfcf2af00ecab69f1d3d176512b",
    lock: "alpha-platform-contract.lock.json",
    vendor: "vendor/alpha-platform",
    sourceEnv: "ALPHA_PLATFORM_CONTRACT_SOURCE",
    sourceDefault: ".upstream-contracts",
    files: [
      "contracts/v1/alpha-wire-contracts.schema.json",
      "contracts/v1/artifact-descriptor.schema.json",
      "contracts/v1/limits.json",
      "contracts/v1/fixtures/producer/artifact-list.json",
      "contracts/v1/fixtures/producer/cloud-job-accepted.json",
      "contracts/v1/fixtures/producer/cloud-job-request.json",
      "contracts/v1/fixtures/producer/cloud-job-status.json",
      "contracts/v1/fixtures/producer/ledger-page.json",
      "contracts/v1/fixtures/consumers/alpha-code-224/cloud-and-artifact.json",
      "contracts/v1/fixtures/consumers/alpha-web-22/platform-access-claims.json",
      "contracts/v1/fixtures/invalid/artifact-inline-content.json",
      "contracts/v1/fixtures/invalid/cloud-missing-version.json",
      "contracts/v1/fixtures/invalid/cloud-unknown-field.json",
      "contracts/v1/fixtures/limits/envelope-max-exact.json",
      "contracts/v1/fixtures/limits/envelope-max-plus-one.json",
      "contracts/v1/fixtures/limits/payload-max-exact.json",
      "contracts/v1/fixtures/limits/payload-max-plus-one.json",
    ],
  },
  {
    // #681 / platform#138 / ADR-039: ModelCatalogV2 ships as its own capability-scoped artifact, so it
    // gets its own pin even though the publisher repository is the same. `GET /v1/models` now returns
    // ModelCatalogV2 only — the V1 bundle above no longer carries a model-catalog fixture, and bumping
    // the catalog generation must not force alpha-web (or the Token/Cloud/Artifact consumers) to
    // re-pin the V1 bundle. Same repo, separate commit / lock / vendor subtree / staged-source dir:
    // the loops below key on the entry, never on `repo`, so the two alpha-platform pins move apart.
    //
    repo: "jinjunnn/alpha-platform",
    commit: "7fd62d3edcb0d21f429ce06cadc2528fc5b0ab5c",
    lock: "alpha-platform-model-catalog.lock.json",
    vendor: "vendor/alpha-platform-model-catalog",
    sourceEnv: "ALPHA_PLATFORM_MODEL_CATALOG_SOURCE",
    sourceDefault: ".upstream-model-catalog-contracts",
    // 第三份是上游发布的 **negative fixture**(V1 形状的目录,`expect: "invalid"`)。钉它是为了让
    // 「拒绝 V1 形状」这条判据消费**上游自己的字节**,而不是我们手写一份别人文法的替身 ——
    // 手写替身是本仓最贵的返工来源(见 alpha-work CLAUDE.md「勘破先于闸门设计」第 2 条:
    // 要么消费对方的决定,要么直接拒绝该输入,不要解释它)。
    files: [
      "contracts/v2/model-catalog.schema.json",
      "contracts/v2/fixtures/producer/model-catalog.json",
      "contracts/v2/fixtures/invalid/v1-shaped-catalog.json",
    ],
  },
  {
    // alpha-web publishes the consumer fixtures for alpha-code's two web-owned surfaces
    // (alpha-web#23 / alpha-work#9 AC3). They are exercised through the shipped decoders in
    // packages/ui-mac/src/main/alpha-web-contract-fixtures.test.ts — an upstream change those
    // decoders reject turns this repository's merge gate red as soon as the pin is bumped.
    repo: "jinjunnn/alpha-web",
    commit: "b597f0d548db9ffafc6d6301e548dbd323c810ad",
    lock: "alpha-web-contract.lock.json",
    vendor: "vendor/alpha-web",
    sourceEnv: "ALPHA_WEB_CONTRACT_SOURCE",
    sourceDefault: ".upstream-web-contracts",
    files: [
      "contracts/web-identity/fixtures/consumers/alpha-code/endpoint-discovery.json",
      "contracts/web-account/fixtures/consumers/alpha-code/account-summary.json",
      // The schema itself, so the account decoder's accepted key sets can be bound to the
      // upstream property sets by test rather than restated as a hand-maintained constant.
      "contracts/web-account/account-summary.v1.schema.json",
    ],
  },
  {
    // REQ-128 / alpha-web#97:the producer artifact deliberately cannot embed the Git commit
    // containing itself. This consumer therefore pins the containing commit beside the artifact
    // path and aggregate SHA, and reads every source byte from that exact Git object. Unlike the
    // older optional staged fixtures above, an unavailable checkout or missing commit is a hard
    // failure:provenance cannot be proved by a self-consistent replacement lock.
    repo: "jinjunnn/alpha-web",
    commit: "6e0db57d6c7d9867a450fccf6db5453e417dc58e",
    lock: "alpha-web-extension-package.lock.json",
    vendor: "vendor/alpha-web-extension-package",
    sourceEnv: "ALPHA_WEB_EXTENSION_PACKAGE_SOURCE",
    sourceDefault: "../alpha-web",
    sourceFallback: "../../../alpha-web",
    sourcePrefix: "contracts/extension-package/artifact",
    artifactPath: "contracts/extension-package/artifact",
    artifactSha256: "d229717f895fcfb9a75bc6fdcc6ab2338f057ef1778db15e8720c31a1affc446",
    commitBound: true,
    // #759 / alpha-web#109:producer 追平宿主合同 v2。语料从 22 个文件长到 36 个 —— 新增的是
    // flat Bundle 正/负向、OAuth 与 Alpha Connection 的正向语料(旧的 `input.remote-oauth.invalid.json`
    // 随之消失,它在 v2 下是**合法**输入),外加 Bundle 组件引用的两份 markdown 资产。
    // 这两份 `.md` 是本清单里第一批非 JSON 字节,vendor 循环的 JSON 语法自检因此按扩展名分流。
    files: [
      "alpha-package-compatibility-report-v1.schema.json",
      "alpha-package-declaration-v1.schema.json",
      "asset.generic-bundle-agent.md",
      "asset.generic-bundle-skill.md",
      "expected.bundle.compiled.json",
      "expected.mcp-remote.compiled.json",
      "expected.remote-connection.compiled.json",
      "expected.remote-oauth.compiled.json",
      "extension-package-error-v1.schema.json",
      "extension-package-producer-artifact.v1.json",
      "generic-profiles.v1.json",
      "generic-rules.v1.json",
      "host-contract-pin.v1.json",
      "host-extension-package-artifact.v1.json",
      "host-extension-package.registry.v1.json",
      "input.author-capabilities.invalid.json",
      "input.author-dependencies.invalid.json",
      "input.author-secret-value.invalid.json",
      "input.bundle-duplicate-component.invalid.json",
      "input.bundle-overflow.invalid.json",
      "input.bundle-root-leaf-collision.invalid.json",
      "input.bundle.valid.json",
      "input.cloud-profile.invalid.json",
      "input.mcp-remote.valid.json",
      "input.oauth-authorization-header.invalid.json",
      "input.oauth-prerequisite-collision.invalid.json",
      "input.remote-auth-unknown.invalid.json",
      "input.remote-connection.valid.json",
      "input.remote-http.invalid.json",
      "input.remote-oauth.valid.json",
      "input.remote-userinfo.invalid.json",
      "normalized-package-build-record-v1.schema.json",
      "report.blocked.json",
      "report.compatible.json",
      "report.review-required.json",
      "vectors.v1.json",
    ],
  },
] as const

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(packageRoot, "../..")
const check = process.argv.includes("--check")

/** The producer's own record of the artifact — the one file that cannot contain its own hash. */
const PRODUCER_MANIFEST = "extension-package-producer-artifact.v1.json"

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")
const sourceRootOf = (upstream: (typeof UPSTREAMS)[number]) => {
  const explicit = process.env[upstream.sourceEnv]
  if (explicit) return resolve(repositoryRoot, explicit)
  const primary = resolve(repositoryRoot, upstream.sourceDefault)
  if (existsSync(primary) || !("sourceFallback" in upstream)) return primary
  return resolve(repositoryRoot, upstream.sourceFallback)
}
const sourceBytes = async (upstream: (typeof UPSTREAMS)[number], sourceRoot: string, path: string) => {
  if (!("commitBound" in upstream)) return new Uint8Array(await Bun.file(resolve(sourceRoot, path)).arrayBuffer())
  const result = gitInRepository(sourceRoot, ["show", `${upstream.commit}:${upstream.sourcePrefix}/${path}`])
  if (result.exitCode !== 0)
    throw new Error(
      `cannot read pinned source ${upstream.repo}@${upstream.commit}:${upstream.sourcePrefix}/${path}: ${result.stderr.toString().trim()}`,
    )
  return new Uint8Array(result.stdout)
}
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  )
}

if (check) {
  for (const upstream of UPSTREAMS) {
    const vendorRoot = resolve(packageRoot, upstream.vendor)
    const sourceRoot = sourceRootOf(upstream)
    const hasStagedSource = existsSync(sourceRoot)
    // #769:这里原本对 commitBound 条目**硬抛**「required producer checkout is unavailable」。
    // CI 跑的是裸 checkout,兄弟仓 `../alpha-web` 结构上不存在 —— 于是 `verify immutable Alpha
    // contract vendor lock` 这一步**恒红**,而红的理由与它要验的漂移毫无关系。一道恒红的闸等于
    // 没有闸,还更糟:大家学会忽略它,真出漂移时也没人看(#754 是同一种病的本地那一道)。
    //
    // 为什么不在 CI 里 checkout 兄弟仓(票面的另一条路):alpha-code 是 **public**、alpha-web 是
    // **private**,跨仓 checkout 要把私仓读令牌放进公开仓的 Actions secrets;而本 workflow 触发在
    // `pull_request`,fork PR 结构上拿不到 secrets ⇒ 那一步对外部贡献者依然红。再加上 pin 的 sha
    // 要么全量 clone 私仓、要么抄进 YAML 变成第二份真相 —— 都是拿恒红换更坏的东西。
    //
    // 所以:无源时**降级**并在输出里说清降级掉的是哪一条保证(下方 console.log)。`vendor`
    // 那一侧照旧硬失败 —— 没有 provenance 就不能落盘一份自洽的替身 lock。
    if (hasStagedSource && "commitBound" in upstream) {
      const resolved = gitInRepository(sourceRoot, ["rev-parse", `${upstream.commit}^{commit}`])
      if (resolved.exitCode !== 0 || resolved.stdout.toString().trim() !== upstream.commit)
        throw new Error(
          `required producer commit does not resolve exactly: ${upstream.repo}@${upstream.commit} in ${sourceRoot}`,
        )
    }
    const lock = (await Bun.file(resolve(packageRoot, upstream.lock)).json()) as {
      repo?: unknown
      commit?: unknown
      artifactPath?: unknown
      artifactSha256?: unknown
      files?: Array<{ path?: unknown; sha256?: unknown }>
    }
    if (lock.repo !== upstream.repo || lock.commit !== upstream.commit)
      throw new Error(`contract lock does not resolve to the approved immutable commit: ${upstream.lock}`)
    if (
      "artifactPath" in upstream &&
      (lock.artifactPath !== upstream.artifactPath || lock.artifactSha256 !== upstream.artifactSha256)
    )
      throw new Error(`producer artifact path/SHA pin drifted: ${upstream.lock}`)
    if (!Array.isArray(lock.files) || lock.files.length !== upstream.files.length)
      throw new Error(`contract lock file set differs from the approved vendor set: ${upstream.lock}`)
    for (const path of upstream.files) {
      const entry = lock.files.find((candidate) => candidate.path === path)
      if (!entry || typeof entry.sha256 !== "string") throw new Error(`contract lock is missing ${path}`)
      const vendored = new Uint8Array(await Bun.file(resolve(vendorRoot, path)).arrayBuffer())
      if (sha256(vendored) !== entry.sha256) throw new Error(`vendored contract hash mismatch: ${path}`)
      if (!hasStagedSource) continue
      const sourceFile = Bun.file(resolve(sourceRoot, path))
      if (!("commitBound" in upstream) && !(await sourceFile.exists()))
        throw new Error(`staged contract artifact is missing: ${path}`)
      const source = await sourceBytes(upstream, sourceRoot, path)
      if (sha256(source) !== entry.sha256) throw new Error(`staged contract hash mismatch: ${path}`)
    }
    // 降级输出要报「锚住了几条」,而报的必须是**真跑过的条数**,不是从别处推算出来的数字 ——
    // 推算出来的数字在断言被跳过时依然好看,那正是假绿的形状。
    let manifestAnchored = 0
    if ("artifactPath" in upstream) {
      // #769:manifest 从 **vendored** 字节读,不再从 git 读。有 staged checkout 时两者可证等价 ——
      // 上面的逐文件循环已断言 vendored == lock == staged bytes,而这份 manifest 自己就在 files 里。
      // 没有 checkout 时这是唯一还跑得动的读法,于是下面这组断言在 CI 上**真的会被执行**,
      // 而不是像原先那样连同整步一起红掉(红掉 = 一条也没跑)。
      const manifest = JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(await Bun.file(resolve(vendorRoot, PRODUCER_MANIFEST)).arrayBuffer()),
        ),
      ) as {
        artifactPath?: unknown
        artifactSha256?: unknown
        files?: Array<{ path?: unknown; sha256?: unknown }>
        producerRepository?: unknown
        producerCommit?: unknown
      }
      const aggregate = sha256(
        new TextEncoder().encode(
          `${JSON.stringify(
            canonical({
              artifactPath: manifest.artifactPath,
              files: manifest.files,
              producerRepository: manifest.producerRepository,
            }),
            null,
            2,
          )}\n`,
        ),
      )
      if (
        manifest.artifactPath !== upstream.artifactPath ||
        manifest.artifactSha256 !== upstream.artifactSha256 ||
        manifest.producerRepository !== upstream.repo ||
        JSON.stringify(manifest.producerCommit) !==
          JSON.stringify({ binding: "git-commit-containing-this-artifact", embedded: false }) ||
        aggregate !== upstream.artifactSha256
      )
        throw new Error(`producer artifact manifest aggregate/provenance binding mismatch: ${upstream.lock}`)
      // #769:把 manifest 声称的每个文件哈希与 lock 条目对上。**没有这一条,降级模式就是自洽的**
      // ——「lock ↔ vendored 字节」两边都由 `vendor` 一次跑就同时重写:拿一个陈旧/错误的目录跑一次
      // vendor,两边一起被改写,闸门照样绿(正是下方注释点名的那个攻击)。而 `artifactSha256` 是
      // **人在 diff 里评审过的源码常量**,`vendor` 从不回写它;aggregate 又覆盖整个 files 数组。
      // 于是这一条把 35 个文件哈希锚死在一个机器改不动的值上 —— 降级模式因此仍是一道真闸,
      // 只是证不到「这些字节来自那个 git commit」。断言顺序:aggregate 先跑,所以被清空/改形的
      // files 数组在这里之前就已经红了。
      if (!Array.isArray(manifest.files))
        throw new Error(`producer artifact manifest has no file list: ${upstream.lock}`)
      const lockHash = new Map(lock.files.map((entry) => [entry.path, entry.sha256]))
      for (const entry of manifest.files) {
        if (typeof entry.path !== "string" || lockHash.get(entry.path) !== entry.sha256)
          throw new Error(
            `producer manifest disagrees with the lock about ${String(entry.path)}: ` +
              `manifest ${String(entry.sha256)} vs lock ${String(lockHash.get(String(entry.path)))} (${upstream.lock})`,
          )
        manifestAnchored++
      }
    }
    // 只说自己真的验过的事。有 staged checkout 时三方比对(lock ↔ vendored 字节 ↔ 上游字节)成立,
    // 说 "from …@<sha>" 才是真的;**没有**时,本次只证明了本仓自洽(lock ↔ vendored 字节),
    // 「这些字节来自那个 commit」根本没被检查过 —— 那是 lock 的**声称**,不是本次的结论。
    // 无源时仍打印 "verified … from …@<sha>" 就是宣称一件自己没验证的事(假闸门的标准形态):
    // 拿一个陈旧/错误的目录跑一次 vendor,脚本照收并重写 lock,CI 随后照样说"来自那个 commit"。
    // 无源不判红 —— CI 没有上游 checkout 是常态,不是错误;错的只是措辞。
    if (hasStagedSource) {
      console.log(
        `verified ${upstream.files.length} contract artifacts from ${upstream.repo}@${upstream.commit}` +
          ` (lock + staged upstream bytes)`,
      )
      continue
    }
    // #769:降级这件事必须**响亮**。一行淹在绿色步骤日志里的 console.log 就是「大家习惯性忽略它」
    // 的下一个形态,所以在 GitHub Actions 上同时发一条 workflow 注解 —— 它会出现在 run summary 和
    // PR 页面上。本地不打注解(那只是噪音),judgment 完全一样,只是呈现方式跟着环境走。
    const anchored = manifestAnchored
      ? `; ${manifestAnchored} producer-manifest hashes ↔ source-pinned aggregate` +
        ` ${"artifactSha256" in upstream ? upstream.artifactSha256 : ""} OK`
      : ""
    const degraded =
      `checked ${upstream.files.length} contract artifacts against ${upstream.lock}` +
      ` — lock ↔ vendored bytes OK${anchored}; PROVENANCE NOT VERIFIED this run` +
      ` (no staged checkout of ${upstream.repo}@${upstream.commit}; these bytes are not proven to come from it)`
    console.log(degraded)
    if (process.env.GITHUB_ACTIONS === "true")
      console.log(`::warning title=PROVENANCE NOT VERIFIED (${upstream.repo})::${degraded}`)
  }
  process.exit(0)
}

let vendored = 0
for (const upstream of UPSTREAMS) {
  const sourceRoot = sourceRootOf(upstream)
  // Bumping one pin does not require staging every upstream; an unstaged publisher keeps its
  // existing vendored bytes and lock untouched.
  if (!existsSync(sourceRoot)) {
    if ("commitBound" in upstream) throw new Error(`required producer checkout is unavailable: ${sourceRoot}`)
    console.log(`skipped ${upstream.repo}: no staged contracts at ${sourceRoot}`)
    continue
  }
  if ("commitBound" in upstream) {
    const resolved = gitInRepository(sourceRoot, ["rev-parse", `${upstream.commit}^{commit}`])
    if (resolved.exitCode !== 0 || resolved.stdout.toString().trim() !== upstream.commit)
      throw new Error(
        `required producer commit does not resolve exactly: ${upstream.repo}@${upstream.commit} in ${sourceRoot}`,
      )
  }
  const vendorRoot = resolve(packageRoot, upstream.vendor)
  const files = [] as Array<{ path: string; sha256: string }>
  for (const path of upstream.files) {
    const source = Bun.file(resolve(sourceRoot, path))
    if (!("commitBound" in upstream) && !(await source.exists()))
      throw new Error(`approved contract artifact is missing: ${path}`)
    const data = await sourceBytes(upstream, sourceRoot, path)
    // 语法自检只对 JSON 成立。Bundle 语料引用的 markdown 资产同样按 pin 的 git object 逐字节
    // 取回并入 lock —— provenance 由哈希三方比对保证,不由「能不能 JSON.parse」保证。
    if (path.endsWith(".json")) JSON.parse(new TextDecoder().decode(data))
    await Bun.write(resolve(vendorRoot, path), data, { createPath: true })
    files.push({ path, sha256: sha256(data) })
  }
  await Bun.write(
    resolve(packageRoot, upstream.lock),
    `${JSON.stringify(
      {
        repo: upstream.repo,
        commit: upstream.commit,
        ...("artifactPath" in upstream
          ? { artifactPath: upstream.artifactPath, artifactSha256: upstream.artifactSha256 }
          : {}),
        files,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`vendored ${files.length} contract artifacts from ${upstream.repo}@${upstream.commit}`)
  vendored++
}
if (vendored === 0) throw new Error("no staged upstream contracts found")
