import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'
import { JSDOM } from 'jsdom'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tauriSecurity = JSON.parse(readFileSync(join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8')).app?.security
const distRoot = resolve(process.argv[4] || join(repoRoot, 'dist'))
const depInfoPath = resolve(process.argv[3] || join(repoRoot, 'src-tauri', 'target', 'release', 'deps', 'app_lib.d'))
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

function expectedAsset(sourcePath) {
  const source = readFileSync(sourcePath)
  return extname(sourcePath).toLowerCase() === '.html'
    ? Buffer.from(transformHtml(source.toString('utf8')))
    : source
}

function contentKey(source) {
  return createHash('sha256').update(source).digest('hex')
}

if (!existsSync(distRoot)) fail(`Frontend output is missing: ${distRoot}`)
if (!existsSync(depInfoPath)) fail(`Rust dependency manifest is missing: ${depInfoPath}`)
if (!existsSync(exePath)) fail(`Release executable is missing: ${exePath}`)

const lines = readFileSync(depInfoPath, 'utf8').split(/\r?\n/)
const trackedSources = new Map()
const embeddedBySource = new Map()
for (let index = 0; index < lines.length; index += 1) {
  const source = dependencyPath(lines[index])
  if (!source || relative(distRoot, source).startsWith('..')) continue

  const sourceKey = source.toLowerCase()
  trackedSources.set(sourceKey, source)
  const compressed = dependencyPath(lines[index + 1] || '')
  if (compressed?.includes(`${join('out', 'tauri-codegen-assets')}`)) {
    embeddedBySource.set(sourceKey, compressed)
  }
}

const distFiles = filesUnder(distRoot)
const distSourceKeys = new Set(distFiles.map((sourcePath) => sourcePath.toLowerCase()))
if (
  trackedSources.size !== distFiles.length
  || distFiles.some((sourcePath) => !trackedSources.has(sourcePath.toLowerCase()))
  || [...trackedSources.keys()].some((sourceKey) => !distSourceKeys.has(sourceKey))
) {
  fail(`Embedded asset manifest is stale: dist=${distFiles.length}, manifest=${trackedSources.size}`)
}

const unresolvedSources = distFiles.filter((sourcePath) => !embeddedBySource.has(sourcePath.toLowerCase()))
if (unresolvedSources.length > 0) {
  const embeddedByContent = new Map()
  for (const [sourceKey, compressedPath] of embeddedBySource) {
    embeddedByContent.set(contentKey(expectedAsset(trackedSources.get(sourceKey))), compressedPath)
  }
  for (const sourcePath of unresolvedSources) {
    const compressedPath = embeddedByContent.get(contentKey(expectedAsset(sourcePath)))
    if (compressedPath) embeddedBySource.set(sourcePath.toLowerCase(), compressedPath)
  }
}

const executable = readFileSync(exePath)
for (const sourcePath of distFiles) {
  const displayPath = relative(distRoot, sourcePath)
  const compressedPath = embeddedBySource.get(sourcePath.toLowerCase())
  if (!compressedPath || !existsSync(compressedPath)) fail(`${displayPath} has no generated embedded payload`)

  const compressed = readFileSync(compressedPath)
  const embedded = brotliDecompressSync(compressed)

  const expected = expectedAsset(sourcePath)
  if (!expected.equals(embedded)) fail(`${displayPath} generated embedded payload is stale`)
  if (executable.indexOf(compressed) < 0) fail(`${basename(sourcePath)} payload is missing from ${basename(exePath)}`)
}

console.log(`Verified ${distFiles.length} current frontend assets in ${basename(exePath)}.`)
