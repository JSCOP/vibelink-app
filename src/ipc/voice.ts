import { invoke } from '@tauri-apps/api/core'

export type VoiceSidecarInfo = { port: number; token: string }
export type VoiceGpuInfo = {
  name: string
  vendorId: number
  dedicatedVideoMemoryMb: number
  isNvidia: boolean
}

export function startVoiceSidecar(): Promise<VoiceSidecarInfo> {
  return invoke<VoiceSidecarInfo>('voice_start_sidecar')
}

export function stopVoiceSidecar(): Promise<void> {
  return invoke('voice_stop_sidecar')
}

export function getVoiceGpuInfo(): Promise<VoiceGpuInfo> {
  return invoke<VoiceGpuInfo>('voice_gpu_info')
}

export function getVoiceModelsDir(): Promise<string> {
  return invoke<string>('voice_models_dir')
}

export function enableVoiceHotkey(): Promise<void> {
  return invoke('voice_enable_hotkey')
}

export function disableVoiceHotkey(): Promise<void> {
  return invoke('voice_disable_hotkey')
}
