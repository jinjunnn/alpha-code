/// <reference types="vite/client" />
import type { AlphaAPI } from "../preload/types"

declare global {
  interface Window {
    api: AlphaAPI
  }
}

// The embedded opencode server, resolved by the `virtual:opencode-server` Vite
// alias to the submodule build (opencode/packages/opencode/dist/node/node.js).
// Typed loosely here; the real type lives in the submodule and is not imported
// to keep the read-only boundary clean.
declare module "virtual:opencode-server" {
  export const Server: {
    listen(opts: {
      port: number
      hostname: string
      username?: string
      password?: string
      cors?: string[]
    }): Promise<{ stop(close?: boolean): void | Promise<void> }>
  }
}

export {}
