import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultDesktopRoot = resolve(scriptDirectory, '..')
const lockRelativePath = 'product/vibelink-product.lock.json'
const artifactKinds = ['windows-exe', 'windows-msi', 'checksums']

function fail(message) {
  throw new Error(message)
}

function asRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object.`)
  return value
}

function asNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string.`)
  return value
}

function resolveContained(root, relativePath, label) {
  if (isAbsolute(relativePath)) fail(`${label} must be relative.`)
  const absolute = resolve(root, relativePath)
  const traversal = relative(root, absolute)
  if (traversal.startsWith('..') || isAbsolute(traversal)) fail(`${label} escapes its root.`)
  return absolute
}

async function readJson(path, label = path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    fail(`Unable to read ${label}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`)
  }
}

export function validateLock(lock) {
  const record = asRecord(lock, 'Product lock')
  if (record.schemaVersion !== 1) fail('Product lock schemaVersion must be 1.')
  const web = asRecord(record.canonicalWeb, 'Product lock canonicalWeb')
  const repository = asNonEmptyString(web.repository, 'Product lock canonicalWeb.repository')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('Product lock canonicalWeb.repository is invalid.')
  const commit = asNonEmptyString(web.commit, 'Product lock canonicalWeb.commit')
  if (!/^[0-9a-f]{40}$/.test(commit)) fail('Product lock canonicalWeb.commit must be a lowercase full commit SHA.')
  const manifest = asRecord(web.manifest, 'Product lock canonicalWeb.manifest')
  const manifestPath = asNonEmptyString(manifest.path, 'Product lock canonicalWeb.manifest.path')
  const manifestSha256 = asNonEmptyString(manifest.sha256, 'Product lock canonicalWeb.manifest.sha256')
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) fail('Product lock canonicalWeb.manifest.sha256 must be a lowercase SHA-256.')
  const generated = asRecord(web.generated, 'Product lock canonicalWeb.generated')
  const storeListingPath = asNonEmptyString(generated.storeListingPath, 'Product lock canonicalWeb.generated.storeListingPath')
  const releaseNotesPath = asNonEmptyString(generated.releaseNotesPath, 'Product lock canonicalWeb.generated.releaseNotesPath')
  return { repository, commit, manifestPath, manifestSha256, storeListingPath, releaseNotesPath }
}

export async function loadLock(desktopRoot = defaultDesktopRoot) {
  const lockPath = resolveContained(desktopRoot, lockRelativePath, 'Product lock path')
  return validateLock(await readJson(lockPath, lockRelativePath))
}

export async function sha256File(path) {
  const content = await readFile(path)
  return createHash('sha256').update(content).digest('hex')
}

