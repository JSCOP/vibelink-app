import { describe, expect, test } from 'vitest'
import { languageForPath } from './languageForPath'

describe('languageForPath', () => {
  test.each([
    ['src/app.ts', 'typescript'],
    ['src/view.tsx', 'typescript'],
    ['src/app.js', 'javascript'],
    ['src/view.jsx', 'javascript'],
    ['src/main.rs', 'rust'],
    ['cmd/main.go', 'go'],
    ['script.py', 'python'],
    ['script.rb', 'ruby'],
    ['Main.java', 'java'],
    ['native/file.c', 'c'],
    ['native/file.cpp', 'cpp'],
    ['native/file.hpp', 'cpp'],
    ['Program.cs', 'csharp'],
    ['Main.kt', 'kotlin'],
    ['index.html', 'html'],
    ['style.css', 'css'],
    ['style.scss', 'scss'],
    ['style.less', 'less'],
    ['data.json', 'json'],
    ['data.jsonc', 'json'],
    ['config.yaml', 'yaml'],
    ['config.toml', 'toml'],
    ['data.xml', 'xml'],
    ['README.md', 'markdown'],
    ['guide.mdx', 'markdown'],
    ['run.sh', 'shell'],
    ['profile.ps1', 'powershell'],
    ['run.cmd', 'bat'],
    ['query.sql', 'sql'],
    ['schema.graphql', 'graphql'],
    ['Dockerfile', 'dockerfile'],
    ['Containerfile', 'dockerfile'],
    ['Makefile', 'makefile'],
    ['.gitignore', 'shell'],
    ['.gitattributes', 'ini'],
    ['.editorconfig', 'ini'],
    ['Cargo.toml', 'toml'],
    ['Cargo.lock', 'toml'],
    ['package.json', 'json'],
    ['tsconfig.app.json', 'json'],
  ])('%s resolves to %s', (path, language) => {
    expect(languageForPath(path)).toBe(language)
  })

  test('uses plaintext for unknown text paths', () => {
    expect(languageForPath('notes.custom')).toBe('plaintext')
    expect(languageForPath('LICENSE')).toBe('plaintext')
  })
})
