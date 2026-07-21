import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import 'dockview-react/dist/styles/dockview.css'
import './editor/monaco'
import './index.css'
import App from './App.tsx'
import CaptureOverlay from './components/CaptureOverlay.tsx'
import { applyCaptureOverlayTransparency } from './components/captureOverlay.ts'

const isOverlay = getCurrentWindow().label === 'capture-overlay'

if (isOverlay) {
  applyCaptureOverlayTransparency()
}

if (import.meta.env.DEV) {
  // Live-debug handle for the WebView2 devtools (Ctrl+Shift+I in dev builds):
  // lets a stuck pane be inspected in place, e.g.
  //   __vibelinkDebug.TerminalManager.getOrCreate('<pane-id>').term.buffer.active.type
  void import('./terminal/TerminalManager').then(({ TerminalManager }) => {
    ;(window as unknown as { __vibelinkDebug?: unknown }).__vibelinkDebug = { TerminalManager }
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isOverlay ? <CaptureOverlay /> : <App />}
  </StrictMode>,
)
