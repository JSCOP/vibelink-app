import { create } from 'zustand'
import type { SettingsSectionId } from '../components/settings/sections'

/**
 * App-chrome dialogs that more than one surface can open. The topbar, command
 * palette, and the sidebar toolbar all sit in different subtrees, so ownership
 * lives here instead of being drilled down from `App` as callbacks.
 */
type AppChromeState = {
  /** Section the settings dialog opens on; `null` while it is closed. */
  settingsSection: SettingsSectionId | null
  bugReportOpen: boolean
  openSettings: (section?: SettingsSectionId) => void
  closeSettings: () => void
  openBugReport: () => void
  closeBugReport: () => void
}

export const useAppChromeStore = create<AppChromeState>((set) => ({
  settingsSection: null,
  bugReportOpen: false,
  openSettings: (section = 'account') => set({ settingsSection: section }),
  closeSettings: () => set({ settingsSection: null }),
  openBugReport: () => set({ bugReportOpen: true }),
  closeBugReport: () => set({ bugReportOpen: false }),
}))
