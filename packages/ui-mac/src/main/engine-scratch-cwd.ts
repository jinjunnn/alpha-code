import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, parse, resolve } from "node:path"

export const ENGINE_SCRATCH_CWD_NAME = "engine-scratch-cwd"

export function resolveEngineScratchCwd(userDataPath: string, homeDir: string = homedir()) {
  if (!userDataPath.trim()) throw new Error("userData path is required for the engine scratch cwd")

  const directory = resolve(userDataPath, ENGINE_SCRATCH_CWD_NAME)
  if (directory === parse(directory).root || directory === resolve(homeDir)) {
    throw new Error("refusing unsafe engine scratch cwd")
  }
  return directory
}

export function ensureEngineScratchCwd(userDataPath: string) {
  const directory = resolveEngineScratchCwd(userDataPath)
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
    throw new Error("refusing symlinked engine scratch cwd")
  }

  mkdirSync(directory, { recursive: true })
  readdirSync(directory).forEach((entry) => rmSync(join(directory, entry), { recursive: true, force: true }))
  return directory
}
