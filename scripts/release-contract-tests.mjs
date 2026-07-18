import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  renderDirectReleaseNotes,
  validateCandidateRelease,
  validateGeneratedMetadata,
  validatePinnedWeb,
  validatePublicReleasePayload,
  validateSourceRegistries,
  validateStoreSettings,
} from './release-contract.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function manifest(candidateRelease = null) {
  return {
    schemaVersion: 1,
    revision: '2026-07-19.phase5',
    publicRelease: {
      version: '0.3.0',
      releaseRepository: 'JSCOP/vibelink-releases',
      routes: { download: '/download', releases: '/releases' },
      directInstallerSigning: 'unsigned',
      microsoftStoreSigning: 'store-certified',
      artifacts: [
        { kind: 'windows-exe', filePattern: 'VibeLink_{version}_x64-setup.exe', sha256Required: true },
        { kind: 'windows-msi', filePattern: 'VibeLink_{version}_x64_en-US.msi', sha256Required: true },
        { kind: 'checksums', filePattern: 'SHA256SUMS.txt', sha256Required: false },
      ],
    },
    candidateRelease,
    capabilities: { mcpTools: 17, terminalThemes: 26, keybindingActions: 23, profiles: 6, maxPanes: 12 },
    commerce: {
      trialDays: 7,
      krwOneTime: 20000,
      usdOneTime: 20,
      publicMode: 'disabled',
      entitlementContractVersion: 'desktop-account-v1',
      purchasePrimaryFlow: 'moobang-account',
      accountUnlockMaxSeconds: 70,
      legacyLicenseKey: { maxDesktopVersion: '0.2.0', purpose: 'activation-recovery' },
    },
    platforms: ['windows'],
  }
}

function generatedStoreListing(productManifest = manifest()) {
  return {
    schemaVersion: 1,
    generatedFrom: {
      manifestPath: 'product/vibelink-product.v1.json',
      manifestRevision: productManifest.revision,
      publicReleaseVersion: productManifest.publicRelease.version,
    },
    distribution: {
      direct: {
        label: 'Unsigned direct installers',
        signing: 'unsigned',
        repository: 'JSCOP/vibelink-releases',
        artifacts: [
          { kind: 'windows-exe', fileName: 'VibeLink_0.3.0_x64-setup.exe', sha256Required: true },
          { kind: 'windows-msi', fileName: 'VibeLink_0.3.0_x64_en-US.msi', sha256Required: true },
          { kind: 'checksums', fileName: 'SHA256SUMS.txt', sha256Required: false },
        ],
        verificationAsset: 'SHA256SUMS.txt',
      },
      microsoftStore: { label: 'Microsoft Store-certified package', signing: 'store-certified' },
    },
    partnerCenterCompareInputs: {
      identityName: 'moobang.VibeLink',
      publisher: 'CN=C2955282-7869-4864-8D4A-5BC03CF9ECF5',
      publisherDisplayName: 'moobang',
    },
  }
}