function validateManifestShape(manifest) {
  const record = asRecord(manifest, 'Product manifest')
  if (record.schemaVersion !== 1) fail('Product manifest schemaVersion must be 1.')
  asNonEmptyString(record.revision, 'Product manifest revision')
  const publicRelease = asRecord(record.publicRelease, 'Product manifest publicRelease')
  const version = asNonEmptyString(publicRelease.version, 'Product manifest publicRelease.version')
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('Product manifest publicRelease.version must be semantic X.Y.Z.')
  const repository = asNonEmptyString(publicRelease.releaseRepository, 'Product manifest publicRelease.releaseRepository')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('Product manifest publicRelease.releaseRepository is invalid.')
  if (publicRelease.directInstallerSigning !== 'unsigned') fail('Product manifest direct installer signing must be unsigned.')
  if (publicRelease.microsoftStoreSigning !== 'store-certified') fail('Product manifest Microsoft Store signing must be store-certified.')
  if (!Array.isArray(publicRelease.artifacts) || publicRelease.artifacts.length !== artifactKinds.length) {
    fail('Product manifest must declare exactly three public release artifacts.')
  }
  const kinds = publicRelease.artifacts.map((artifact, index) => {
    const entry = asRecord(artifact, `Product manifest artifact ${index}`)
    const kind = asNonEmptyString(entry.kind, `Product manifest artifact ${index}.kind`)
    asNonEmptyString(entry.filePattern, `Product manifest artifact ${index}.filePattern`)
    if (typeof entry.sha256Required !== 'boolean') fail(`Product manifest artifact ${index}.sha256Required must be boolean.`)
    return kind
  })
  if (new Set(kinds).size !== artifactKinds.length || artifactKinds.some((kind) => !kinds.includes(kind))) {
    fail('Product manifest artifact kinds must be unique and complete.')
  }
  const capabilities = asRecord(record.capabilities, 'Product manifest capabilities')
  for (const key of ['mcpTools', 'terminalThemes', 'keybindingActions', 'profiles']) {
    if (!Number.isInteger(capabilities[key]) || capabilities[key] <= 0) fail(`Product manifest capabilities.${key} must be a positive integer.`)
  }
  if (record.candidateRelease !== null) {
    const candidate = asRecord(record.candidateRelease, 'Product manifest candidateRelease')
    if (typeof candidate.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(candidate.version)) fail('Product manifest candidateRelease.version must be semantic X.Y.Z.')
    if (typeof candidate.desktopCommit !== 'string' || !/^[0-9a-f]{40}$/.test(candidate.desktopCommit)) fail('Product manifest candidateRelease.desktopCommit must be a lowercase full commit SHA.')
  }
  return record
}

