import type { VoiceDevice } from '../state/profiles'
import type { VoiceGpuInfo } from '../ipc/voice'

export type VoiceModel = {
  id: string
  name: string
  fileName: string
  bytes: number
  hardware: 'CPU' | 'CPU / GPU' | 'GPU'
}

export const voiceModels: VoiceModel[] = [
  { id: 'tiny-q8_0', name: 'Tiny Q8', fileName: 'ggml-tiny-q8_0.bin', bytes: 43_537_433, hardware: 'CPU' },
  { id: 'base-q8_0', name: 'Base Q8', fileName: 'ggml-base-q8_0.bin', bytes: 81_768_585, hardware: 'CPU' },
  { id: 'small-q8_0', name: 'Small Q8', fileName: 'ggml-small-q8_0.bin', bytes: 264_464_607, hardware: 'CPU / GPU' },
  { id: 'medium-q8_0', name: 'Medium Q8', fileName: 'ggml-medium-q8_0.bin', bytes: 823_369_779, hardware: 'GPU' },
  { id: 'large-v3-turbo-q5_0', name: 'Large v3 Turbo Q5', fileName: 'ggml-large-v3-turbo-q5_0.bin', bytes: 574_041_195, hardware: 'GPU' },
  { id: 'large-v3-turbo-q8_0', name: 'Large v3 Turbo Q8', fileName: 'ggml-large-v3-turbo-q8_0.bin', bytes: 874_188_075, hardware: 'GPU' },
  { id: 'large-v3-q5_0', name: 'Large v3 Q5', fileName: 'ggml-large-v3-q5_0.bin', bytes: 1_081_140_203, hardware: 'GPU' },
]

export type VoiceRecommendation = { modelId: string; device: VoiceDevice }

export function recommendVoiceModel(gpu: VoiceGpuInfo | null): VoiceRecommendation {
  if (!gpu?.isNvidia) return { modelId: 'base-q8_0', device: 'cpu' }
  if (gpu.dedicatedVideoMemoryMb >= 8192) return { modelId: 'large-v3-turbo-q8_0', device: 'gpu' }
  if (gpu.dedicatedVideoMemoryMb >= 4096) return { modelId: 'large-v3-turbo-q5_0', device: 'gpu' }
  if (gpu.dedicatedVideoMemoryMb >= 2048) return { modelId: 'small-q8_0', device: 'gpu' }
  return { modelId: 'base-q8_0', device: 'cpu' }
}

export function formatVoiceModelSize(bytes: number) {
  return `${(bytes / 1_000_000).toFixed(bytes >= 1_000_000_000 ? 0 : 1)} MB`
}
