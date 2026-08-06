// REQ-128 Phase 3 `[T3-channel]`(#782)—— `local:` 命名空间的**唯一真源**。
//
// 为什么这个常量要单独立一个模块:它有**两个方向相反**的消费方,分居闸的两侧 ——
//   ① 本地铸造器(`claude-plugin-intake.ts` 的 `mintPackageId`)只准产这个前缀;
//   ② catalog admission(`package-admission.ts` 的 `resolvePreparedPackage`)必须**拒绝**
//      任何带这个前缀的已验签信封。
// 两处各写一份字面量 `"local:"` 就是「手写替身」:漂移的那一天,①仍然只产 `local:`、
// ②却在拦 `Local:` 或 `local-`,而两边的测试各自全绿。
//
// **纪律(基线 §8 纪律 2)**:这个前缀是**命名空间保留 + 合法性校验**,**不是行为判据**。
// 「这个包是不是本地来的」一律从 child record 的 `origin`(`imported-claude`)回答,
// **绝不从 packageId 前缀读结构** —— 那正是 `#737` 明令禁止的形状。本文件只提供
// 「id 属不属于这个命名空间」这一个问题的答案,不提供也不得被用来回答来源问题。

/** 本地导入包保留的 packageId 前缀。 */
export const LOCAL_PACKAGE_ID_PREFIX = "local:"

/**
 * 这个 packageId 落在本地命名空间里吗?
 *
 * **只用于命名空间合法性校验**(铸造侧只准产它、admission 侧必须拒它)。
 * 不得用于判断来源、信任级别、curation 维或任何用户可见语义。
 */
export function isLocalPackageId(packageId: string): boolean {
  return packageId.startsWith(LOCAL_PACKAGE_ID_PREFIX)
}
