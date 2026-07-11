export const SIDEBAR_PIN_STORAGE_KEY = 'vibelink:sidebarPinned'

export function loadSidebarPinned(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(SIDEBAR_PIN_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function saveSidebarPinned(pinned: boolean, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(SIDEBAR_PIN_STORAGE_KEY, pinned ? '1' : '0')
  } catch {
    // Storage can be unavailable in hardened WebViews; pinning still works for the current run.
  }
}