export async function validatePinnedWeb({ desktopRoot = defaultDesktopRoot, webRoot, verifyCommit = true } = {}) {
  if (!webRoot) fail('A canonical Web checkout root is required.')
  const lock = await loadLock(desktopRoot)
  const manifestPath = resolveContained(webRoot, lock.manifestPath, 'Pinned manifest path')
  const actualHash = await sha256File(manifestPath)
  if (actualHash !== lock.manifestSha256) {
    fail(`Pinned Web manifest SHA-256 mismatch: expected ${lock.manifestSha256}, got ${actualHash}.`)
  }
  if (verifyCommit) {
    let actualCommit
    try {
      actualCommit = execFileSync('git', ['-C', webRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch (error) {
      fail(`Unable to read canonical Web checkout commit: ${error.message}`)
    }
    if (actualCommit !== lock.commit) fail(`Pinned Web commit mismatch: expected ${lock.commit}, got ${actualCommit}.`)
  }
  const manifest = validateManifestShape(await readJson(manifestPath, lock.manifestPath))
  return { lock, manifest, manifestPath }
}

function scanBalanced(source, start, open, close) {
  if (source[start] !== open) fail(`Expected ${open} at source offset ${start}.`)
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  fail(`Unterminated ${open}${close} source block.`)
}

function declarationArray(source, declaration, label) {
  const declarationIndex = source.search(declaration)
  if (declarationIndex < 0) fail(`Unable to locate ${label}.`)
  const equals = source.indexOf('=', declarationIndex)
  const start = equals < 0 ? -1 : source.indexOf('[', equals)
  if (start < 0) fail(`Unable to locate ${label} array.`)
  return scanBalanced(source, start, '[', ']')
}

function literalStrings(source) {
  const values = []
  const pattern = /(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1/g
  for (const match of source.matchAll(pattern)) values.push(match[2])
  return values
}

function objectIds(source) {
  const values = []
  const pattern = /\bid\s*:\s*(['"])([A-Za-z0-9_.-]+)\1/g
  for (const match of source.matchAll(pattern)) values.push(match[2])
  return values
}

function rustToolNames(source) {
  const functionIndex = source.search(/\bfn\s+tool_schemas\s*\(\s*\)/)
  if (functionIndex < 0) fail('Unable to locate Rust tool_schemas().')
  const start = source.indexOf('{', functionIndex)
  const body = scanBalanced(source, start, '{', '}')
  const values = []
  const pattern = /\btool_schema\s*\(\s*"([^"]+)"/g
  for (const match of body.matchAll(pattern)) values.push(match[1])
  return values
}

function validateUniqueCount(label, values, expected) {
  if (values.length !== expected) fail(`${label} count drift: manifest=${expected}, source=${values.length}.`)
  const unique = new Set(values)
  if (unique.size !== values.length) {
    const duplicates = [...unique].filter((value) => values.filter((candidate) => candidate === value).length > 1)
    fail(`${label} names must be unique; duplicates: ${duplicates.join(', ')}.`)
  }
}

export async function readSourceRegistries(desktopRoot = defaultDesktopRoot) {
  const themesSource = await readFile(join(desktopRoot, 'src/state/terminalThemes.ts'), 'utf8')
  const keybindingsSource = await readFile(join(desktopRoot, 'src/state/keybindings.ts'), 'utf8')
  const profilesSource = await readFile(join(desktopRoot, 'src/state/profiles.ts'), 'utf8')
  const mcpSource = await readFile(join(desktopRoot, 'src-tauri/src/mcp/mod.rs'), 'utf8')
  return {
    terminalThemes: objectIds(declarationArray(themesSource, /export\s+const\s+terminalThemes\s*=/, 'terminalThemes')),
    keybindingActions: literalStrings(declarationArray(keybindingsSource, /export\s+const\s+keybindingActionIds\s*=/, 'keybindingActionIds')),
    profiles: objectIds(declarationArray(profilesSource, /const\s+defaultProfiles\s*:/, 'defaultProfiles')),
    mcpTools: rustToolNames(mcpSource),
  }
}

export async function validateSourceRegistries(manifest, desktopRoot = defaultDesktopRoot) {
  const registries = await readSourceRegistries(desktopRoot)
  validateUniqueCount('terminalThemes', registries.terminalThemes, manifest.capabilities.terminalThemes)
  validateUniqueCount('keybindingActionIds', registries.keybindingActions, manifest.capabilities.keybindingActions)
  validateUniqueCount('defaultProfiles', registries.profiles, manifest.capabilities.profiles)
  validateUniqueCount('tool_schemas', registries.mcpTools, manifest.capabilities.mcpTools)
  return registries
}

function artifactFileName(manifest, kind, version = manifest.publicRelease.version) {
  const artifact = manifest.publicRelease.artifacts.find((entry) => entry.kind === kind)
  if (!artifact) fail(`Product manifest is missing artifact ${kind}.`)
  return artifact.filePattern.replace('{version}', version)
}

function cargoPackageVersion(text) {
  const packageSection = text.match(/^\[package\]\s*([\s\S]*?)(?=^\[|\z)/m)
  const version = packageSection?.[1].match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  if (!version) fail('Unable to read src-tauri/Cargo.toml package version.')
  return version
}

function cargoLockPackageVersion(text) {
  const packageBlocks = text.split(/(?=^\[\[package\]\])/m)
  for (const block of packageBlocks) {
    if (/^name\s*=\s*"app"\s*$/m.test(block)) {
      const version = block.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
      if (version) return version
    }
  }
  fail('Unable to read src-tauri/Cargo.lock app package version.')
}

export async function desktopVersions(desktopRoot = defaultDesktopRoot) {
  const packageJson = await readJson(join(desktopRoot, 'package.json'), 'package.json')
  const tauriJson = await readJson(join(desktopRoot, 'src-tauri/tauri.conf.json'), 'src-tauri/tauri.conf.json')
  const cargoToml = await readFile(join(desktopRoot, 'src-tauri/Cargo.toml'), 'utf8')
  const cargoLock = await readFile(join(desktopRoot, 'src-tauri/Cargo.lock'), 'utf8')
  return {
    package: packageJson.version,
    tauri: tauriJson.version,
    cargo: cargoPackageVersion(cargoToml),
    cargoLock: cargoLockPackageVersion(cargoLock),
  }
}

export async function validateCandidateRelease({ manifest, desktopRoot = defaultDesktopRoot, tag } = {}) {
  if (manifest.candidateRelease === null) {
    fail('VibeLink candidate release is not set; release/tag automation is blocked.')
  }
  const candidate = manifest.candidateRelease
  if (tag !== `v${candidate.version}`) fail(`Release tag must equal candidate version v${candidate.version}; got ${tag}.`)
  const versions = await desktopVersions(desktopRoot)
  const mismatches = Object.entries(versions).filter(([, version]) => version !== candidate.version)
  if (mismatches.length > 0) {
    fail(`Candidate version mismatch: candidate=${candidate.version}; ${Object.entries(versions).map(([name, version]) => `${name}=${version}`).join(', ')}.`)
  }
  return { candidate, versions }
}

function hasObjectKey(value, forbiddenKey) {
  if (Array.isArray(value)) return value.some((entry) => hasObjectKey(entry, forbiddenKey))
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, entry]) => key === forbiddenKey || hasObjectKey(entry, forbiddenKey))
}

export async function validateGeneratedMetadata({ webRoot, lock, manifest } = {}) {
  const storeListingPath = resolveContained(webRoot, lock.storeListingPath, 'Generated Store listing path')
  const releaseNotesPath = resolveContained(webRoot, lock.releaseNotesPath, 'Generated release notes path')
  const storeListing = asRecord(await readJson(storeListingPath, lock.storeListingPath), 'Generated Store listing')
  const generatedFrom = asRecord(storeListing.generatedFrom, 'Generated Store listing generatedFrom')
  if (generatedFrom.manifestPath !== lock.manifestPath || generatedFrom.manifestRevision !== manifest.revision || generatedFrom.publicReleaseVersion !== manifest.publicRelease.version) {
    fail('Generated Store listing does not match the pinned public manifest revision/version/path.')
  }
  const distribution = asRecord(storeListing.distribution, 'Generated Store listing distribution')
  const direct = asRecord(distribution.direct, 'Generated Store listing direct distribution')
  const microsoftStore = asRecord(distribution.microsoftStore, 'Generated Store listing Microsoft Store distribution')
  if (direct.signing !== manifest.publicRelease.directInstallerSigning) fail('Generated direct signing label drifted from the manifest.')
  if (microsoftStore.signing !== manifest.publicRelease.microsoftStoreSigning) fail('Generated Microsoft Store signing label drifted from the manifest.')
  if (direct.label === microsoftStore.label || direct.signing === microsoftStore.signing) fail('Direct and Microsoft Store signing labels must remain distinct.')
  if (direct.repository !== manifest.publicRelease.releaseRepository) fail('Generated direct release repository drifted from the manifest.')
  if (!Array.isArray(direct.artifacts) || direct.artifacts.length !== artifactKinds.length) fail('Generated direct artifact list must contain exactly three entries.')
  for (const kind of artifactKinds) {
    const expected = artifactFileName(manifest, kind)
    const matches = direct.artifacts.filter((entry) => entry?.kind === kind && entry?.fileName === expected)
    if (matches.length !== 1) fail(`Generated Store metadata must contain ${expected} exactly once.`)
  }
  const checksumName = artifactFileName(manifest, 'checksums')
  if (direct.verificationAsset !== checksumName) fail(`Generated Store metadata verification asset must be ${checksumName}.`)
  const releaseNotes = await readFile(releaseNotesPath, 'utf8')
  const requiredNotes = [
    `# VibeLink ${manifest.publicRelease.version}`,
    `revision \`${manifest.revision}\``,
    `## Direct downloads — ${manifest.publicRelease.directInstallerSigning}`,
    '## Microsoft Store — Store-certified',
    ...artifactKinds.map((kind) => `\`${artifactFileName(manifest, kind)}\``),
  ]
  for (const text of requiredNotes) {
    if (!releaseNotes.includes(text)) fail(`Generated release notes are missing manifest-derived text: ${text}`)
  }
  if (hasObjectKey(storeListing, 'candidateRelease')) fail('Generated Store metadata must not contain candidateRelease data.')
  if (manifest.candidateRelease !== null) {
    const publicMetadata = `${JSON.stringify(storeListing)}\n${releaseNotes}`
    if (publicMetadata.includes(manifest.candidateRelease.desktopCommit)) fail('Generated public/Store metadata leaked the candidate desktop commit.')
  }
  return { storeListing, releaseNotes, storeListingPath, releaseNotesPath }
}

export function validateStoreSettings(storeListing, environment = process.env) {
  const listing = asRecord(storeListing, 'Generated Store listing')
  const distribution = asRecord(listing.distribution, 'Generated Store listing distribution')
  const direct = asRecord(distribution.direct, 'Generated Store listing direct distribution')
  const microsoftStore = asRecord(distribution.microsoftStore, 'Generated Store listing Microsoft Store distribution')
  if (direct.signing !== 'unsigned' || microsoftStore.signing !== 'store-certified') {
    fail('Direct installers must remain unsigned while Microsoft Store signing remains store-certified.')
  }
  if (direct.label === microsoftStore.label) fail('Direct and Microsoft Store distribution labels must remain distinct.')
  const compare = asRecord(listing.partnerCenterCompareInputs, 'Generated Store listing Partner Center compare inputs')
  const expectedEnvironment = {
    STORE_IDENTITY_NAME: compare.identityName,
    STORE_PUBLISHER: compare.publisher,
    STORE_PUBLISHER_DISPLAY_NAME: compare.publisherDisplayName,
  }
  for (const [name, expected] of Object.entries(expectedEnvironment)) {
    if (!environment[name]) fail(`Release variable ${name} is required.`)
    if (environment[name] !== expected) fail(`Release variable ${name} does not match pinned Web Store metadata.`)
  }
  return { directLabel: direct.label, storeLabel: microsoftStore.label }
}

export function renderDirectReleaseNotes(manifest, version) {
  const directSigning = manifest.publicRelease.directInstallerSigning
  const storeSigning = manifest.publicRelease.microsoftStoreSigning
  const directLabel = directSigning === 'unsigned' ? 'Unsigned direct installers' : directSigning
  const storeLabel = storeSigning === 'store-certified' ? 'Microsoft Store-certified package' : storeSigning
  const artifacts = artifactKinds.map((kind) => artifactFileName(manifest, kind, version))
  return `# VibeLink ${version}\n\n## ${directLabel}\n\nThe direct EXE and MSI installers are ${directSigning}. Verify both installers against \`${artifacts[2]}\` before running them.\n\n${artifacts.map((name) => `- \`${name}\``).join('\n')}\n\n## ${storeLabel}\n\nMicrosoft Store certification and consumer signing apply only to the Store package; the separate direct EXE/MSI installers remain ${directSigning}.\n`
}

export function validatePublicReleasePayload(payload, manifest, checksumText, version = manifest.publicRelease.version) {
  const release = asRecord(payload, 'GitHub public release response')
  if (release.tag_name !== `v${version}`) fail(`Expected exact public release tag v${version}.`)
  if (!Array.isArray(release.assets)) fail('GitHub public release assets must be an array.')
  const expectedNames = artifactKinds.map((kind) => artifactFileName(manifest, kind, version))
  if (release.assets.length !== expectedNames.length) fail(`Public release must contain exactly ${expectedNames.length} assets.`)
  const assetByName = new Map()
  for (const assetValue of release.assets) {
    const asset = asRecord(assetValue, 'GitHub public release asset')
    const name = asNonEmptyString(asset.name, 'GitHub public release asset name')
    const url = asNonEmptyString(asset.browser_download_url, `GitHub public release asset ${name} URL`)
    if (!url.startsWith('https://')) fail(`GitHub public release asset ${name} URL must use HTTPS.`)
    if (assetByName.has(name)) fail(`GitHub public release asset ${name} is duplicated.`)
    assetByName.set(name, url)
  }
  for (const name of expectedNames) if (!assetByName.has(name)) fail(`GitHub public release is missing ${name}.`)
  for (const name of assetByName.keys()) if (!expectedNames.includes(name)) fail(`GitHub public release contains unexpected asset ${name}.`)

  const checksumEntries = new Map()
  const lines = checksumText.split(/\r?\n/).filter((line) => line.length > 0)
  const requiredChecksumNames = manifest.publicRelease.artifacts
    .filter((artifact) => artifact.sha256Required)
    .map((artifact) => artifact.filePattern.replace('{version}', version))
  if (lines.length !== requiredChecksumNames.length) fail(`Checksum asset must contain exactly ${requiredChecksumNames.length} entries.`)
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/)
    if (!match) fail(`Invalid SHA256SUMS.txt line: ${line}`)
    if (checksumEntries.has(match[2])) fail(`Checksum asset duplicates ${match[2]}.`)
    checksumEntries.set(match[2], match[1])
  }
  for (const name of requiredChecksumNames) if (!checksumEntries.has(name)) fail(`Checksum asset is missing ${name}.`)
  for (const name of checksumEntries.keys()) if (!requiredChecksumNames.includes(name)) fail(`Checksum asset contains unexpected file ${name}.`)
  return {
    repository: manifest.publicRelease.releaseRepository,
    tag: `v${version}`,
    assets: expectedNames,
    checksumAssetUrl: assetByName.get(artifactFileName(manifest, 'checksums', version)),
  }
}

