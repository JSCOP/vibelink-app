import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const sourceBudgets = {
  'src/App.css': 7_373,
  'src/layout/WorkspaceView.tsx': 2_555,
  'src/terminal/TerminalManager.ts': 2_372,
  'src/state/store.ts': 2_338,
  'src/components/git/GitWorkspaceProvider.tsx': 1_516,
}

const bundleBudgets = [
  ['App', /^App-.*\.js$/, 480_256],
  ['TerminalManager', /^TerminalManager-.*\.js$/, 589_824],
  ['store', /^store-.*\.js$/, 399_360],
  ['Monaco', /^monaco-.*\.js$/, 1_285_120],
  ['TypeScript worker', /^ts\.worker-.*\.js$/, 6_916_096],
]

function lineCount(text) {
  if (!text) return 0
  return text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0)
}

function staticGraph(manifest, entry) {
  const keys = new Set()
  const visit = (key) => {
    if (keys.has(key)) return
    const chunk = manifest[key]
    if (!chunk) throw new Error(`Manifest entry is missing: ${key}`)
    keys.add(key)
    for (const dependency of chunk.imports ?? []) visit(dependency)
  }
  visit(entry)
  return keys
}

function graphBytes(manifest, keys, dist) {
  const files = new Set()
  for (const key of keys) {
    const chunk = manifest[key]
    files.add(chunk.file)
    for (const file of chunk.css ?? []) files.add(file)
    for (const file of chunk.assets ?? []) files.add(file)
  }
  return [...files].reduce((total, file) => total + statSync(join(dist, file)).size, 0)
}

function overBudget(label, actual, maximum, failures) {
  if (actual > maximum) failures.push(`${label}: ${actual.toLocaleString()} > ${maximum.toLocaleString()}`)
}

function report(label, failures) {
  if (failures.length) {
    console.error(`${label} failed:\n- ${failures.join('\n- ')}`)
    process.exitCode = 1
  } else {
    console.log(`${label} passed`)
  }
}

function checkSources() {
  const failures = []
  for (const [file, maximum] of Object.entries(sourceBudgets)) {
    overBudget(file, lineCount(readFileSync(join(root, file), 'utf8')), maximum, failures)
  }
  report('Source line ratchet', failures)
}

function checkBundles() {
  const dist = join(root, 'dist')
  const assets = join(dist, 'assets')
  const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'))
  const failures = []
  const bootstrap = staticGraph(manifest, 'index.html')
  const terminalWorkspace = staticGraph(manifest, 'src/App.tsx')

  overBudget('Bootstrap static graph', graphBytes(manifest, bootstrap, dist), 263_168, failures)
  overBudget('Terminal workspace static graph', graphBytes(manifest, terminalWorkspace, dist), 2_176_000, failures)

  const eagerHeavyChunks = [...terminalWorkspace]
    .map((key) => `${key} ${manifest[key].file}`)
    .filter((value) => /monaco|editor\.api|worker/i.test(value))
  if (eagerHeavyChunks.length) failures.push(`Monaco/worker became eager: ${eagerHeavyChunks.join(', ')}`)

  const assetNames = readdirSync(assets)
  for (const [label, pattern, maximum] of bundleBudgets) {
    const matches = assetNames.filter((name) => pattern.test(name))
    if (matches.length !== 1) {
      failures.push(`${label}: expected one matching chunk, found ${matches.length}`)
      continue
    }
    overBudget(label, statSync(join(assets, matches[0])).size, maximum, failures)
  }
  report('Bundle ratchet', failures)
}

function selfTest() {
  assert.equal(lineCount('one\r\n\r\nthree\n'), 3)
  const manifest = {
    'index.html': { file: 'assets/index.js', imports: ['_shared.js'], dynamicImports: ['src/editor/monaco.ts'] },
    '_shared.js': { file: 'assets/shared.js' },
    'src/editor/monaco.ts': { file: 'assets/monaco.js' },
  }
  assert.deepEqual([...staticGraph(manifest, 'index.html')], ['index.html', '_shared.js'])
  assert.throws(() => staticGraph(manifest, 'missing'), /Manifest entry is missing/)
  console.log('Quality ratchet self-test passed')
}

const mode = process.argv[2]
try {
  if (mode === 'source') checkSources()
  else if (mode === 'bundle') checkBundles()
  else if (mode === 'self-test') selfTest()
  else throw new Error('Usage: node scripts/check-quality-ratchets.mjs <source|bundle|self-test>')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
