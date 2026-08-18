// #336(残留4):未策展提交面(custom MCP 导入)的 IPC body 从 ext-ipc 抽出为 electron-free 模块
// —— 账本写失败的 fail-closed 返回与精确补偿(restoreMcpLeaf)必须可注入测试(仓规:参数 DI +
// 真盘临时目录,零 mock.module)。
// ADR-040(`#825`):npm plugin 导入 body 随「扩展安装不得写引擎 plugin[]」整条撤下 ——
// 通道(`ext-install-plugin`)、preload 方法、hub 入口一并消失,不留一个恒失败的按钮。
// 静态 fs seam(如 installs.json 置目录)会先被账本**读侧**的 fail-closed(ledger-corrupt 拒绝)
// 拦截,无法证明「写失败后精确补偿」—— 注入唯一要观测的账本提交结果(recordInstall)是正确接缝。
// 逻辑逐字搬移自 ext-ipc.ts(#355/#378/#395 各裁决注释原样保留),仅 userDataPath/globalRoot/
// environment/recordUncuratedInstall 收进 deps。

import { claimMcpSecretVersionDir, fileifyMcpSecretsVersioned, isFileRef, newMcpSecretVersionId, removeMcpSecretVersionDir } from "./alpha-mcp-secrets"
import type { AppEnvironment } from "./alpha-environment"
import { gcMcpSecretsAgainstConfig, readMcpLeaf, restoreMcpLeaf } from "./ext-config"
import { persistMcpWithPolicy } from "./ext-mcp-policy"
import { recordUncuratedInstall } from "./ext-uncurated-record"

export type UncuratedBodyDeps = {
  userDataPath: string
  globalRoot: () => string
  environment: () => AppEnvironment
  /** #336 注入 seam(测试专用):未策展提交面唯一要观测的失败源 = 账本落账结果;
   *  生产恒缺省真 recordUncuratedInstall。 */
  recordInstall?: typeof recordUncuratedInstall
}

/** REQ-099 #305:未策展自定义 MCP 专用通道 body(catalog MCP 走 ext-install-catalog);不收
 *  renderer meta —— 未策展安装拿不到 catalog 身份,防伪造 catalog 来源/版本(ADR-028 §5)。
 *  注册与 gate 接入仍在 ext-ipc(写通道表);本模块只承载可测的提交/补偿语义。 */
