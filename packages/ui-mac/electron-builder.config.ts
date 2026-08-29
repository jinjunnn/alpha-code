import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

// REQ-089 AC3: the OS protocol list has exactly one source. The installer metadata that makes a
// cold-start deep link reach the app at all is derived from the same manifest the runtime
// registers and decodes against — a second hardcoded list here would silently desynchronise the
// packaged app from the running one.
import { DEEP_LINK_SCHEMES } from "./src/shared/route-manifest"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

export type Channel = "dev" | "beta" | "prod"

const channel: Channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// Signing + notarization run in CI, OR locally when ALPHA_SIGN=1 (once the Mac "Developer ID
// Application" cert for team RQX6X6A635 exists in the keychain + notary creds are in env). Otherwise a
// local `bun run package:mac` produces an ad-hoc–signed app you can double-click from dist/ — no cert
// needed. See docs/runbooks/distribution.md.
const isCI = process.env.GITHUB_ACTIONS === "true"
const shouldSign = isCI || process.env.ALPHA_SIGN === "1"
// Apple team (Beijing yuanyuji, RQX6X6A635 — same as tideapp) + notary creds are supplied via env at
// sign time (see docs/runbooks/distribution.md / ~/.alpha-code-signing/signing.env), not baked into config.

// Own bundle identity (com.tide.*, matching tideapp's convention) — NOT opencode's ai.opencode.desktop.
// Changing this from the old id is a deliberate one-time reset of the app's stored data (accepted:
// project FILES on disk are unaffected; only session history + recent-project list + login reset).
const APP_IDS = {
  dev: "com.tide.alphacode.dev",
  beta: "com.tide.alphacode.beta",
  prod: "com.tide.alphacode",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: "alpha-code-${os}-${arch}.${ext}",
  // MIT requires OpenCode's copyright + permission notice ship with the app (B15 / D10);
  // full text in resources/NOTICE.txt, also surfaced via app.setAboutPanelOptions.
  copyright: "© 2025 opencode (MIT). Code Puppy fork build.",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    // (REQ-076 T1 清理)原有指向 native/ 的条目为上游 desktop 遗留死配置:alpha 无 native/ 目录
    // (mac_window.node/swift-build 未克隆),打包时恒为空 no-op,已删。
    {
      // Bundled builtin skills (Extension Hub E1b): land at process.resourcesPath/skills so the main
      // process (ext-fs-installer.installBuiltinSkill) can copy them into the user's scanned dir.
      from: "resources/skills/",
      to: "skills/",
    },
    {
      // REQ-036 出厂技能(alpha 自写,如 agent-creator):经 skills.paths 注入引擎、零安装即用。
      // skill-creator 不在此目录 —— 它原位在 skills/(catalog 资产)被 factory-skills.ts 直接引用。
      from: "resources/factory-skills/",
      to: "factory-skills/",
    },
    {
      // REQ-133:四格式 Alpha stdio MCP 共用的一份 Python server。catalog 命令中的
      // {alphaResources} 由 main 替换为 process.resourcesPath,不让 renderer 猜 app 路径。
      from: "resources/office-mcp/",
      to: "office-mcp/",
    },
    {
      // REQ-023 T2:官方 agent md 资产(#361 起由 collectBuiltinAgentPayload 收集 → CAS →
      // 事务安装落 ~/.alpha/agents)。
      from: "resources/agents/",
      to: "agents/",
    },
    {
      // MIT license/attribution shipped inside the app (B15). Also surfaced natively via
      // app.setAboutPanelOptions in src/main/index.ts.
      from: "resources/NOTICE.txt",
      to: "NOTICE.txt",
    },
    {
      // REQ-102(#194):packaged extension seed(只读浏览面)。快照由
      // scripts/sync-extension-seed.mjs 从 alpha-web 已验签 stable 链交叉复核生成
      // (alpha-web contracts/extension-seed/CONTRACT.md §6.1),禁手编;落点
      // <process.resourcesPath>/extension-seed(seed.lock.json + NOTICE.md + blobs CAS 布局),
      // main 经 ext-seed.readPackagedSeed 消费(不安装、不启用)。
      from: "resources/extension-seed/",
      to: "extension-seed/",
    },
    {
      // B6(=G1):@alpha-code/ext 自包含 ESM bundle(prebuild 已构建)。落点
      // <resources>/alpha-ext/plugin.js,main 经 alpha-ext-plugin.ts 解析后由 sidecar 注入
      // OPENCODE_CONFIG_CONTENT 的 `plugin` 数组(零改上游,ADR-002/006)。
      from: "../ext/dist/",
      to: "alpha-ext/",
      filter: ["plugin.js"],
    },
    {
      // S17 T3(C17):构建期生成的 DB 迁移支持面清单(scripts/gen-db-expected.ts,prebuild 保证新鲜)。
      // db-safety 预检据此判定「DB 超前(阻断)/ 将前进(pre-migration 备份)」;文件 gitignore(构建产物)。
      from: "resources/db-expected-migrations.json",
      to: "db-expected-migrations.json",
    },
  ],
  // C27:Electron fuses 纵深防御。RunAsNode/NODE_OPTIONS/inspect 三个注入原语全关(全仓无
  // ELECTRON_RUN_AS_NODE 用法,sidecar 走 utilityProcess 不受影响;preload 的 install-cli 为无
  // handler 死通道);asar 完整性校验开启(mac 打包时 electron-builder 自动计算 integrity)。
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
  },
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    // Notarization requires hardenedRuntime + entitlements; only when actually signing.
    hardenedRuntime: shouldSign,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    // null => ad-hoc sign (no Developer ID, local dev builds). When signing, auto-discover the
    // "Developer ID Application" cert from the keychain (override with ALPHA_SIGN_IDENTITY).
    identity: shouldSign ? (process.env.ALPHA_SIGN_IDENTITY ?? undefined) : null,
    // electron-builder 26.x wants a boolean; notarytool creds/team come from env
    // (APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID).
    notarize: shouldSign,
    // Signed builds emit dmg+zip (distributable + updater); plain local builds emit the .app directly.
    target: shouldSign ? ["dmg", "zip"] : ["dir"],
  },
  dmg: {
    sign: shouldSign,
  },
  protocols: {
    name: "alpha-code",
    schemes: [...DEEP_LINK_SCHEMES],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

export function getConfig(target: Channel = channel) {
  const appId = APP_IDS[target]
  const base = getBase(appId)

  switch (target) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "Code Puppy",
        rpm: { packageName: "alpha-code" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "Code Puppy Beta",
        protocols: { name: "alpha-code Beta", schemes: [...DEEP_LINK_SCHEMES] },
        // Own public release repo (jinjunnn/alpha-code) — NOT anomalyco/opencode, which would auto-
        // download upstream OpenCode over alpha (B9). `beta` channel = pre-release feed.
        publish: { provider: "github", owner: "jinjunnn", repo: "alpha-code", channel: "beta" },
        rpm: { packageName: "alpha-code-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Code Puppy",
        protocols: { name: "alpha-code", schemes: [...DEEP_LINK_SCHEMES] },
        // Own public release repo (jinjunnn/alpha-code) — NOT anomalyco/opencode (B9 wrong-owner feed,
        // which would auto-download upstream OpenCode over alpha). `latest` = stable feed.
        publish: { provider: "github", owner: "jinjunnn", repo: "alpha-code", channel: "latest" },
        deb: { fpm: [legacyDesktopEntryFpm] },
        rpm: { packageName: "alpha-code", fpm: [legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
