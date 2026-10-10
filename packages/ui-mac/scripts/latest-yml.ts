// electron-updater feed(latest*.yml)的最小解析/序列化 —— finalize-latest-yml.ts(CI 合并)与
// merge-latest-mac-yml.ts(#1496 本地合并 mac 两种架构)共用一份,不各写一遍。

export type FileEntry = {
  url: string
  sha512: string
  size: number
  blockMapSize?: number
}

export type LatestYml = {
  version: string
  files: FileEntry[]
  releaseDate: string
}

export function parse(content: string): LatestYml {
  const lines = content.split("\n")
  let version = ""
  let releaseDate = ""
  const files: FileEntry[] = []
  let current: Partial<FileEntry> | undefined

  const flush = () => {
    if (current?.url && current.sha512 && current.size) files.push(current as FileEntry)
    current = undefined
  }

  for (const line of lines) {
    const indented = line.startsWith("    ") || line.startsWith("  -")
    if (line.startsWith("version:")) version = line.slice("version:".length).trim()
    else if (line.startsWith("releaseDate:"))
      releaseDate = line.slice("releaseDate:".length).trim().replace(/^'|'$/g, "")
    else if (line.trim().startsWith("- url:")) {
      flush()
      current = { url: line.trim().slice("- url:".length).trim() }
    } else if (indented && current && line.trim().startsWith("sha512:"))
      current.sha512 = line.trim().slice("sha512:".length).trim()
    else if (indented && current && line.trim().startsWith("size:"))
      current.size = Number(line.trim().slice("size:".length).trim())
    else if (indented && current && line.trim().startsWith("blockMapSize:"))
      current.blockMapSize = Number(line.trim().slice("blockMapSize:".length).trim())
    else if (!indented && current) flush()
  }
  flush()

  return { version, files, releaseDate }
}

export function serialize(data: LatestYml) {
  const lines = [`version: ${data.version}`, "files:"]
  for (const file of data.files) {
    lines.push(`  - url: ${file.url}`)
    lines.push(`    sha512: ${file.sha512}`)
    lines.push(`    size: ${file.size}`)
    if (file.blockMapSize) lines.push(`    blockMapSize: ${file.blockMapSize}`)
  }
  lines.push(`releaseDate: '${data.releaseDate}'`)
  return lines.join("\n") + "\n"
}

/**
 * #1496:mac 两种架构分两轮打包,每轮都写一份只含本架构的 `latest-mac.yml`(后一轮覆盖前一轮)。
 * 合并成一份同时列出两种架构的 feed —— electron-updater 在 mac 上按文件名里的 arch 选自己那一份。
 * 版本不一致、或某一份里混进了另一种架构的文件,直接抛:错的 feed 会让 Intel 机器拉到 arm64 包。
 */
export function mergeMacFeeds(arm64: LatestYml, x64: LatestYml): LatestYml {
  if (arm64.version !== x64.version) throw new Error(`arm64 feed 版本 ${arm64.version} ≠ x64 feed 版本 ${x64.version}`)
  const check = (feed: LatestYml, arch: "arm64" | "x64") => {
    if (feed.files.length === 0) throw new Error(`${arch} feed 没有任何文件`)
    for (const f of feed.files)
      if (!f.url.includes(`-mac-${arch}.`)) throw new Error(`${arch} feed 里出现了不属于 ${arch} 的文件:${f.url}`)
  }
  check(arm64, "arm64")
  check(x64, "x64")
  const releaseDate = arm64.releaseDate > x64.releaseDate ? arm64.releaseDate : x64.releaseDate
  return { version: arm64.version, files: [...arm64.files, ...x64.files], releaseDate }
}
