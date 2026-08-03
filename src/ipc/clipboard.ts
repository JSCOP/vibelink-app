import { invoke } from '@tauri-apps/api/core'

// The WebView2 host document loses Win32 focus to guest webviews and native
// panes, and `navigator.clipboard` then throws "Document is not focused" (or is
// missing entirely outside a secure context). Native arboard access is
// focus-independent, so it is the primary path and the browser API is only the
// fallback for non-Tauri contexts such as tests.
export async function writeClipboardText(text: string): Promise<void> {
  try {
    await invoke('clipboard_write_text', { text })
  } catch {
    await navigator.clipboard.writeText(text)
  }
}

export async function readClipboardText(): Promise<string> {
  try {
    return await invoke<string>('clipboard_read_text')
  } catch {
    return (await navigator.clipboard?.readText?.()) ?? ''
  }
}