export function makeUncuratedInstallBodies(deps: UncuratedBodyDeps) {
  const { userDataPath } = deps
  const recordInstall = deps.recordInstall ?? recordUncuratedInstall

  const persistMcpBody = async (name: string, server: Record<string, unknown>, secretVars?: string[]) => {
    // T5:把 requiredEnvVars 的真值(renderer 刚采集,经 IPC 结构化克隆到达此处)搬进
    // {file:} 密钥通道 → durable config 只落引用,绝不明文。renderer 的 live mcp.add 仍用
    // 真值(内存态),下次启动引擎按 {file:} 解析。
    // #378(Codex 裁决 Q1):固定路径覆盖写 + 整目录快照/恢复退役 —— 那套 restore 会连事务
    // 通道刚写的新版本一起删(跨通道交错)。改版本化只增不覆盖:本次写全新 verId 目录,既有
    // 版本(可能正被旧 config 或在途事务引用)零接触;失败只删本次 verId(无引用,惰性安全)。
    const vars = secretVars && secretVars.length && server && typeof server === "object" ? secretVars : null
    // r9 Major:只有确有**明文**需要路由才认领版本目录 —— 空 env / 纯 {file:} 引用的重装
    // 无需写通道,secret 树不可写不应无谓拒绝(既有引用继续可用)。
    const isRecEnv = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
    const envForScan = vars && isRecEnv(server.environment) ? server.environment : null
    const plaintextVars = vars
      ? vars.filter((v) => {
          const val = envForScan ? envForScan[v] : undefined
          return typeof val === "string" && val.length > 0 && !isFileRef(val)
        })
      : []
    // r1 Minor:版本目录排他认领(碰撞换 id 重试,绝不复用既有版本目录)。
    // r8 Blocker:认领不下来 = 密钥进不了文件通道 —— **fail-closed 拒绝**,绝不带明文继续
    // 落盘(durable config 只含 {file:} 引用的合同对未策展面同样成立)。
    let verId: string | null = null
    let claimFail = ""
    if (plaintextVars.length > 0) {
      for (let i = 0; i < 3 && !verId; i++) {
        const vid = newMcpSecretVersionId()
        const claimed = claimMcpSecretVersionDir(userDataPath, name, vid)
        if (claimed.ok) verId = vid
        else {
          claimFail = claimed.reason
          if (!claimed.exists) break // 非碰撞失败(圈禁/权限)重试无意义
        }
      }
      if (!verId) return { ok: false as const, reason: `secret channel unavailable (${claimFail}) — refusing plaintext persist` }
    }
    // Codex review #355:补偿必须是精确叶子 before-image —— removeMcp 全量卸载会连既有配置/
    // legacy/receipt 一起误删(更新场景毁掉本次写入前就存在的安装)。
    const before = typeof name === "string" ? readMcpLeaf(name) : undefined
    if (vars && verId) {
      const f = fileifyMcpSecretsVersioned(userDataPath, name, server, vars, verId)
      if (f.failed.length > 0) {
        // r8 Blocker:明文没能全部进文件通道 → 删本次版本目录并拒绝,绝不明文持久化。
        const rm = removeMcpSecretVersionDir(userDataPath, name, verId)
        return {
          ok: false as const,
          reason: `secret(s) could not be routed to the {file:} channel: ${f.failed.join(", ")} — refusing plaintext persist${rm.ok ? "" : `; cleanup failed (${rm.reason}) — plaintext may remain in version "${verId}" pending gc`}`,
        }
      }
    }
    // MCP write-policy entrypoint: REQ-135 retired connectors are refused and REQ-133 Alpha Office
    // commands are validated before durable config is written.
    const r = persistMcpWithPolicy(name, server, undefined)
    if (!r.ok) {
      // r6 Major:清理失败不许吞 —— 0600 明文残留位置如实并入错误(GC 兜底,用户可定位)。
      const rm = verId ? removeMcpSecretVersionDir(userDataPath, name, verId) : { ok: true as const }
      return rm.ok ? r : { ok: false, reason: `${r.reason}; secret version cleanup failed (${rm.reason}) — plaintext may remain in version "${verId}" pending gc` }
    }
    // REQ-099 #306:未策展落账走 coordinator(v2+派生 v1 单次写);失败补偿 = 撤配置 + 删本次
    // 密钥版本,不谎报成功(#336 语义)。
    const led = recordInstall(deps.globalRoot(), {
      kind: "mcp",
      name,
      origin: "created",
      environment: deps.environment(),
      scope: { kind: "global" },
      configKey: `mcp.${name}`,
    })
    if (!led.ok) {
      const lr = restoreMcpLeaf(name, before) // 只复原本次目标叶子(before=undefined 即删本次写入)
      // r1 Major:复原失败 = config 仍引用本次版本 —— 此时删版本目录会制造悬空 {file:} 引用,
      // 保留目录(功能上配置仍可用)并把两个失败一并上报;复原成功才清理本次版本。
      // r6 Major:清理失败同样不许吞,残留位置如实并入错误。
      const rm = verId && lr.ok ? removeMcpSecretVersionDir(userDataPath, name, verId) : { ok: true as const }
      const tails = [
        ...(lr.ok ? [] : [`config restore failed: ${lr.reason} — secret version kept (still referenced)`]),
        ...(rm.ok ? [] : [`secret version cleanup failed (${rm.reason}) — plaintext may remain in version "${verId}" pending gc`]),
      ]
      return { ok: false, reason: `install ledger write failed: ${led.reason}${tails.length ? `; ${tails.join("; ")}` : ""}` }
    }
    // 成功:收未被当前 leaf 引用且过宽限的旧版本/flat/快照残留(锁内对账;busy 跳过,best-effort)。
    const gc = gcMcpSecretsAgainstConfig(userDataPath, name)
    if (gc.warnings.length) console.error(`[ext-ipc] mcp secret gc (${name}): ${gc.warnings.join("; ")}`)
    return r
  }

  return { persistMcpBody }
}