function generatedReleaseNotes(productManifest = manifest()) {
  return `# VibeLink ${productManifest.publicRelease.version}\n\nGenerated from \`product/vibelink-product.v1.json\` revision \`${productManifest.revision}\`.\n\n## Direct downloads — unsigned\n\n- \`VibeLink_0.3.0_x64-setup.exe\`\n- \`VibeLink_0.3.0_x64_en-US.msi\`\n- \`SHA256SUMS.txt\`\n\n## Microsoft Store — Store-certified\n`
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vibelink-release-contract-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function copyRegistrySources(targetRoot) {
  for (const relativePath of [
    'src/state/terminalThemes.ts',
    'src/state/keybindings.ts',
    'src/state/profiles.ts',
    'src-tauri/src/mcp/mod.rs',
  ]) {
    const target = join(targetRoot, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(desktopRoot, relativePath), target)
  }
}

async function writeWebMetadata(webRoot, productManifest = manifest()) {
  await mkdir(join(webRoot, 'product/generated'), { recursive: true })
  await writeFile(join(webRoot, 'product/vibelink-product.v1.json'), `${JSON.stringify(productManifest, null, 2)}\n`, 'utf8')
  await writeFile(join(webRoot, 'product/generated/store-listing.json'), `${JSON.stringify(generatedStoreListing(productManifest), null, 2)}\n`, 'utf8')
  await writeFile(join(webRoot, 'product/generated/release-notes.md'), generatedReleaseNotes(productManifest), 'utf8')
}

const lockFor = (sha256) => ({
  schemaVersion: 1,
  canonicalWeb: {
    repository: 'JSCOP/vibelink-web',
    commit: 'b370fa3789baa24ca79b686ecf09eb504df77396',
    manifest: { path: 'product/vibelink-product.v1.json', sha256 },
    generated: {
      storeListingPath: 'product/generated/store-listing.json',
      releaseNotesPath: 'product/generated/release-notes.md',
    },
  },
})

test('current desktop source registries match manifest counts and unique-name gates', async () => {
  const registries = await validateSourceRegistries(manifest(), desktopRoot)
  assert.equal(registries.terminalThemes.length, 26)
  assert.equal(registries.keybindingActions.length, 23)
  assert.equal(registries.profiles.length, 6)
  assert.equal(registries.mcpTools.length, 17)
})

test('source registry drift fails closed', async (t) => {
  const root = await temporaryDirectory(t)
  await copyRegistrySources(root)
  const keybindingsPath = join(root, 'src/state/keybindings.ts')
  const source = await readFile(keybindingsPath, 'utf8')
  await writeFile(keybindingsPath, source.replace(/\s*'toggleTerminalTabs',\r?\n/, '\n'), 'utf8')
  await assert.rejects(() => validateSourceRegistries(manifest(), root), /keybindingActionIds count drift: manifest=23, source=22/)
})

test('source registry duplicate names fail without changing the count', async (t) => {
  const root = await temporaryDirectory(t)
  await copyRegistrySources(root)
  const keybindingsPath = join(root, 'src/state/keybindings.ts')
  const source = await readFile(keybindingsPath, 'utf8')
  await writeFile(keybindingsPath, source.replace("  'captureVideo',", "  'captureImage',"), 'utf8')
  await assert.rejects(() => validateSourceRegistries(manifest(), root), /keybindingActionIds names must be unique; duplicates: captureImage/)
})

test('pinned lock rejects a manifest hash mismatch', async (t) => {
  const root = await temporaryDirectory(t)
  const fixtureDesktop = join(root, 'desktop')
  const fixtureWeb = join(root, 'web')
  await writeWebMetadata(fixtureWeb)
  const original = await readFile(join(fixtureWeb, 'product/vibelink-product.v1.json'))
  const pinnedHash = createHash('sha256').update(original).digest('hex')
  await mkdir(join(fixtureDesktop, 'product'), { recursive: true })
  await writeFile(join(fixtureDesktop, 'product/vibelink-product.lock.json'), `${JSON.stringify(lockFor(pinnedHash), null, 2)}\n`, 'utf8')
  await writeFile(join(fixtureWeb, 'product/vibelink-product.v1.json'), `${JSON.stringify({ ...manifest(), revision: '2026-07-19.phase6' }, null, 2)}\n`, 'utf8')
  await assert.rejects(
    () => validatePinnedWeb({ desktopRoot: fixtureDesktop, webRoot: fixtureWeb, verifyCommit: false }),
    /Pinned Web manifest SHA-256 mismatch/,
  )
})

test('pinned lock rejects a Web commit mismatch', async (t) => {
  const root = await temporaryDirectory(t)
  const fixtureDesktop = join(root, 'desktop')
  const fixtureWeb = join(root, 'web')
  await writeWebMetadata(fixtureWeb)
  execFileSync('git', ['init'], { cwd: fixtureWeb, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'release-contract@example.invalid'], { cwd: fixtureWeb })
  execFileSync('git', ['config', 'user.name', 'Release Contract Test'], { cwd: fixtureWeb })
  execFileSync('git', ['add', '.'], { cwd: fixtureWeb })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: fixtureWeb, stdio: 'ignore' })
  const manifestBytes = await readFile(join(fixtureWeb, 'product/vibelink-product.v1.json'))
  await mkdir(join(fixtureDesktop, 'product'), { recursive: true })
  const lock = lockFor(createHash('sha256').update(manifestBytes).digest('hex'))
  lock.canonicalWeb.commit = '0'.repeat(40)
  await writeFile(join(fixtureDesktop, 'product/vibelink-product.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
  await assert.rejects(
    () => validatePinnedWeb({ desktopRoot: fixtureDesktop, webRoot: fixtureWeb }),
    /Pinned Web commit mismatch/,
  )
})

test('candidate null blocks tag automation predictably', async () => {
  await assert.rejects(
    () => validateCandidateRelease({ manifest: manifest(), desktopRoot, tag: 'v0.3.0' }),
    /candidate release is not set; release\/tag automation is blocked/,
  )
})

test('candidate gate accepts only a matching tag and synchronized desktop versions', async () => {
  const candidate = { version: '0.3.0', desktopCommit: 'a'.repeat(40) }
  const result = await validateCandidateRelease({ manifest: manifest(candidate), desktopRoot, tag: 'v0.3.0' })
  assert.deepEqual(result.versions, { package: '0.3.0', tauri: '0.3.0', cargo: '0.3.0', cargoLock: '0.3.0' })
  await assert.rejects(
    () => validateCandidateRelease({ manifest: manifest(candidate), desktopRoot, tag: 'v0.3.1' }),
    /Release tag must equal candidate version v0.3.0/,
  )
})

test('generated Store metadata preserves distinct direct and Store signing labels', async (t) => {
  const root = await temporaryDirectory(t)
  const productManifest = manifest()
  await writeWebMetadata(root, productManifest)
  const lock = {
    manifestPath: 'product/vibelink-product.v1.json',
    storeListingPath: 'product/generated/store-listing.json',
    releaseNotesPath: 'product/generated/release-notes.md',
  }
  const valid = await validateGeneratedMetadata({ webRoot: root, lock, manifest: productManifest })
  assert.equal(valid.storeListing.distribution.direct.signing, 'unsigned')
  assert.equal(valid.storeListing.distribution.microsoftStore.signing, 'store-certified')

  const drifted = generatedStoreListing(productManifest)
  drifted.distribution.microsoftStore.label = drifted.distribution.direct.label
  await writeFile(join(root, 'product/generated/store-listing.json'), `${JSON.stringify(drifted, null, 2)}\n`, 'utf8')
  await assert.rejects(
    () => validateGeneratedMetadata({ webRoot: root, lock, manifest: productManifest }),
    /signing labels must remain distinct/,
  )
})

test('generated Store metadata excludes candidate-only data', async (t) => {
  const root = await temporaryDirectory(t)
  const productManifest = manifest({ version: '0.3.0', desktopCommit: 'a'.repeat(40) })
  await writeWebMetadata(root, productManifest)
  const leaked = generatedStoreListing(productManifest)
  leaked.candidateRelease = productManifest.candidateRelease
  await writeFile(join(root, 'product/generated/store-listing.json'), `${JSON.stringify(leaked, null, 2)}\n`, 'utf8')
  await assert.rejects(
    () => validateGeneratedMetadata({
      webRoot: root,
      lock: {
        manifestPath: 'product/vibelink-product.v1.json',
        storeListingPath: 'product/generated/store-listing.json',
        releaseNotesPath: 'product/generated/release-notes.md',
      },
      manifest: productManifest,
    }),
    /must not contain candidateRelease data/,
  )
})

test('Store settings are checked against pinned generated metadata', () => {
  const listing = generatedStoreListing()
  const labels = validateStoreSettings(listing, {
    STORE_IDENTITY_NAME: 'moobang.VibeLink',
    STORE_PUBLISHER: 'CN=C2955282-7869-4864-8D4A-5BC03CF9ECF5',
    STORE_PUBLISHER_DISPLAY_NAME: 'moobang',
  })
  assert.notEqual(labels.directLabel, labels.storeLabel)
  assert.throws(
    () => validateStoreSettings(listing, {
      STORE_IDENTITY_NAME: 'wrong',
      STORE_PUBLISHER: 'CN=C2955282-7869-4864-8D4A-5BC03CF9ECF5',
      STORE_PUBLISHER_DISPLAY_NAME: 'moobang',
    }),
    /does not match pinned Web Store metadata/,
  )
})

test('manifest-derived direct notes keep direct and Store signing claims separate', () => {
  const notes = renderDirectReleaseNotes(manifest(), '0.3.0')
  assert.match(notes, /## Unsigned direct installers/)
  assert.match(notes, /## Microsoft Store-certified package/)
  assert.match(notes, /direct EXE\/MSI installers remain unsigned/)
})

test('mocked public release validation requires exact assets and checksum entries', () => {
  const payload = {
    tag_name: 'v0.3.0',
    assets: [
      { name: 'VibeLink_0.3.0_x64-setup.exe', browser_download_url: 'https://example.test/VibeLink_0.3.0_x64-setup.exe' },
      { name: 'VibeLink_0.3.0_x64_en-US.msi', browser_download_url: 'https://example.test/VibeLink_0.3.0_x64_en-US.msi' },
      { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.test/SHA256SUMS.txt' },
    ],
  }
  const checksums = `${'a'.repeat(64)}  VibeLink_0.3.0_x64-setup.exe\n${'b'.repeat(64)}  VibeLink_0.3.0_x64_en-US.msi\n`
  const release = validatePublicReleasePayload(payload, manifest(), checksums)
  assert.deepEqual(release.assets, [
    'VibeLink_0.3.0_x64-setup.exe',
    'VibeLink_0.3.0_x64_en-US.msi',
    'SHA256SUMS.txt',
  ])
  assert.throws(
    () => validatePublicReleasePayload({ ...payload, assets: [...payload.assets, { name: 'extra.zip', browser_download_url: 'https://example.test/extra.zip' }] }, manifest(), checksums),
    /exactly 3 assets/,
  )
})
