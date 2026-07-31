const EXTENSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export function isExtensionName(value: string): boolean {
  return EXTENSION_NAME.test(value)
}
