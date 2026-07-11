import { useEffect, useState } from 'react'
import { Cpu, Mic2 } from 'lucide-react'
import { getVoiceGpuInfo, type VoiceGpuInfo } from '../ipc/voice'
import type { VoiceDevice } from '../state/profiles'
import { formatVoiceModelSize, recommendVoiceModel, voiceModels } from '../voice/models'

type VoiceSetupDialogProps = {
  onUse: (modelId: string, device: VoiceDevice) => void
  onSkip: () => void
}

export function VoiceSetupDialog({ onUse, onSkip }: VoiceSetupDialogProps) {
  const [gpu, setGpu] = useState<VoiceGpuInfo | null>(null)
  const [probeFailed, setProbeFailed] = useState(false)
  const [selectedModelId, setSelectedModelId] = useState('base-q8_0')
  const recommendation = recommendVoiceModel(gpu)

  useEffect(() => {
    let disposed = false
    void getVoiceGpuInfo()
      .then((detected) => {
        if (disposed) return
        setGpu(detected)
        setSelectedModelId(recommendVoiceModel(detected).modelId)
      })
      .catch(() => {
        if (disposed) return
        setProbeFailed(true)
        setGpu(null)
        setSelectedModelId('base-q8_0')
      })
    return () => { disposed = true }
  }, [])

  const selectedDevice: VoiceDevice = selectedModelId === recommendation.modelId
    ? recommendation.device
    : voiceModels.find((model) => model.id === selectedModelId)?.hardware === 'CPU'
      ? 'cpu'
      : 'auto'

  return (
    <div className="voice-setup-backdrop" role="presentation">
      <section className="voice-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="voice-setup-title">
        <header className="voice-setup-header">
          <div className="voice-setup-icon"><Mic2 size={22} /></div>
          <div>
            <p className="settings-eyebrow">Local voice input</p>
            <h2 id="voice-setup-title">Choose a Whisper model</h2>
            <p>Hold Ctrl + Win to talk. Audio and transcription stay on this PC.</p>
          </div>
        </header>

        <div className="voice-setup-hardware">
          <Cpu size={16} />
          {probeFailed ? (
            <span>GPU 감지 실패 · CPU model recommended</span>
          ) : gpu ? (
            <span>{gpu.name || 'No dedicated GPU'} · {gpu.dedicatedVideoMemoryMb > 0 ? `${(gpu.dedicatedVideoMemoryMb / 1024).toFixed(1)} GB VRAM` : 'CPU mode'}</span>
          ) : (
            <span>Detecting GPU…</span>
          )}
        </div>

        <div className="voice-setup-models" role="radiogroup" aria-label="Whisper models">
          {voiceModels.map((model) => {
            const recommended = model.id === recommendation.modelId
            return (
              <button
                key={model.id}
                type="button"
                role="radio"
                aria-checked={selectedModelId === model.id}
                className={selectedModelId === model.id ? 'selected' : undefined}
                onClick={() => setSelectedModelId(model.id)}
              >
                <span className="voice-setup-model-main">
                  <strong>{model.name}</strong>
                  {recommended ? <em>추천 / Recommended</em> : null}
                </span>
                <span>{formatVoiceModelSize(model.bytes)} · {model.hardware}</span>
              </button>
            )
          })}
        </div>

        <footer className="voice-setup-footer">
          <button type="button" onClick={onSkip}>Skip (voice off)</button>
          <button type="button" className="primary-action" onClick={() => onUse(selectedModelId, selectedDevice)}>Use this model</button>
        </footer>
      </section>
    </div>
  )
}
