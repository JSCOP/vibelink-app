// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createDockview } from 'dockview-core'
import { describe, expect, it } from 'vitest'

Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } })

// Guards patches/dockview-core@6.6.1.patch. Dockview 6.6.1 normally runs a
// complete splitview layout synchronously for every raw pointermove. The patch
// keeps Dockview as the geometry authority, but coalesces the latest sash delta
// to one animation-frame layout and flushes the landed delta before proportions
// are saved. Re-port or remove this guard only after an upgrade proves the same
// ordering in the Vite bundle and the deep-import builds.
describe('dockview-core frame-coalesced sash patch', () => {
  const require = createRequire(import.meta.url)
  const pkgJsonPath = require.resolve('dockview-core/package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version: string }
  const read = (rel: string) => readFileSync(pkgJsonPath.replace(/package\.json$/, rel), 'utf8')

  it('is applied to the exact patched version', () => {
    expect(pkg.version).toBe('6.6.1')
  })

  it.each([
    ['Vite ESM bundle', 'dist/package/main.esm.mjs'],
    ['package CJS bundle', 'dist/package/main.cjs.js'],
    ['modular ESM build', 'dist/esm/splitview/splitview.js'],
    ['modular CJS build', 'dist/cjs/splitview/splitview.js'],
  ])('keeps the %s frame-coalesced', (_kind, rel) => {
    const source = read(rel)
    const marker = source.indexOf('pendingDelta')
    expect(marker).toBeGreaterThan(-1)
    const resizeBlock = source.slice(marker, marker + 3_000)

    const resizeAt = resizeBlock.indexOf('.resize(sashIndex, delta')
    const distributeAt = resizeBlock.indexOf('.distributeEmptySpace()', resizeAt)
    const layoutAt = resizeBlock.indexOf('.layoutViews()', distributeAt)
    const armAt = resizeBlock.indexOf('requestAnimationFrame(flushResize)')
    const cancelAt = resizeBlock.indexOf('cancelAnimationFrame(resizeFrame)')
    const finalFlushAt = resizeBlock.indexOf('flushResize();', cancelAt)
    const saveAt = resizeBlock.indexOf('.saveProportions()', finalFlushAt)

    expect(resizeAt).toBeGreaterThan(-1)
    expect(distributeAt).toBeGreaterThan(resizeAt)
    expect(layoutAt).toBeGreaterThan(distributeAt)
    expect(armAt).toBeGreaterThan(layoutAt)
    expect(cancelAt).toBeGreaterThan(armAt)
    expect(finalFlushAt).toBeGreaterThan(cancelAt)
    expect(saveAt).toBeGreaterThan(finalFlushAt)
  })
})

describe('dockview-core reusable edge panel patch', () => {
  const require = createRequire(import.meta.url)
  const pkgJsonPath = require.resolve('dockview-core/package.json')
  const read = (rel: string) => readFileSync(pkgJsonPath.replace(/package\.json$/, rel), 'utf8')

  it.each([
    ['Vite ESM bundle', 'dist/package/main.esm.mjs'],
    ['package CJS bundle', 'dist/package/main.cjs.js'],
    ['modular ESM build', 'dist/esm/dockview/dockviewComponent.js'],
    ['modular CJS build', 'dist/cjs/dockview/dockviewComponent.js'],
  ])('keeps reusable edge panels in the %s', (_kind, rel) => {
    const source = read(rel)
    const edgeRestore = source.slice(source.indexOf('Restore panel contents of edge groups'), source.indexOf('Restore panel contents of edge groups') + 3_000)
    expect(edgeRestore).toContain('existingPanels.get(panelId)')
    expect(edgeRestore).toContain('tempGroup.model.removePanel(existingPanel)')
  })

  it('retains the same edge panel component across fromJSON', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let createCount = 0
    const api = createDockview(host, {
      createComponent: () => {
        createCount += 1
        return { element: document.createElement('div'), init: () => undefined }
      },
    })
    try {
      api.layout(800, 500)
      api.addPanel({ id: 'center', component: 'test' })
      api.addEdgeGroup('left', { id: 'left-edge', initialSize: 240 })
      api.addPanel({ id: 'edge', component: 'test', position: { referenceGroup: 'left-edge' } })
      const edgePanel = api.getPanel('edge')

      api.fromJSON(api.toJSON(), { reuseExistingPanels: true })

      expect(api.getPanel('edge')).toBe(edgePanel)
      expect(api.getPanel('edge')?.group.api.location.type).toBe('edge')
      expect(createCount).toBe(2)
    } finally {
      api.dispose()
      host.remove()
    }
  })
})
