import { afterEach, describe, expect, test } from "bun:test"
import {
  consumeDanglingSweepCredit,
  creditDanglingSweepForSpawn,
  peekDanglingSweepCreditForTests,
  resetDanglingSweepLatchForTests,
} from "./dangling-sweep-latch"

afterEach(() => {
  resetDanglingSweepLatchForTests()
})

describe("dangling-sweep-latch (#982)", () => {
  test("consume without credit fails closed", () => {
    expect(() => consumeDanglingSweepCredit()).toThrow(/req053-dangling-sweep.*refused/)
  })

  test("credit then consume succeeds and clears the credit", () => {
    creditDanglingSweepForSpawn()
    expect(peekDanglingSweepCreditForTests()).toBe(true)
    consumeDanglingSweepCredit()
    expect(peekDanglingSweepCreditForTests()).toBe(false)
    expect(() => consumeDanglingSweepCredit()).toThrow(/req053-dangling-sweep.*refused/)
  })

  test("one credit is one spawn — second consume needs a new credit", () => {
    creditDanglingSweepForSpawn()
    consumeDanglingSweepCredit()
    creditDanglingSweepForSpawn()
    consumeDanglingSweepCredit()
    expect(peekDanglingSweepCreditForTests()).toBe(false)
  })
})
