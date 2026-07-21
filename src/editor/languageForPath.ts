const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bat: 'bat',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  cmd: 'bat',
  css: 'css',
  cxx: 'cpp',
  gql: 'graphql',
  go: 'go',
  graphql: 'graphql',
  h: 'cpp',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  m: 'objective-c',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  ps1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
}

const LANGUAGE_BY_FILENAME: Record<string, string> = {
  '.editorconfig': 'ini',
  '.gitattributes': 'ini',
  '.gitignore': 'shell',
  'cargo.lock': 'toml',
  'cargo.toml': 'toml',
  containerfile: 'dockerfile',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  'package.json': 'json',
}

export function languageForPath(path: string): string {
  const filename = path.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  const override = LANGUAGE_BY_FILENAME[filename]
  if (override) return override
  if (/^tsconfig(?:\.[^.]+)*\.json$/.test(filename)) return 'json'
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot === filename.length - 1) return 'plaintext'
  return LANGUAGE_BY_EXTENSION[filename.slice(dot + 1)] ?? 'plaintext'
}

const LANGUAGE_LABEL_BY_ID: Record<string, string> = {
  bat: 'Batch',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  dockerfile: 'Dockerfile',
  go: 'Go',
  graphql: 'GraphQL',
  html: 'HTML',
  ini: 'INI',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  kotlin: 'Kotlin',
  less: 'LESS',
  makefile: 'Makefile',
  markdown: 'Markdown',
  plaintext: 'Plain Text',
  powershell: 'PowerShell',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  shell: 'Shell',
  sql: 'SQL',
  toml: 'TOML',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
}

export function languageLabel(languageId: string): string {
  return LANGUAGE_LABEL_BY_ID[languageId] ?? languageId
}
