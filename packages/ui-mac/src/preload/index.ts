import { contextBridge, ipcRenderer } from "electron"
import type { AlphaAPI } from "./types"

// contextIsolation bridge. Every method maps to an ipcMain handler in
// src/main/index.ts. Mirrors the desktop window.api shape but only the subset
// the custom Platform stub consumes.
const api: AlphaAPI = {
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  relaunch: () => ipcRenderer.send("relaunch"),

  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),

  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),

  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  setBackgroundColor: (color) => ipcRenderer.invoke("set-background-color", color),
}

contextBridge.exposeInMainWorld("api", api)
