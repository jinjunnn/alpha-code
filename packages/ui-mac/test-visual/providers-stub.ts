// 视觉 harness:composer 只用到 useCommand();其余上游 provider 不在本 harness 范围。
const command = { options: [], trigger: () => {} }
export const useCommand = () => command