async function fetchPublicRelease({ manifest, version, token, retries = 1, delayMs = 0 }) {
  const repository = manifest.publicRelease.releaseRepository
  const apiUrl = `https://api.github.com/repos/${repository}/releases/tags/v${version}`
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'vibelink-desktop-release-validator',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  let lastError
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(apiUrl, { headers, cache: 'no-store' })
      if (!response.ok) fail(`GitHub release API returned ${response.status}.`)
      const payload = await response.json()
      const checksumName = artifactFileName(manifest, 'checksums', version)
      const checksumAsset = payload.assets?.find((asset) => asset?.name === checksumName)
      if (!checksumAsset?.browser_download_url) fail(`GitHub release API did not expose ${checksumName}.`)
      const checksumResponse = await fetch(checksumAsset.browser_download_url, { headers, cache: 'no-store', redirect: 'follow' })
      if (!checksumResponse.ok) fail(`Checksum asset download returned ${checksumResponse.status}.`)
      return validatePublicReleasePayload(payload, manifest, await checksumResponse.text(), version)
    } catch (error) {
      lastError = error
      if (attempt < retries && delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
    }
  }
  throw lastError
}

function parseArguments(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      options._.push(value)
      continue
    }
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) options[key] = true
    else {
      options[key] = next
      index += 1
    }
  }
  return options
}

