#!/usr/bin/env bun
// Build the embedded opencode server (dist/node/node.js) before `electron-vite dev`.
// The `virtual:opencode-server` alias resolves to that bundle. In the fork
// workspace, packages/opencode is a sibling of packages/ui-mac.
import { $ } from "bun"

await $`cd ../opencode && bun script/build-node.ts`
