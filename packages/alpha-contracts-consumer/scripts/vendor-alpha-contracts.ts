#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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
    repo: "jinjunnn/alpha-platform",
    commit: "2fe1d0103b7c3f68acb98c44d13ed0fcfe8bf196",
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
  const result = Bun.spawnSync(["git", "-C", sourceRoot, "show", `${upstream.commit}:${upstream.sourcePrefix}/${path}`])
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
    if ("commitBound" in upstream && !hasStagedSource)
      throw new Error(`required producer checkout is unavailable: ${sourceRoot}`)
    if ("commitBound" in upstream) {
      const resolved = Bun.spawnSync(["git", "-C", sourceRoot, "rev-parse", `${upstream.commit}^{commit}`])
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
    if ("artifactPath" in upstream) {
      const manifest = JSON.parse(
        new TextDecoder().decode(
          await sourceBytes(upstream, sourceRoot, "extension-package-producer-artifact.v1.json"),
        ),
      ) as {
        artifactPath?: unknown
        artifactSha256?: unknown
        files?: unknown
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
    }
    // 只说自己真的验过的事。有 staged checkout 时三方比对(lock ↔ vendored 字节 ↔ 上游字节)成立,
    // 说 "from …@<sha>" 才是真的;**没有**时,本次只证明了本仓自洽(lock ↔ vendored 字节),
    // 「这些字节来自那个 commit」根本没被检查过 —— 那是 lock 的**声称**,不是本次的结论。
    // 无源时仍打印 "verified … from …@<sha>" 就是宣称一件自己没验证的事(假闸门的标准形态):
    // 拿一个陈旧/错误的目录跑一次 vendor,脚本照收并重写 lock,CI 随后照样说"来自那个 commit"。
    // 无源不判红 —— CI 没有上游 checkout 是常态,不是错误;错的只是措辞。
    console.log(
      hasStagedSource
        ? `verified ${upstream.files.length} contract artifacts from ${upstream.repo}@${upstream.commit}` +
            ` (lock + staged upstream bytes)`
        : `checked ${upstream.files.length} contract artifacts against ${upstream.lock}` +
            ` — lock ↔ vendored bytes OK; PROVENANCE NOT VERIFIED this run` +
            ` (no staged checkout of ${upstream.repo}@${upstream.commit}; these bytes are not proven to come from it)`,
    )
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
    const resolved = Bun.spawnSync(["git", "-C", sourceRoot, "rev-parse", `${upstream.commit}^{commit}`])
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