async function writeGithubOutputs(path, outputs) {
  if (!path) return
  const lines = Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join('')
  await appendFile(path, lines, 'utf8')
}

function releaseOutputs(lock, manifest, version) {
  return {
    repository: manifest.publicRelease.releaseRepository,
    web_commit: lock.commit,
    manifest_path: lock.manifestPath,
    manifest_sha256: lock.manifestSha256,
    version,
    exe_name: artifactFileName(manifest, 'windows-exe', version),
    msi_name: artifactFileName(manifest, 'windows-msi', version),
    checksum_name: artifactFileName(manifest, 'checksums', version),
  }
}

async function stageMetadata({ webRoot, desktopRoot, output, version }) {
  const { lock, manifest } = await validatePinnedWeb({ desktopRoot, webRoot })
  await validateGeneratedMetadata({ webRoot, lock, manifest })
  const outputRoot = resolve(output)
  await mkdir(outputRoot, { recursive: true })
  await copyFile(resolveContained(webRoot, lock.manifestPath, 'Pinned manifest path'), join(outputRoot, 'vibelink-product.v1.json'))
  await copyFile(resolveContained(webRoot, lock.storeListingPath, 'Generated Store listing path'), join(outputRoot, 'store-listing.json'))
  await copyFile(resolveContained(webRoot, lock.releaseNotesPath, 'Generated release notes path'), join(outputRoot, 'release-notes.md'))
  await writeFile(join(outputRoot, 'direct-release-notes.md'), renderDirectReleaseNotes(manifest, version), 'utf8')
}

