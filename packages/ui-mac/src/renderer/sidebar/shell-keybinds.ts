// 壳级命令的默认键位 —— 唯一来源。侧栏注册(`alpha-sidebar.tsx` 的 `alpha.shell`)与设置页快捷键
// 一节(占位与键帽)都读这里,不各写一份(#1593 AC1)。写法是上游 `parseKeybind` 认的文字形式。
export const SHELL_KEYBINDS = {
  "settings.open": "mod+comma",
  "session.new": "mod+shift+s",
  "project.open": "mod+o",
  "sidebar.toggle": "mod+b",
} as const
