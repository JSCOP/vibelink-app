export type VoiceSidecarStatus = 'idle' | 'loading' | 'recording' | 'processing' | 'error'

export type VoiceSidecarConfig = {
  model_id: string
  device: 'auto' | 'gpu' | 'cpu'
  language: string | null
  beam_size: number
  mute_speakers: boolean
  add_trailing_space: boolean
  add_trailing_newline: boolean
  initial_prompt: string
}

export type VoiceServerMessage =
  | { type: 'ready'; version: string; _correlationId?: string }
  | { type: 'pong'; _correlationId?: string }
  | { type: 'status'; status: VoiceSidecarStatus; message?: string; _correlationId?: string }
  | { type: 'transcription'; text: string; language: string; audio_duration: number; processing_time: number; _correlationId?: string }
  | { type: 'audio_level'; level: number; _correlationId?: string }
  | { type: 'devices'; devices: Array<{ index: number; name: string; channels: number; sample_rate: number; is_default: boolean }>; _correlationId?: string }
  | { type: 'error'; message: string; code: string; recoverable: boolean; fatal: boolean; _correlationId?: string }
  | { type: 'config_updated'; changed: string[]; _correlationId?: string }
  | { type: 'model_download_progress'; stage: string; downloaded_bytes?: number; total_bytes?: number; percent?: number; model_id?: string; _correlationId?: string }
  | { type: 'model_runtime_info'; effective_device: 'gpu' | 'cpu'; model_id: string; _correlationId?: string }

type VoiceClientMessage =
  | { type: 'ping' }
  | { type: 'get_status' }
  | { type: 'get_devices' }
  | { type: 'set_config'; config: Partial<VoiceSidecarConfig> }
  | { type: 'start_recording' }
  | { type: 'stop_recording' }
  | { type: 'cancel_recording' }

type Listener = (message: VoiceServerMessage) => void

type AckWaiter = {
  expectedType: VoiceServerMessage['type']
  resolve: (message: VoiceServerMessage) => void
  reject: (error: Error) => void
  timer: number
}

export class VoiceClient {
  private socket: WebSocket | null = null
  private port = 0
  private token = ''
  private reconnectTimer: number | null = null
  private reconnectAttempts = 0
  private shouldReconnect = false
  private correlationId = 0
  private readonly listeners = new Set<Listener>()
  private readonly queue: Array<VoiceClientMessage & { _correlationId?: string }> = []
  private readonly ackWaiters = new Map<string, AckWaiter>()

  connect(port: number, token: string) {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.socket) {
      this.socket.onclose = null
      this.socket.close()
      this.socket = null
    }
    this.port = port
    this.token = token
    this.shouldReconnect = true
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const onReady: Listener = (message) => {
      if (message.type !== 'ready') return
      this.listeners.delete(onReady)
      resolve()
    }
    this.listeners.add(onReady)
    this.open(reject)
    return promise
  }

  disconnect() {
    this.shouldReconnect = false
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.failWaiters(new Error('Voice sidecar connection closed'))
    if (this.socket) {
      this.socket.onclose = null
      this.socket.close()
      this.socket = null
    }
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setConfig(config: Partial<VoiceSidecarConfig>) {
    this.send({ type: 'set_config', config, _correlationId: `voice_${this.correlationId++}` })
  }

  requestStatus() {
    return this.sendWithAck({ type: 'get_status' }, 'status')
  }

  startRecording() { this.send({ type: 'start_recording' }) }
  stopRecording() { this.send({ type: 'stop_recording' }) }
  cancelRecording() { this.send({ type: 'cancel_recording' }) }

  private open(initialReject?: (error: Error) => void) {
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/ws?token=${encodeURIComponent(this.token)}`)
    this.socket = socket
    socket.onopen = () => {
      this.reconnectAttempts = 0
      for (const message of this.queue.splice(0)) socket.send(JSON.stringify(message))
    }
    socket.onmessage = (event) => {
      let message: VoiceServerMessage
      try {
        message = JSON.parse(String(event.data)) as VoiceServerMessage
      } catch {
        return
      }
      if (message._correlationId) {
        const waiter = this.ackWaiters.get(message._correlationId)
        if (waiter) {
          window.clearTimeout(waiter.timer)
          this.ackWaiters.delete(message._correlationId)
          if (message.type === 'error') waiter.reject(new Error(`${message.code}: ${message.message}`))
          else if (message.type === waiter.expectedType) waiter.resolve(message)
          else waiter.reject(new Error(`Unexpected voice response: ${message.type}`))
        }
      }
      for (const listener of this.listeners) listener(message)
    }
    socket.onerror = () => initialReject?.(new Error('Could not connect to the voice sidecar'))
    socket.onclose = () => {
      this.socket = null
      this.failWaiters(new Error('Voice sidecar connection lost'))
      if (!this.shouldReconnect) return
      this.reconnectAttempts += 1
      const delay = Math.min(5000, 250 * 2 ** Math.min(this.reconnectAttempts, 5))
      this.reconnectTimer = window.setTimeout(() => this.open(), delay)
    }
  }

  private send(message: VoiceClientMessage & { _correlationId?: string }) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
    else {
      if (this.queue.length >= 50) this.queue.shift()
      this.queue.push(message)
    }
  }

  private sendWithAck(message: VoiceClientMessage, expectedType: VoiceServerMessage['type']) {
    const correlationId = `voice_${this.correlationId++}`
    const { promise, resolve, reject } = Promise.withResolvers<VoiceServerMessage>()
    const timer = window.setTimeout(() => {
      this.ackWaiters.delete(correlationId)
      reject(new Error(`Voice sidecar ${expectedType} response timed out`))
    }, 5000)
    this.ackWaiters.set(correlationId, { expectedType, resolve, reject, timer })
    this.send({ ...message, _correlationId: correlationId })
    return promise
  }

  private failWaiters(error: Error) {
    for (const waiter of this.ackWaiters.values()) {
      window.clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.ackWaiters.clear()
  }
}

export const voiceClient = new VoiceClient()
