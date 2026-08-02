import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'
import { JSDOM } from 'jsdom'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tauriSecurity = JSON.parse(readFileSync(join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8')).app?.security
const distRoot = join(repoRoot, 'dist')
const depInfoPath = join(repoRoot, 'src-tauri', 'target', 'release', 'deps', 'app_lib.d')
const exePath = resolve(process.argv[2] || join(repoRoot, 'src-tauri', 'target', 'release', 'app.exe'))

function fail(message) {
  throw new Error(message)
}

function dependencyPath(line) {
  const value = line.trim()
  if (!value.endsWith(':')) return null
  const withoutColon = value.slice(0, -1).replace(/^\\\\\?\\/, '')
  return normalize(resolve(withoutColon))
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [normalize(path)]
  })
}

function canModifyCsp(directive) {
  const disabled = tauriSecurity?.dangerousDisableAssetCspModification
  return disabled !== true && (!Array.isArray(disabled) || !disabled.includes(directive))
}

function transformHtml(source) {
  if (!tauriSecurity?.csp) return source

  const dom = new JSDOM(source)
  if (canModifyCsp('script-src')) {
    for (const script of dom.window.document.querySelectorAll('script[src^="http"]')) {
      script.setAttribute('nonce', '__TAURI_SCRIPT_NONCE__')
    }
  }
  if (canModifyCsp('style-src')) {
    for (const style of dom.window.document.querySelectorAll('style')) {
      style.setAttribute('nonce', '__TAURI_STYLE_NONCE__')
    }
  }
  return dom.serialize()
}

if (!existsSync(distRoot)) fail(`Frontend output is missing: ${distRoot}`)
if (!existsSync(depInfoPath)) fail(`Rust dependency manifest is missing: ${depInfoPath}`)
if (!existsSync(exePath)) fail(`Release executable is missing: ${exePath}`)

const lines = readFileSync(depInfoPath, 'utf8').split(/\r?\n/)
const embeddedBySource = new Map()
for (let index = 0; index + 1 < lines.length; index += 1) {
  const source = dependencyPath(lines[index])
  const compressed = dependencyPath(lines[index + 1])
  if (!source || !compressed || !compressed.includes(`${join('out', 'tauri-codegen-assets')}`)) continue
  if (relative(distRoot, source).startsWith('..')) continue
  embeddedBySource.set(source.toLowerCase(), compressed)
}

const distFiles = filesUnder(distRoot)
if (embeddedBySource.size !== distFiles.length) {
  fail(`Embedded asset manifest is stale: dist=${distFiles.length}, manifest=${embeddedBySource.size}`)
}

const executable = readFileSync(exePath)
for (const sourcePath of distFiles) {
  const displayPath = relative(distRoot, sourcePath)
  const compressedPath = embeddedBySource.get(sourcePath.toLowerCase())
  if (!compressedPath || !existsSync(compressedPath)) fail(`${displayPath} has no generated embedded payload`)

  const source = readFileSync(sourcePath)
  const compressed = readFileSync(compressedPath)
  const embedded = brotliDecompressSync(compressed)
  const expected = extname(sourcePath).toLowerCase() === '.html'
    ? Buffer.from(transformHtml(source.toString('utf8')))
    : source
  if (!expected.equals(embedded)) fail(`${displayPath} generated embedded payload is stale`)
  if (executable.indexOf(compressed) < 0) fail(`${basename(sourcePath)} payload is missing from ${basename(exePath)}`)
}

console.log(`Verified ${distFiles.length} current frontend assets in ${basename(exePath)}.`)
