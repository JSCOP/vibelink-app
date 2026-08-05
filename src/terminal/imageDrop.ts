const IMAGE_PATH = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i

export function terminalImageDropText(paths: readonly string[]): string | null {
  if (paths.length === 0 || paths.some((path) => !IMAGE_PATH.test(path))) return null
  return paths.map((path) => `"${path}"`).join(' ')
}
