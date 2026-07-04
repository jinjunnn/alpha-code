import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/index.ts
import { appendFileSync as appendFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";

// src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var DEFAULT_CONFIG = {
  sounds: {
    permission: "Submarine",
    error: "Basso"
  },
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "08:00"
  },
  notifyChildSessions: false,
  terminal: null,
  focusAfterAction: true,
  notifyOnIdle: false,
  nativeMacNotifications: true
};
function getConfigPath() {
  return join(homedir(), ".config", "opencode", "opencode-notify.json");
}
function loadConfig() {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  try {
    const contents = readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(contents);
    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
      sounds: { ...DEFAULT_CONFIG.sounds, ...userConfig.sounds },
      quietHours: { ...DEFAULT_CONFIG.quietHours, ...userConfig.quietHours }
    };
  } catch {
    console.warn("[opencode-notify] Failed to parse config, using defaults");
    return DEFAULT_CONFIG;
  }
}
function parseTime(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return { hours, minutes };
}
function isQuietHours(config) {
  if (!config.quietHours.enabled) {
    return false;
  }
  const now = new Date;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const start = parseTime(config.quietHours.start);
  const end = parseTime(config.quietHours.end);
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// src/terminal.ts
import { execSync } from "node:child_process";
function detectTerminal(configuredTerminal) {
  if (configuredTerminal) {
    return terminalInfoFromName(configuredTerminal);
  }
  const termProgram = process.env.TERM_PROGRAM?.toLowerCase();
  const lcTerminal = process.env.LC_TERMINAL?.toLowerCase();
  if (termProgram === "ghostty" || lcTerminal === "ghostty") {
    return {
      app: "ghostty",
      bundleId: "com.mitchellh.ghostty",
      processName: "ghostty"
    };
  }
  if (termProgram === "iterm.app") {
    return {
      app: "iterm",
      bundleId: "com.googlecode.iterm2",
      processName: "iTerm2"
    };
  }
  if (termProgram === "wezterm") {
    return {
      app: "wezterm",
      bundleId: "com.github.wez.wezterm",
      processName: "wezterm-gui"
    };
  }
  if (termProgram === "apple_terminal") {
    return {
      app: "terminal",
      bundleId: "com.apple.Terminal",
      processName: "Terminal"
    };
  }
  if (process.env.KITTY_WINDOW_ID) {
    return {
      app: "kitty",
      bundleId: "net.kovidgoyal.kitty",
      processName: "kitty"
    };
  }
  if (termProgram === "alacritty") {
    return {
      app: "alacritty",
      bundleId: "org.alacritty",
      processName: "Alacritty"
    };
  }
  if (termProgram === "hyper") {
    return {
      app: "hyper",
      bundleId: "co.zeit.hyper",
      processName: "Hyper"
    };
  }
  if (process.env.WT_SESSION) {
    return {
      app: "windows-terminal",
      processName: "WindowsTerminal"
    };
  }
  return { app: "unknown" };
}
function terminalInfoFromName(name) {
  const lowered = name.toLowerCase();
  const terminals = {
    ghostty: {
      app: "ghostty",
      bundleId: "com.mitchellh.ghostty",
      processName: "ghostty"
    },
    kitty: {
      app: "kitty",
      bundleId: "net.kovidgoyal.kitty",
      processName: "kitty"
    },
    iterm: {
      app: "iterm",
      bundleId: "com.googlecode.iterm2",
      processName: "iTerm2"
    },
    iterm2: {
      app: "iterm",
      bundleId: "com.googlecode.iterm2",
      processName: "iTerm2"
    },
    wezterm: {
      app: "wezterm",
      bundleId: "com.github.wez.wezterm",
      processName: "wezterm-gui"
    },
    terminal: {
      app: "terminal",
      bundleId: "com.apple.Terminal",
      processName: "Terminal"
    },
    alacritty: {
      app: "alacritty",
      bundleId: "org.alacritty",
      processName: "Alacritty"
    },
    hyper: { app: "hyper", bundleId: "co.zeit.hyper", processName: "Hyper" }
  };
  return terminals[lowered] ?? { app: "unknown" };
}
function isTerminalFocused(terminal) {
  const platform = process.platform;
  if (platform === "darwin") {
    return isMacOSAppFocused(terminal.processName ?? terminal.app);
  }
  if (platform === "linux") {
    return isLinuxAppFocused(terminal.processName);
  }
  if (platform === "win32") {
    return isWindowsAppFocused(terminal.processName);
  }
  return false;
}
function isMacOSAppFocused(bundleIdOrName) {
  if (!bundleIdOrName) {
    return false;
  }
  try {
    const script = `
      tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
        return frontApp
      end tell
    `;
    const result = execSync(`osascript -e '${script}'`, {
      encoding: "utf-8",
      timeout: 1000
    }).trim();
    return result.toLowerCase().includes(bundleIdOrName.toLowerCase());
  } catch {
    return false;
  }
}
function isLinuxAppFocused(processName) {
  if (!processName)
    return false;
  try {
    const windowId = execSync("xdotool getactivewindow", {
      encoding: "utf-8",
      timeout: 1000
    }).trim();
    const pid = execSync(`xdotool getwindowpid ${windowId}`, {
      encoding: "utf-8",
      timeout: 1000
    }).trim();
    const comm = execSync(`cat /proc/${pid}/comm`, {
      encoding: "utf-8",
      timeout: 1000
    }).trim();
    return comm.toLowerCase().includes(processName.toLowerCase());
  } catch {
    return false;
  }
}
function isWindowsAppFocused(processName) {
  if (!processName)
    return false;
  try {
    const script = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32 {
          [DllImport("user32.dll")]
          public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")]
          public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
        }
"@
      $hwnd = [Win32]::GetForegroundWindow()
      $pid = 0
      [void][Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
      (Get-Process -Id $pid).ProcessName
    `;
    const result = execSync(`powershell -Command "${script.replace(/"/g, "\\\"")}"`, {
      encoding: "utf-8",
      timeout: 2000
    }).trim();
    return result.toLowerCase().includes(processName.toLowerCase());
  } catch {
    return false;
  }
}
function focusTerminal(terminal) {
  const platform = process.platform;
  if (platform === "darwin" && terminal.bundleId) {
    try {
      execSync(`open -b "${terminal.bundleId}"`, { timeout: 2000 });
    } catch {}
  }
  if (platform === "linux" && terminal.processName) {
    try {
      execSync(`wmctrl -a "${terminal.processName}"`, { timeout: 2000 });
    } catch {}
  }
}

