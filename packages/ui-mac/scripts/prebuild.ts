#!/usr/bin/env bun
// Same as predev: produce dist/node/node.js for the production bundle.
// packages/opencode is a sibling of packages/ui-mac in the fork workspace.
import { $ } from "bun"

await $`cd ../opencode && bun script/build-node.ts`