async function main(argv) {
  const [command, ...rest] = argv
  const options = parseArguments(rest)
  const desktopRoot = resolve(options['desktop-root'] || defaultDesktopRoot)
  if (command === 'lock-info') {
    const lock = await loadLock(desktopRoot)
    await writeGithubOutputs(options['github-output'], {
      repository: lock.repository,
      web_commit: lock.commit,
      manifest_path: lock.manifestPath,
      manifest_sha256: lock.manifestSha256,
      store_listing_path: lock.storeListingPath,
      release_notes_path: lock.releaseNotesPath,
    })
    console.log(`Pinned ${lock.repository}@${lock.commit} (${lock.manifestSha256})`)
    return
  }
  if (command === 'validate-local' || command === 'validate-candidate') {
    const webRoot = resolve(asNonEmptyString(options['web-root'], '--web-root'))
    const { lock, manifest } = await validatePinnedWeb({ desktopRoot, webRoot })
    const registries = await validateSourceRegistries(manifest, desktopRoot)
    await validateGeneratedMetadata({ webRoot, lock, manifest })
    let version = manifest.publicRelease.version
    if (command === 'validate-candidate') {
      const candidate = await validateCandidateRelease({ manifest, desktopRoot, tag: options.tag })
      version = candidate.candidate.version
    }
    await writeGithubOutputs(options['github-output'], releaseOutputs(lock, manifest, version))
    console.log(`Validated pinned Web contract and source registries: themes=${registries.terminalThemes.length}, actions=${registries.keybindingActions.length}, profiles=${registries.profiles.length}, MCP tools=${registries.mcpTools.length}`)
    return
  }
  if (command === 'stage-metadata') {
    const webRoot = resolve(asNonEmptyString(options['web-root'], '--web-root'))
    const output = asNonEmptyString(options.output, '--output')
    const version = asNonEmptyString(options.version, '--version')
    await stageMetadata({ webRoot, desktopRoot, output, version })
    console.log(`Staged pinned Web release metadata in ${resolve(output)}`)
    return
  }
  if (command === 'validate-store-settings') {
    const metadataRoot = resolve(asNonEmptyString(options['metadata-root'], '--metadata-root'))
    const listing = await readJson(join(metadataRoot, 'store-listing.json'), 'store-listing.json')
    const labels = validateStoreSettings(listing)
    console.log(`Validated distinct distribution labels: ${labels.directLabel}; ${labels.storeLabel}`)
    return
  }
  if (command === 'validate-public-release') {
    const manifestPath = resolve(asNonEmptyString(options.manifest, '--manifest'))
    const manifest = validateManifestShape(await readJson(manifestPath, options.manifest))
    const version = options.version || manifest.publicRelease.version
    let result
    if (options.payload) {
      const payload = await readJson(resolve(options.payload), options.payload)
      const checksumText = await readFile(resolve(asNonEmptyString(options.checksums, '--checksums')), 'utf8')
      result = validatePublicReleasePayload(payload, manifest, checksumText, version)
    } else {
      const token = options['token-env'] ? process.env[options['token-env']] : process.env.RELEASES_TOKEN || process.env.GH_TOKEN
      result = await fetchPublicRelease({
        manifest,
        version,
        token,
        retries: Number(options.retries || 1),
        delayMs: Number(options['delay-ms'] || 0),
      })
    }
    console.log(`Validated public ${result.repository} ${result.tag}: ${result.assets.join(', ')}`)
    return
  }
  fail('Usage: release-contract.mjs <lock-info|validate-local|validate-candidate|stage-metadata|validate-store-settings|validate-public-release> [options]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
