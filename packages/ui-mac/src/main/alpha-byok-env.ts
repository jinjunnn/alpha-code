// B21:BYOK 钥匙库 → main env 桥的纯变更计算(electron-free,单测覆盖;消费方 alpha-byok-keys.ts)。
//
// 规则(改键/删键即时生效的关键):
//   - 用户自己提供的 env 值(shell export / alpha.env)**永不覆盖、永不删除**——首次注入时若 var 已存在
//     即视为用户值,归用户;
//   - 本模块自己注入过的 var(injected 集合追踪)是**权威可变**的:改键 → 覆盖(旧实现 set-if-unset
//     导致改键后旧值滞留 env → syncSecretFiles 镜像旧 key → 新 fork 仍用旧 key,即 B21 bug 根);
//     删键 → 删除(否则 provider 靠僵尸 env 继续复活)。
// 变更后由调用方触发 respawn → A6 的 syncSecretFiles 在 fork 时把新 env 镜像进 {file:} 通道。

export type ByokEnvMutations = { set: Record<string, string>; del: string[] }

/**
 * 计算本轮应做的 env 变更。
 * @param desired keyEnv → key(当前钥匙库解密态,已按 catalog 映射到 env var 名)
 * @param currentEnv 现有 process.env 视图
 * @param injected 此前由本模块注入过的 var 名(会被原地更新:新注入加入、删除移出)
 */
export function computeByokEnvMutations(
  desired: Record<string, string>,
  currentEnv: Record<string, string | undefined>,
  injected: Set<string>,
): ByokEnvMutations {
  const set: Record<string, string> = {}
  const del: string[] = []

  // 本模块注入过、但钥匙库里已经没有对应 key 的 var → 删(僵尸清理)
  for (const name of [...injected]) {
    if (desired[name] === undefined) {
      del.push(name)
      injected.delete(name)
    }
  }

  for (const [name, key] of Object.entries(desired)) {
    const isOurs = injected.has(name)
    const exists = currentEnv[name] !== undefined && !del.includes(name)
    if (!exists || isOurs) {
      if (currentEnv[name] !== key || !isOurs) set[name] = key
      injected.add(name)
    }
    // exists && !isOurs → 用户值,保持不动(set-if-unset 语义仅对用户值保留)
  }
  return { set, del }
}
