import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const verifier = join(repoRoot, 'scripts', 'verify-embedded-assets.mjs')

function fixture(secondAsset) {
  const root = mkdtempSync(join(tmpdir(), 'vibelink-embedded-assets-'))
  const dist = join(root, 'dist')
  const payloadDir = join(root, 'out', 'tauri-codegen-assets')
  mkdirSync(dist, { recursive: true })
  mkdirSync(payloadDir, { recursive: true })

  const first = Buffer.from('export const diagram = true\n')
  const compressed = brotliCompressSync(first)
  const firstPath = join(dist, 'classDiagram-a.js')
  const secondPath = join(dist, 'classDiagram-b.js')
  const compressedPath = join(payloadDir, 'payload.js')
  const depInfo = join(root, 'app_lib.d')
  const executable = join(root, 'app.exe')

  writeFileSync(firstPath, first)
  writeFileSync(secondPath, secondAsset)
  writeFileSync(compressedPath, compressed)
  writeFileSync(depInfo, `${firstPath}:\n${compressedPath}:\n${secondPath}:\n`)
  writeFileSync(executable, Buffer.concat([Buffer.from('stub executable\n'), compressed]))

  return { root, dist, depInfo, executable }
}

function verify({ dist, depInfo, executable }) {
  return spawnSync(process.execPath, [verifier, executable, depInfo, dist], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

test('accepts two tracked asset paths sharing one generated payload', () => {
  const files = fixture(Buffer.from('export const diagram = true\n'))
  try {
    const result = verify(files)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Verified 2 current frontend assets/)
  } finally {
    rmSync(files.root, { recursive: true, force: true })
  }
})

test('rejects an unpaired asset with different content', () => {
  const files = fixture(Buffer.from('export const diagram = false\n'))
  try {
    const result = verify(files)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /classDiagram-b\.js has no generated embedded payload/)
  } finally {
    rmSync(files.root, { recursive: true, force: true })
  }
})
