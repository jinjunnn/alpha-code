// `#777` —— 只为**当第一个文件**而存在(判据本体在 `gate-environment.cases.ts`)。
//
// 理由:preload 里的 `setDefaultTimeout()` 实测**只对一次运行的第一个测试文件生效**。
// 于是「多文件运行也拿得到抬高的超时」这一半,必须让慢用例**排在第二个文件**才验得到 ——
// 让慢的那个当第一个文件,会验成一件本来就成立的事(单文件那一半),给出假绿。

import { expect, test } from "bun:test"

test("占位:让慢用例落到第二个文件上", () => {
  expect(1).toBe(1)
})
