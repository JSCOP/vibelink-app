import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import 'dockview-react/dist/styles/dockview.css'
import './index.css'
import { applyCaptureOverlayTransparency, isCaptureOverlayLabel } from './components/captureOverlay.ts'
import { appRuntimeIdentity } from './runtimeIdentity'

const isOverlay = isCaptureOverlayLabel(getCurrentWindow().label)
if (isOverlay) applyCaptureOverlayTransparency()

document.documentElement.dataset.vibelinkRuntime = appRuntimeIdentity.kind
document.documentElement.dataset.vibelinkProtected = String(appRuntimeIdentity.protected)
document.title = appRuntimeIdentity.browserTitle

if (import.meta.env.DEV) {
  void import('./terminal/TerminalManager').then(({ TerminalManager }) => {
    Object.assign(window, { __vibelinkDebug: { TerminalManager } })
  })
}

const root = createRoot(document.getElementById('root')!)
const loadRoot = isOverlay
  ? import('./components/CaptureOverlay.tsx').then((module) => module.default)
  : import('./App.tsx').then((module) => module.default)
void loadRoot.then((Root) => root.render(<StrictMode><Root /></StrictMode>))
