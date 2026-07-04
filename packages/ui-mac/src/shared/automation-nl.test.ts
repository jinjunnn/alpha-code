// REQ-021 A1.2 —— 一句话确定性解析单测(中英句式 × schedule/prompt 拆分 × 诚实降级)。

import { describe, expect, test } from "bun:test"
import { parseAutomationText } from "./automation-nl"

describe("中文 · 天级", () => {
  test("每天早上 9 点 + 指令拆分", () => {
    const r = parseAutomationText("每天早上 9 点,检查本项目未处理的 TODO 并生成清单")
    expect(r.schedule).toEqual({ kind: "cron", expr: "0 9 * * *" })
    expect(r.prompt).toBe("检查本项目未处理的 TODO 并生成清单")
  })
  test("每天 18:30(冒号形)", () => {
    expect(parseAutomationText("每天 18:30 总结今日提交").schedule).toEqual({ kind: "cron", expr: "30 18 * * *" })
  })
  test("下午/晚上 +12;X点半", () => {
    expect(parseAutomationText("每天下午 3 点半 汇总").schedule).toEqual({ kind: "cron", expr: "30 15 * * *" })
    expect(parseAutomationText("每晚 10 点 备份笔记").schedule).toEqual({ kind: "cron", expr: "0 22 * * *" })
  })
  test("每天没写时刻 → 默认 09:00(预览可改)", () => {
    expect(parseAutomationText("每天 检查 CI 状态").schedule).toEqual({ kind: "cron", expr: "0 9 * * *" })
  })
  test("工作日 / 周末", () => {
    expect(parseAutomationText("工作日 9 点 站会准备").schedule).toEqual({ kind: "cron", expr: "0 9 * * 1-5" })
    expect(parseAutomationText("周末 10 点 整理 issue").schedule).toEqual({ kind: "cron", expr: "0 10 * * 0,6" })
  })
  test("每周一;多日列举 周一和周四", () => {
    expect(parseAutomationText("每周一 9 点 周报").schedule).toEqual({ kind: "cron", expr: "0 9 * * 1" })
    expect(parseAutomationText("每周一和周四 9 点 同步").schedule).toEqual({ kind: "cron", expr: "0 9 * * 1,4" })
  })
  test("每月 1 号", () => {
    expect(parseAutomationText("每月 1 号 9 点 出月报").schedule).toEqual({ kind: "cron", expr: "0 9 1 * *" })
  })
})

describe("中文 · interval", () => {
  test("每 30 分钟 / 每 2 小时 / 每半小时", () => {
    expect(parseAutomationText("每 30 分钟检查一次构建").schedule).toEqual({ kind: "interval", everyMinutes: 30 })
    expect(parseAutomationText("每 2 小时同步依赖").schedule).toEqual({ kind: "interval", everyMinutes: 120 })
    expect(parseAutomationText("每半小时看一眼队列").schedule).toEqual({ kind: "interval", everyMinutes: 30 })
  })
})

describe("english", () => {
  test("every day at 9am / daily at 18:30", () => {
    expect(parseAutomationText("every day at 9am summarize new commits").schedule).toEqual({ kind: "cron", expr: "0 9 * * *" })
    expect(parseAutomationText("daily at 18:30 check TODOs").schedule).toEqual({ kind: "cron", expr: "30 18 * * *" })
  })
  test("every monday at 9 / weekdays at 8:15 / monthly on the 1st", () => {
    expect(parseAutomationText("every monday at 9 write weekly report").schedule).toEqual({ kind: "cron", expr: "0 9 * * 1" })
    expect(parseAutomationText("weekdays at 8:15 standup prep").schedule).toEqual({ kind: "cron", expr: "15 8 * * 1-5" })
    expect(parseAutomationText("monthly on the 1st at 9am billing check").schedule).toEqual({ kind: "cron", expr: "0 9 1 * *" })
  })
  test("every 15 minutes / hourly", () => {
    expect(parseAutomationText("every 15 minutes poll the queue").schedule).toEqual({ kind: "interval", everyMinutes: 15 })
    expect(parseAutomationText("hourly check the deploy").schedule).toEqual({ kind: "interval", everyMinutes: 60 })
  })
  test("pm 换算 + 指令拆分", () => {
    const r = parseAutomationText("every day at 6pm collect release notes")
    expect(r.schedule).toEqual({ kind: "cron", expr: "0 18 * * *" })
    expect(r.prompt).toBe("collect release notes")
  })
})

describe("诚实降级", () => {
  test("解析不出周期 → schedule:null,原文整句作指令", () => {
    const r = parseAutomationText("把 README 里的安装步骤更新一下")
    expect(r.schedule).toBeNull()
    expect(r.prompt).toBe("把 README 里的安装步骤更新一下")
  })
  test("孤立时刻不猜周期", () => {
    expect(parseAutomationText("9 点跑一下测试").schedule).toBeNull()
  })
  test("空输入", () => {
    expect(parseAutomationText("  ").schedule).toBeNull()
  })
  test("interval 越界(0 分钟)不接受", () => {
    expect(parseAutomationText("每 0 分钟刷一次").schedule).toBeNull()
  })
})
