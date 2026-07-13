import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

// Guards the pnpm patch on @xterm/addon-webgl@0.19.0 (patches/@xterm__addon-webgl@0.19.0.patch).
//
// Upstream 0.19.0 shares one glyph texture atlas among every terminal with a
// matching font config (CharAtlasCache.acquireTextureAtlas). Any pane calling
// clearTextureAtlas() — VibeLink's split/maximize recovery path does — wipes the
// SHARED pages while sibling renderers keep vertex models pointing at the old
// glyph coordinates, corrupting every pane at once (scattered fragments /
// mostly-black panes; xterm buffers stay intact, no webglcontextlost). Upstream
// acknowledges the shared-atlas coherence bugs (#5847, fixed by PR #5883 only in
// 0.20.0-beta). The patch:
//  1. disables cross-terminal atlas sharing (each pane owns a private atlas),
//  2. makes TextureAtlas.beginFrame() consume _requestClearModel,
//  3. makes AtlasPage versions globally monotonic (no same-index collision
//     skipping texture re-upload after page merges),
//  4. removes gl.generateMipmap (ANGLE GL_INVALID_OPERATION source, #5987),
//  5. fixes the merge-page index sort comparator.
//
// If @xterm/addon-webgl is ever upgraded, this test fails until the patch is
// re-ported or the upgrade demonstrably contains the upstream fixes.
describe('@xterm/addon-webgl atlas corruption patch', () => {
  const require = createRequire(import.meta.url)
  const pkgJsonPath = require.resolve('@xterm/addon-webgl/package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version: string; main: string; module: string }
  const read = (rel: string) => readFileSync(pkgJsonPath.replace(/package\.json$/, rel), 'utf8')

  it('is applied to the exact patched version', () => {
    expect(pkg.version).toBe('0.19.0')
  })

  it.each([
    ['module', 'lib/addon-webgl.mjs'],
    ['main', 'lib/addon-webgl.js'],
  ])('keeps the %s bundle patched', (_kind, rel) => {
    const source = read(rel)
    // 1. private atlas: the cache loop returning a sibling's atlas is removed
    expect(source).not.toMatch(/return \w+\.ownedBy\.push\(\w+\),\s*\w+\.atlas\}/)
    // 2. beginFrame consumes the merge flag instead of returning it forever
    expect(source).not.toMatch(/beginFrame\(\)\s*\{\s*return this\._requestClearModel;?\s*\}/)
    // 3. globally monotonic page versions
    expect(source).toContain('__xtermAtlasPageV')
    expect(source).not.toContain('version++')
    // 4. no mipmap generation on atlas textures
    expect(source).not.toContain('generateMipmap')
  })
})
