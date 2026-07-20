// REQ-047:探测子 shell 的最小干净 env —— 会话级隔离/调试变量绝不随继承进入登录 shell 探测
// (毒化源头封堵;读侧兜底见 shell-env-cache.test.ts)。

import { describe, expect, test } from "bun:test"
import { minimalProbeEnv } from "./shell-env"

describe("minimalProbeEnv (REQ-047 探针净化)", () => {
  test("只透传自举白名单,PATH 固定系统底座", () => {
    const env = minimalProbeEnv({
      HOME: "/Users/u",
      USER: "u",
      SHELL: "/bin/zsh",
      LANG: "zh_CN.UTF-8",
      PATH: "/opt/homebrew/bin:/custom",
      ALPHA_GLOBAL_DIR: "/tmp/dead/m1-alpha-home",
      ALPHA_ENV_BASE_DIR: "/tmp/dead/state-base",
      OPENCODE_CONFIG_DIR: "/tmp/dead/m1-legacy",
      ALPHA_CDP: "1",
      ALPHA_MIGRATE_ENABLE: "1",
      DEEPSEEK_API_KEY: "sk-should-not-leak-into-probe",
      NVM_DIR: "/Users/u/.nvm",
    })
    expect(env).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/Users/u",
      USER: "u",
      SHELL: "/bin/zsh",
      LANG: "zh_CN.UTF-8",
    })
  })

  test("白名单键缺失/空值不透传(不造键)", () => {
    expect(minimalProbeEnv({ HOME: "", TERM: undefined })).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" })
  })
})
