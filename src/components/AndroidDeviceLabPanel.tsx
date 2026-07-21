import { open } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Accessibility, Box, LoaderCircle, Play, RefreshCw, Smartphone, Square, TerminalSquare } from 'lucide-react'
import {
  cancelOwnedDeviceProcess,
  changeAndroidPermission,
  discoverAndroidSdk,
  getAccessibilityStatus,
  installApk,
  launchAndroidApp,
  listAdbDevices,
  listAvds,
  readLogcat,
  startAvd,
  startScrcpy,
  type AccessibilityStatus,
  type AdbDevice,
  type OwnedProcessInfo,
  type SdkDiscovery,
} from '../ipc/deviceLab'
import './AndroidDeviceLabPanel.css'

export function AndroidDeviceLabPanel() {
  const [sdkRoot, setSdkRoot] = useState('')
  const [sdk, setSdk] = useState<SdkDiscovery | null>(null)
  const [devices, setDevices] = useState<AdbDevice[]>([])
  const [serial, setSerial] = useState('')
  const [avds, setAvds] = useState<string[]>([])
  const [selectedAvd, setSelectedAvd] = useState('')
  const [packageName, setPackageName] = useState('')
  const [activity, setActivity] = useState('')
  const [permission, setPermission] = useState('android.permission.POST_NOTIFICATIONS')
  const [accessibility, setAccessibility] = useState<AccessibilityStatus | null>(null)
  const [logcat, setLogcat] = useState('')
  const [owned, setOwned] = useState<OwnedProcessInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const selectedDevice = useMemo(() => devices.find((device) => device.serial === serial) ?? null, [devices, serial])

  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true)
    setMessage(null)
    try { await operation() }
    catch (error) { setMessage(errorMessage(error)) }
    finally { setBusy(false) }
  }, [])

  const refresh = useCallback(() => run(async () => {
    const nextSdk = await discoverAndroidSdk(sdkRoot)
    setSdk(nextSdk)
    if (nextSdk.root && !sdkRoot) setSdkRoot(nextSdk.root)
    if (!nextSdk.available) {
      setDevices([])
      setAvds([])
      setMessage(`Android SDK incomplete: ${nextSdk.missing.join(', ')}`)
      return
    }
    const [nextDevices, nextAvds] = await Promise.all([listAdbDevices(nextSdk.root ?? sdkRoot), listAvds(nextSdk.root ?? sdkRoot)])
    setDevices(nextDevices)
    setAvds(nextAvds)
    setSerial((current) => nextDevices.some((device) => device.serial === current) ? current : nextDevices[0]?.serial ?? '')
    setSelectedAvd((current) => nextAvds.includes(current) ? current : nextAvds[0] ?? '')
    setMessage(`${nextDevices.length} adb devices and ${nextAvds.length} virtual devices found.`)
  }), [run, sdkRoot])

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh() }, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  const launchAvd = () => run(async () => {
    const process = await startAvd(sdkRoot, selectedAvd, false)
    setOwned((current) => [...current.filter((item) => item.operationId !== process.operationId), process])
    setMessage(`Started AVD ${selectedAvd} as exact owned PID ${process.pid}.`)
  })

  const chooseAndInstallApk = () => run(async () => {
    if (!serial) throw new Error('Select an online adb device first.')
    const selected = await open({ multiple: false, directory: false, filters: [{ name: 'Android package', extensions: ['apk'] }] })
    if (typeof selected !== 'string') return
    const output = await installApk(sdkRoot, serial, selected)
    setMessage(output.stdout.trim() || `APK installed on ${serial}.`)
  })

  const launchApp = () => run(async () => {
    if (!serial) throw new Error('Select an online adb device first.')
    const output = await launchAndroidApp(sdkRoot, serial, packageName, activity)
    setMessage(output.stdout.trim() || `Launched ${packageName}.`)
  })

  const updatePermission = (action: 'grant' | 'revoke') => run(async () => {
    if (!serial) throw new Error('Select an online adb device first.')
    await changeAndroidPermission(sdkRoot, serial, packageName, permission, action)
    setMessage(`${action === 'grant' ? 'Granted' : 'Revoked'} ${permission}.`)
  })

  const checkAccessibility = () => run(async () => {
    if (!serial) throw new Error('Select an online adb device first.')
    setAccessibility(await getAccessibilityStatus(sdkRoot, serial))
  })

  const captureLogcat = () => run(async () => {
    if (!serial) throw new Error('Select an online adb device first.')
    const output = await readLogcat(sdkRoot, serial)
    setLogcat(output.stdout)
    setMessage(output.stdoutTruncated ? 'Logcat captured with an explicit 2 MiB truncation.' : 'Bounded logcat captured.')
  })

  const mirrorDevice = () => run(async () => {
    if (!serial) throw new Error('Select an online adb device first.')
    const process = await startScrcpy(sdkRoot, serial)
    setOwned((current) => [...current.filter((item) => item.operationId !== process.operationId), process])
    setMessage(`Started scrcpy as exact owned PID ${process.pid}.`)
  })

  const stopProcess = (process: OwnedProcessInfo) => run(async () => {
    await cancelOwnedDeviceProcess(process)
    setOwned((current) => current.filter((item) => item.operationId !== process.operationId))
    setMessage(`Stopped exact owned PID ${process.pid}.`)
  })

  return (
    <section className="android-device-lab" aria-label="Android Device Lab">
      <header>
        <div><h3>Android Device Lab</h3><p>SDK, ADB, emulator, and scrcpy actions are typed, bounded, cancellable, and tied to exact owned PIDs.</p></div>
        <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Refresh</button>
      </header>

      <div className="android-device-lab-grid">
        <label>Android SDK root<input value={sdkRoot} placeholder="Auto-detect from ANDROID_SDK_ROOT" onChange={(event) => setSdkRoot(event.target.value)} /></label>
        <div className="android-device-lab-status" data-available={sdk?.available || undefined}>
          <strong>{sdk?.available ? 'SDK ready' : 'SDK not ready'}</strong>
          <span>{sdk?.root ?? 'No Android SDK root discovered'}</span>
          {sdk?.missing.length ? <small>Missing: {sdk.missing.join(', ')}</small> : null}
        </div>
      </div>

      <div className="android-device-lab-grid">
        <label>ADB device<select value={serial} onChange={(event) => setSerial(event.target.value)}><option value="">Select a device</option>{devices.map((device) => <option key={device.serial} value={device.serial}>{device.model ?? device.serial} · {device.state}</option>)}</select></label>
        <label>Android virtual device<div className="android-device-lab-row"><select value={selectedAvd} onChange={(event) => setSelectedAvd(event.target.value)}><option value="">Select an AVD</option>{avds.map((avd) => <option key={avd} value={avd}>{avd}</option>)}</select><button type="button" disabled={busy || !selectedAvd} onClick={() => void launchAvd()}><Play size={14} /> Start</button></div></label>
      </div>

      <div className="android-device-lab-actions">
        <button type="button" disabled={busy || !selectedDevice || selectedDevice.state !== 'device'} onClick={() => void chooseAndInstallApk()}><Box size={14} /> Install APK</button>
        <button type="button" disabled={busy || !selectedDevice || selectedDevice.state !== 'device'} onClick={() => void mirrorDevice()}><Smartphone size={14} /> Start scrcpy</button>
        <button type="button" disabled={busy || !selectedDevice || selectedDevice.state !== 'device'} onClick={() => void checkAccessibility()}><Accessibility size={14} /> Accessibility status</button>
        <button type="button" disabled={busy || !selectedDevice || selectedDevice.state !== 'device'} onClick={() => void captureLogcat()}><TerminalSquare size={14} /> Bounded logcat</button>
      </div>

      <div className="android-device-lab-grid android-device-lab-app-controls">
        <label>Package<input value={packageName} placeholder="com.example.app" onChange={(event) => setPackageName(event.target.value)} /></label>
        <label>Activity (optional)<input value={activity} placeholder=".MainActivity" onChange={(event) => setActivity(event.target.value)} /></label>
        <button type="button" disabled={busy || !serial || !packageName.trim()} onClick={() => void launchApp()}><Play size={14} /> Launch app</button>
      </div>

      <div className="android-device-lab-grid android-device-lab-permissions">
        <label>Runtime permission<input value={permission} onChange={(event) => setPermission(event.target.value)} /></label>
        <div className="android-device-lab-row"><button type="button" disabled={busy || !serial || !packageName.trim() || !permission.trim()} onClick={() => void updatePermission('grant')}>Grant</button><button type="button" disabled={busy || !serial || !packageName.trim() || !permission.trim()} onClick={() => void updatePermission('revoke')}>Revoke</button></div>
      </div>

      {accessibility ? <div className="android-device-lab-status" data-available={accessibility.enabled || undefined}><strong>Accessibility {accessibility.enabled ? 'enabled' : 'disabled'}</strong><span>{accessibility.services.length ? accessibility.services.join(', ') : 'No enabled accessibility services'}</span></div> : null}

      {owned.length ? <div className="android-device-lab-processes"><h4>Owned processes</h4>{owned.map((process) => <div key={process.operationId}><span>{process.kind} · PID {process.pid}</span><code>{process.executable} {process.args.join(' ')}</code><button type="button" onClick={() => void stopProcess(process)}><Square size={12} /> Stop exact PID</button></div>)}</div> : null}

      {logcat ? <pre className="android-device-lab-logcat">{logcat}</pre> : null}
      {message ? <div className="android-device-lab-message" role="status">{message}</div> : null}
    </section>
  )
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}
