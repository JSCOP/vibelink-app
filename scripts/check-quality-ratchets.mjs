import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const sourceBudgets = {
  // Tracked hotspots: current non-growth baselines; lower them when files shrink.
  'src/layout/WorkspaceView.tsx': 2_530,
  'src/terminal/TerminalManager.ts': 2_363,
  'src/state/store.ts': 2_197,
  'src/components/git/GitWorkspaceProvider.tsx': 1_516,
  'src-tauri/src/remote/bridge.rs': 5_568,
  'src-tauri/src/orchestration/mod.rs': 4_683,
  'src-tauri/src/app/git/worktree_registry.rs': 3_149,
  // Keeps pending download records joinable after the manager tests moved out.
  'src-tauri/src/browser/manager.rs': 3_147,
  'src-tauri/src/daemon/session.rs': 3_072,
  'src-tauri/src/browser/provider.rs': 2_834,
  'src-tauri/src/app/hermes.rs': 2_706,
  'src-tauri/src/control_plane.rs': 2_471,
  // Over-cap baseline: split or justify before raising.
  'src/components/SettingsDialog.tsx': 1_483,
  'src/styles/appChrome.css': 1_834,
  'src/styles/gitWindow.css': 1_465,
  'src/styles/workspaceRail.css': 1_918,
  'src/state/store.test.ts': 1_427,
  'src-tauri/src/app/agent_hooks.rs': 2_652,
  'src-tauri/src/app/android_device_lab.rs': 1_680,
  'src-tauri/src/app/browser.rs': 1_427,
  'src-tauri/src/app/capture.rs': 1_435,
  'src-tauri/src/app/daemon_client.rs': 1_210,
  'src-tauri/src/app/fsops.rs': 1_704,
  'src-tauri/src/daemon/dispatch.rs': 4_766,
  'src-tauri/src/daemon/tests.rs': 1_580,
  'src-tauri/src/app/git/worktree_lifecycle.rs': 2_396,
  'src-tauri/src/app/license.rs': 1_882,
  'src-tauri/src/app/provider_integrations.rs': 2_056,
  'src-tauri/src/app/spawn_daemon.rs': 1_982,
  'src-tauri/src/daemon/automation/runner.rs': 1_390,
  // Grew once to carry both browser backends after browser_page/browser_extension/chrome_profile were split out,
  // then again for the extension diagnostics — unloaded vs. refused-by-id — that keep agents out of a guessing loop.
  'src-tauri/src/dedicated_cli/browser_cdp.rs': 1_973,
  'src-tauri/src/dedicated_cli/contract.rs': 2_022,
  'src-tauri/src/mcp/mod.rs': 2_046,
  'src-tauri/src/protocol.rs': 1_227,
  'src-tauri/src/remote/server.rs': 1_273,
}

const sourceHardCap = 1_200
const sourceScanRoots = [
  ['src', /\.(?:ts|tsx|css)$/],
  ['src-tauri/src', /\.rs$/],
]
const sourceExclusions = [
  'src-tauri/gen',
  'node_modules',
  'dist',
  'target',
  'uniffi',
]

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

function normalizeSourcePath(file) {
  return file.replaceAll('\\', '/')
}

function isExcludedSourcePath(file) {
  const normalized = normalizeSourcePath(file)
  const segments = normalized.split('/')
  return sourceExclusions.some((excluded) =>
    excluded.includes('/')
      ? normalized === excluded || normalized.startsWith(`${excluded}/`)
      : segments.includes(excluded),
  )
}

function isOverSourceHardCap(lines) {
  return lines > sourceHardCap
}

function walkSourceFiles(directory, filePattern, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name)
    const file = normalizeSourcePath(relative(root, absolutePath))
    if (isExcludedSourcePath(file)) continue
    if (entry.isDirectory()) walkSourceFiles(absolutePath, filePattern, files)
    else if (entry.isFile() && filePattern.test(entry.name)) files.push(file)
  }
  return files
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
  for (const [directory, filePattern] of sourceScanRoots) {
    for (const file of walkSourceFiles(join(root, directory), filePattern).sort()) {
      if (Object.hasOwn(sourceBudgets, file)) continue
      const lines = lineCount(readFileSync(join(root, file), 'utf8'))
      if (isOverSourceHardCap(lines)) {
        failures.push(
          `${file}: ${lines.toLocaleString()} lines exceeds the ${sourceHardCap.toLocaleString()}-line hard cap; split the file or add an explicit sourceBudgets baseline with a reason`,
        )
      }
    }
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
  assert.equal(isExcludedSourcePath('src-tauri/gen/schema.rs'), true)
  assert.equal(isExcludedSourcePath('src/components/App.tsx'), false)
  assert.equal(isOverSourceHardCap(1_201), true)
  assert.equal(isOverSourceHardCap(1_200), false)
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