// src/notify/macos.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import { join as join2, dirname } from "node:path";
import { fileURLToPath } from "node:url";
var __dirname2 = dirname(fileURLToPath(import.meta.url));

class MacOSNotifier {
  notifierPath = null;
  async isAvailable() {
    this.notifierPath = this.findNotifier();
    return this.notifierPath !== null;
  }
  findNotifier() {
    const possiblePaths = [
      join2(__dirname2, "OpenCodeNotifier.app", "Contents", "MacOS", "opencode-notifier"),
      join2(__dirname2, "..", "OpenCodeNotifier.app", "Contents", "MacOS", "opencode-notifier"),
      join2(__dirname2, "..", "..", "OpenCodeNotifier.app", "Contents", "MacOS", "opencode-notifier")
    ];
    for (const binaryPath of possiblePaths) {
      if (existsSync2(binaryPath)) {
        return binaryPath;
      }
    }
    return null;
  }
  async notify(options) {
    if (!this.notifierPath) {
      throw new Error("OpenCodeNotifier not found");
    }
    const args = [
      "-title",
      options.title,
      "-message",
      options.message
    ];
    if (options.subtitle) {
      args.push("-subtitle", options.subtitle);
    }
    if (options.sound) {
      args.push("-sound", options.sound);
    }
    if (options.actions && options.actions.length > 0) {
      args.push("-actions", options.actions.join(","));
    }
    if (options.timeout) {
      args.push("-timeout", String(options.timeout));
    }
    if (options.activateBundleId) {
      args.push("-sender", options.activateBundleId);
    }
    args.push("-json");
    return new Promise((resolve, reject) => {
      const proc = spawn(this.notifierPath, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      proc.on("close", () => {
        try {
          const result = JSON.parse(stdout);
          resolve({
            action: result.action ?? "dismissed",
            activated: result.activated ?? false
          });
        } catch {
          resolve({
            action: "dismissed",
            activated: false
          });
        }
      });
      proc.on("error", reject);
    });
  }
}

// src/notify/macos-native.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync3, appendFileSync } from "node:fs";
import { join as join3, dirname as dirname2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { homedir as homedir2 } from "node:os";
var __dirname3 = dirname2(fileURLToPath2(import.meta.url));
function debugLog(msg) {
  appendFileSync(join3(homedir2(), ".opencode-notify.log"), `${new Date().toISOString()} [macos-native] ${msg}
`);
}

class MacOSNativeNotifier {
  notifierPath = null;
  async isAvailable() {
    debugLog(`isAvailable called, platform=${process.platform}`);
    if (process.platform !== "darwin") {
      return false;
    }
    this.notifierPath = this.findNotifier();
    debugLog(`notifierPath=${this.notifierPath}`);
    return this.notifierPath !== null;
  }
  findNotifier() {
    debugLog(`findNotifier: __dirname=${__dirname3}`);
    debugLog(`findNotifier: import.meta.url=${import.meta.url}`);
    const possiblePaths = [
      join3(__dirname3, "OpenCodeNotifier.app", "Contents", "MacOS", "opencode-notifier"),
      join3(__dirname3, "..", "OpenCodeNotifier.app", "Contents", "MacOS", "opencode-notifier"),
      join3(__dirname3, "..", "..", "OpenCodeNotifier.app", "Contents", "MacOS", "opencode-notifier")
    ];
    for (const binaryPath of possiblePaths) {
      const exists = existsSync3(binaryPath);
      debugLog(`Checking: ${binaryPath} = ${exists}`);
      if (exists) {
        return binaryPath;
      }
    }
    return null;
  }
  async notify(options) {
    if (!this.notifierPath) {
      throw new Error("OpenCodeNotifier not found");
    }
    const args = [
      "-native",
      "-title",
      options.title,
      "-message",
      options.message
    ];
    if (options.subtitle) {
      args.push("-subtitle", options.subtitle);
    }
    if (options.sound) {
      args.push("-sound", options.sound);
    }
    if (options.actions && options.actions.length > 0) {
      const primaryAction = options.actions.find((a) => a.toLowerCase() !== "dismiss");
      if (primaryAction) {
        args.push("-actions", primaryAction);
      }
    }
    if (options.timeout) {
      args.push("-timeout", String(options.timeout));
    }
    if (options.activateBundleId) {
      args.push("-sender", options.activateBundleId);
    }
    args.push("-json");
    return new Promise((resolve, reject) => {
      debugLog(`Spawning: ${this.notifierPath} ${args.join(" ")}`);
      debugLog(`Environment PATH: ${process.env.PATH}`);
      debugLog(`Current working directory: ${process.cwd()}`);
      const proc = spawn2(this.notifierPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env }
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("close", (code, signal) => {
        debugLog(`Process exited with code ${code}, signal ${signal}`);
        debugLog(`stdout: ${stdout}`);
        debugLog(`stderr: ${stderr}`);
        try {
          const result = JSON.parse(stdout);
          resolve({
            action: result.action ?? "dismissed",
            activated: result.activated ?? false
          });
        } catch {
          resolve({
            action: "dismissed",
            activated: false
          });
        }
      });
      proc.on("error", (err) => {
        debugLog(`Process error: ${err}`);
        reject(err);
      });
    });
  }
}

// src/notify/linux.ts
class LinuxNotifier {
  dbusNotifier = null;
  async isAvailable() {
    try {
      const moduleName = "node-dbus-notifier";
      this.dbusNotifier = await import(moduleName);
      return true;
    } catch {
      return this.hasNotifySend();
    }
  }
  hasNotifySend() {
    try {
      const { execSync: execSync2 } = __require("node:child_process");
      execSync2("which notify-send", { encoding: "utf-8", timeout: 1000 });
      return true;
    } catch {
      return false;
    }
  }
  async notify(options) {
    if (this.dbusNotifier) {
      return this.notifyWithDbus(options);
    }
    return this.notifyWithNotifySend(options);
  }
  async notifyWithDbus(options) {
    const { Notification } = this.dbusNotifier;
    return new Promise((resolve) => {
      const notification = new Notification({
        summary: options.title,
        body: options.message,
        actions: this.buildDbusActions(options.actions),
        hints: {
          urgency: { type: "y", value: 2 }
        },
        timeout: options.timeout ? options.timeout * 1000 : 0
      });
      notification.on("action", (actionKey) => {
        resolve({
          action: this.normaliseAction(actionKey),
          activated: true
        });
      });
      notification.on("close", (reason) => {
        if (reason === 1) {
          resolve({ action: "dismissed", activated: false });
        }
      });
      notification.show().catch(() => {
        resolve({ action: "dismissed", activated: false });
      });
    });
  }
  buildDbusActions(actions) {
    if (!actions || actions.length === 0) {
      return [];
    }
    return actions.map((label) => ({
      key: label.toLowerCase(),
      label
    }));
  }
  async notifyWithNotifySend(options) {
    const { execSync: execSync2 } = await import("node:child_process");
    const args = [];
    if (options.subtitle) {
      args.push(`${options.title}: ${options.subtitle}`);
    } else {
      args.push(options.title);
    }
    args.push(options.message);
    if (options.timeout) {
      args.push("-t", String(options.timeout * 1000));
    }
    try {
      execSync2(`notify-send ${args.map((a) => `"${a}"`).join(" ")}`, {
        timeout: 5000
      });
    } catch {}
    return { action: "dismissed", activated: false };
  }
  normaliseAction(actionKey) {
    const lowered = actionKey.toLowerCase();
    if (lowered === "accept")
      return "accept";
    if (lowered === "always")
      return "always";
    if (lowered === "reject")
      return "reject";
    return actionKey;
  }
}

// src/notify/windows.ts
class WindowsNotifier {
  powertoast = null;
  async isAvailable() {
    if (process.platform !== "win32") {
      return false;
    }
    try {
      this.powertoast = await import("powertoast");
      return true;
    } catch {
      return false;
    }
  }
  async notify(options) {
    if (!this.powertoast) {
      throw new Error("powertoast module not available");
    }
    const { Toast } = this.powertoast;
    return new Promise((resolve) => {
      const toast = new Toast({
        title: options.title,
        message: options.message,
        appId: "com.opencode.notify",
        actions: this.buildToastActions(options.actions),
        audio: options.sound !== undefined ? { src: this.mapSoundToWindows(options.sound) } : undefined
      });
      toast.on("activated", (event) => {
        const action = event.arguments ?? "accept";
        resolve({
          action: this.normaliseAction(action),
          activated: true
        });
      });
      toast.on("dismissed", (reason) => {
        resolve({
          action: "dismissed",
          activated: false
        });
      });
      toast.show().catch(() => {
        resolve({ action: "dismissed", activated: false });
      });
    });
  }
  buildToastActions(actions) {
    if (!actions || actions.length === 0) {
      return;
    }
    return actions.map((label) => ({
      content: label,
      arguments: label.toLowerCase()
    }));
  }
  mapSoundToWindows(macSound) {
    const soundMap = {
      Submarine: "ms-winsoundevent:Notification.Default",
      Glass: "ms-winsoundevent:Notification.IM",
      Basso: "ms-winsoundevent:Notification.Reminder",
      Ping: "ms-winsoundevent:Notification.Mail",
      Pop: "ms-winsoundevent:Notification.SMS"
    };
    return soundMap[macSound ?? ""] ?? "ms-winsoundevent:Notification.Default";
  }
  normaliseAction(actionArg) {
    const lowered = actionArg.toLowerCase();
    if (lowered === "accept")
      return "accept";
    if (lowered === "always")
      return "always";
    if (lowered === "reject")
      return "reject";
    return actionArg;
  }
}

// src/notify/index.ts
class NotificationDispatcher {
  notifier = null;
  initialised = false;
  config = null;
  async initialise(config) {
    if (this.initialised) {
      return this.notifier !== null;
    }
    this.initialised = true;
    this.config = config ?? null;
    const platform = process.platform;
    if (platform === "darwin") {
      if (this.config?.nativeMacNotifications) {
        const native = new MacOSNativeNotifier;
        if (await native.isAvailable()) {
          this.notifier = native;
          return true;
        }
      }
      const macos = new MacOSNotifier;
      if (await macos.isAvailable()) {
        this.notifier = macos;
        return true;
      }
    }
    if (platform === "linux") {
      const linux = new LinuxNotifier;
      if (await linux.isAvailable()) {
        this.notifier = linux;
        return true;
      }
    }
    if (platform === "win32") {
      const windows = new WindowsNotifier;
      if (await windows.isAvailable()) {
        this.notifier = windows;
        return true;
      }
    }
    console.warn(`[opencode-notify] No notification backend available for platform: ${platform}`);
    return false;
  }
  async notify(options) {
    if (!this.notifier) {
      const available = await this.initialise();
      if (!available || !this.notifier) {
        return { action: "dismissed", activated: false };
      }
    }
    return this.notifier.notify(options);
  }
  async showPermissionRequest(tool, command, sound, activateBundleId) {
    return this.notify({
      title: "Opencode Permission Request",
      subtitle: tool,
      message: command.length > 100 ? command.slice(0, 100) + "…" : command,
      sound,
      actions: ["Accept", "Always", "Reject", "Dismiss"],
      activateBundleId
    });
  }
  async showSessionComplete(message, sound, activateBundleId) {
    await this.notify({
      title: "Opencode",
      message,
      sound,
      activateBundleId
    });
  }
  async showError(message, sound, activateBundleId) {
    await this.notify({
      title: "Opencode Error",
      message,
      sound,
      activateBundleId
    });
  }
  async showQuestion(question, sound, activateBundleId) {
    return this.notify({
      title: "Opencode Question",
      message: question,
      sound,
      actions: ["View", "Dismiss"],
      activateBundleId
    });
  }
}

// src/index.ts
var LOG_FILE = join4(homedir3(), ".opencode-notify.log");
function log(message) {
  const timestamp = new Date().toISOString();
  appendFileSync2(LOG_FILE, `${timestamp} ${message}
`);
}
log("Module loaded");
var opencodeNotifyPlugin = async ({ client }) => {
  const config = loadConfig();
  const terminal = detectTerminal(config.terminal);
  const dispatcher = new NotificationDispatcher;
  const notifiedToolCalls = new Set;
  let isShowingNotification = false;
  let hasNotifiedIdle = false;
  const available = await dispatcher.initialise(config);
  if (!available) {
    log("No notification backend available for this platform.");
  }
  log("Initialised");
  return {
    "permission.ask": async (input, output) => {
      log("HOOK CALLED: permission.ask");
      hasNotifiedIdle = false;
      const patterns = Array.isArray(input.pattern) ? input.pattern.join(", ") : input.pattern ?? "";
      log(`permission.ask: id=${input.id}, type=${input.type}, pattern=${patterns}`);
      if (shouldSuppress(config, false)) {
        log(` Suppressed by config`);
        return;
      }
      if (isTerminalFocused(terminal)) {
        log(` Terminal is focused, skipping`);
        return;
      }
      if (isShowingNotification) {
        log(` Already showing a notification, skipping`);
        return;
      }
      const message = patterns || input.title || "Permission requested";
      log(`Showing permission notification: ${input.type} - ${message}`);
      isShowingNotification = true;
      try {
        const result = await dispatcher.showPermissionRequest(input.type, message, config.sounds.permission, terminal.bundleId);
        console.log(`[opencode-notify] Permission result: action=${result.action}, activated=${result.activated}`);
        const action = result.action.toLowerCase();
        if (action === "accept") {
          output.status = "allow";
        } else if (action === "always") {
          output.status = "allow";
          if (config.focusAfterAction) {
            focusTerminal(terminal);
          }
        } else if (action === "reject") {
          output.status = "deny";
        }
        if (result.activated && config.focusAfterAction && (action === "accept" || action === "always")) {
          focusTerminal(terminal);
        }
      } finally {
        isShowingNotification = false;
      }
    },
    event: async ({ event }) => {
      log(`EVENT RECEIVED: ${event.type}`);
      const eventType = event.type;
      if (eventType === "permission.asked") {
        hasNotifiedIdle = false;
        const props = event.properties;
        log(`permission.asked: id=${props.id}, permission=${props.permission}, patterns=${props.patterns?.join(", ")}`);
        if (shouldSuppress(config, false)) {
          log("Suppressed by config");
          return;
        }
        if (isTerminalFocused(terminal)) {
          log("Terminal is focused, skipping");
          return;
        }
        if (isShowingNotification) {
          log("Already showing a notification, skipping");
          return;
        }
        const permissionType = props.permission ?? "Permission";
        const patterns = props.patterns?.join(", ") ?? "";
        const message = patterns || "Permission requested";
        log(`Showing permission notification: ${permissionType} - ${message}`);
        isShowingNotification = true;
        try {
          log("Calling dispatcher.showPermissionRequest...");
          const result = await dispatcher.showPermissionRequest(permissionType, message, config.sounds.permission, terminal.bundleId);
          log(`Permission result: action=${result.action}, activated=${result.activated}`);
          const action = result.action.toLowerCase();
          let reply = null;
          if (action === "accept") {
            reply = "once";
          } else if (action === "always") {
            reply = "always";
          } else if (action === "reject") {
            reply = "reject";
          }
          if (reply && props.id && props.sessionID) {
            try {
              log(`Sending permission reply: ${reply} for ${props.id} (session: ${props.sessionID})`);
              await client.postSessionIdPermissionsPermissionId({
                path: {
                  id: props.sessionID,
                  permissionID: props.id
                },
                body: {
                  response: reply
                }
              });
              log(`Permission reply sent successfully`);
            } catch (replyErr) {
              log(`Error sending permission reply: ${replyErr}`);
            }
          }
          if (result.activated && config.focusAfterAction && action !== "dismissed") {
            focusTerminal(terminal);
          }
        } catch (err) {
          log(`Error showing notification: ${err}`);
        } finally {
          isShowingNotification = false;
        }
        return;
      }
      switch (event.type) {
        case "message.part.updated": {
          hasNotifiedIdle = false;
          const props = event.properties;
          const part = props.part;
          if (part?.type === "tool" && part?.tool?.toLowerCase() === "askuserquestion" && part?.state?.status === "pending") {
            const callId = part.id ?? `part-AskUserQuestion-${Date.now()}`;
            if (notifiedToolCalls.has(callId)) {
              log(` Already notified for question: ${callId}`);
              return;
            }
            notifiedToolCalls.add(callId);
            log(` message.part.updated: AskUserQuestion detected, id=${callId}`);
            if (shouldSuppress(config, false)) {
              log(` Suppressed by config`);
              return;
            }
            if (isTerminalFocused(terminal)) {
              log(` Terminal is focused, skipping`);
              return;
            }
            if (isShowingNotification) {
              log(` Already showing a notification, skipping`);
              return;
            }
            const firstQuestion = part.input?.questions?.[0]?.question;
            const message = firstQuestion ?? "Opencode has a question for you";
            log(` Showing question notification: ${message.slice(0, 50)}...`);
            isShowingNotification = true;
            try {
              const result = await dispatcher.showQuestion(message, config.sounds.permission, terminal.bundleId);
              log(` Question result: action=${result.action}, activated=${result.activated}`);
              if (result.activated && config.focusAfterAction && result.action.toLowerCase() !== "dismiss") {
                focusTerminal(terminal);
              }
            } finally {
              isShowingNotification = false;
            }
          }
          break;
        }
        case "message.updated": {
          hasNotifiedIdle = false;
          const info = event.properties.info;
          if (info.role !== "assistant") {
            return;
          }
          const parts = info.parts;
          if (!Array.isArray(parts) || parts.length === 0) {
            return;
          }
          for (const part of parts) {
            const p = part;
            if (p.type === "tool" && p.tool?.toLowerCase() === "askuserquestion" && p.state?.status === "pending") {
              const callId = p.id ?? `${info.id}-AskUserQuestion`;
              if (notifiedToolCalls.has(callId)) {
                log(` Already notified for question: ${callId}`);
                return;
              }
              notifiedToolCalls.add(callId);
              log(` message.updated: AskUserQuestion detected, id=${callId}`);
              if (shouldSuppress(config, false)) {
                log(` Suppressed by config`);
                return;
              }
              if (isTerminalFocused(terminal)) {
                log(` Terminal is focused, skipping`);
                return;
              }
              if (isShowingNotification) {
                log(` Already showing a notification, skipping`);
                return;
              }
              const firstQuestion = p.input?.questions?.[0]?.question;
              const message = firstQuestion ?? "Opencode has a question for you";
              log(` Showing question notification: ${message.slice(0, 50)}...`);
              isShowingNotification = true;
              try {
                const result = await dispatcher.showQuestion(message, config.sounds.permission, terminal.bundleId);
                log(` Question result: action=${result.action}, activated=${result.activated}`);
                if (result.activated && config.focusAfterAction && result.action.toLowerCase() !== "dismiss") {
                  focusTerminal(terminal);
                }
              } finally {
                isShowingNotification = false;
              }
              return;
            }
          }
          break;
        }
        case "permission.updated": {
          hasNotifiedIdle = false;
          const props = event.properties;
          console.log(`[opencode-notify] permission.updated: id=${props.id}, type=${props.type}`);
          if (shouldSuppress(config, false)) {
            log(` Suppressed by config`);
            return;
          }
          if (isTerminalFocused(terminal)) {
            log(` Terminal is focused, skipping`);
            return;
          }
          if (isShowingNotification) {
            log(` Already showing a notification, skipping`);
            return;
          }
          const command = props.title ?? "Permission requested";
          console.log(`[opencode-notify] Showing permission.updated notification: ${props.type} - ${command}`);
          isShowingNotification = true;
          try {
            const result = await dispatcher.showPermissionRequest(props.type, command, config.sounds.permission, terminal.bundleId);
            console.log(`[opencode-notify] Permission result: action=${result.action}, activated=${result.activated}`);
            if (config.focusAfterAction && result.action.toLowerCase() !== "dismiss") {
              focusTerminal(terminal);
            }
          } finally {
            isShowingNotification = false;
          }
          break;
        }
        case "session.error": {
          const props = event.properties;
          if (shouldSuppress(config, false)) {
            return;
          }
          if (isTerminalFocused(terminal)) {
            return;
          }
          const errorData = props.error?.data;
          const message = errorData?.message ?? "An error occurred";
          await dispatcher.showError(message, config.sounds.error, terminal.bundleId);
          break;
        }
        case "session.idle": {
          if (!config.notifyOnIdle) {
            return;
          }
          if (hasNotifiedIdle) {
            return;
          }
          if (shouldSuppress(config, false)) {
            return;
          }
          if (isTerminalFocused(terminal)) {
            return;
          }
          hasNotifiedIdle = true;
          await dispatcher.showSessionComplete("Agent has stopped and is waiting for input", config.sounds.permission, terminal.bundleId);
          break;
        }
      }
    },
    "tool.execute.before": async (input, output) => {
      log(`HOOK CALLED: tool.execute.before - ${input.tool}`);
      hasNotifiedIdle = false;
      if (input.tool.toLowerCase() !== "askuserquestion") {
        return;
      }
      const callId = input.callID ?? `tool-${Date.now()}`;
      log(` tool.execute.before: AskUserQuestion, callID=${callId}`);
      if (notifiedToolCalls.has(callId)) {
        log(` Already notified for question: ${callId}`);
        return;
      }
      notifiedToolCalls.add(callId);
      if (shouldSuppress(config, false)) {
        log(` Suppressed by config`);
        return;
      }
      if (isTerminalFocused(terminal)) {
        log(` Terminal is focused, skipping`);
        return;
      }
      if (isShowingNotification) {
        log(` Already showing a notification, skipping`);
        return;
      }
      const args = output.args;
      const firstQuestion = args?.questions?.[0]?.question;
      const message = firstQuestion ?? "Opencode has a question for you";
      log(` Showing question notification (tool.execute.before): ${message.slice(0, 50)}...`);
      isShowingNotification = true;
      try {
        const result = await dispatcher.showQuestion(message, config.sounds.permission, terminal.bundleId);
        log(` Question result: action=${result.action}, activated=${result.activated}`);
        if (result.activated && config.focusAfterAction && result.action.toLowerCase() !== "dismiss") {
          focusTerminal(terminal);
        }
      } finally {
        isShowingNotification = false;
      }
    }
  };
};
function shouldSuppress(config, isChildSession) {
  if (isQuietHours(config)) {
    return true;
  }
  if (isChildSession && !config.notifyChildSessions) {
    return true;
  }
  return false;
}
var src_default = opencodeNotifyPlugin;
export {
  opencodeNotifyPlugin,
  src_default as default
};
