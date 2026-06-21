import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import 'dockview-react/dist/styles/dockview.css'
import './index.css'
import App from './App.tsx'
import CaptureOverlay from './components/CaptureOverlay.tsx'
import { applyCaptureOverlayTransparency } from './components/captureOverlay.ts'

const isOverlay = getCurrentWindow().label === 'capture-overlay'

if (isOverlay) {
  applyCaptureOverlayTransparency()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isOverlay ? <CaptureOverlay /> : <App />}
  </StrictMode>,
)
