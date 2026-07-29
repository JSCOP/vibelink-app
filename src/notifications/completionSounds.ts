export type BuiltInCompletionSoundId =
  | 'builtin:clear-chime'
  | 'builtin:soft-bell'
  | 'builtin:success-rise'
  | 'builtin:gentle-pulse'

export type CompletionSoundId = BuiltInCompletionSoundId | `custom:${string}`

export type CompletionSoundSettings = {
  completionSoundEnabled: boolean
  completionSoundId: CompletionSoundId
  completionSoundVolume: number
}

export type BuiltInCompletionSound = {
  id: BuiltInCompletionSoundId
  name: string
  description: string
}

export type CustomCompletionSound = {
  id: `custom:${string}`
  name: string
  mimeType: string
  size: number
  createdAt: number
}

type StoredCustomCompletionSound = CustomCompletionSound & {
  blob: Blob
}

type Tone = {
  frequency: number
  start: number
  duration: number
  gain: number
  wave: OscillatorType
}

export const defaultCompletionSoundId: BuiltInCompletionSoundId = 'builtin:clear-chime'
export const maxCustomCompletionSoundBytes = 10 * 1024 * 1024

export const builtInCompletionSounds: readonly BuiltInCompletionSound[] = [
  { id: 'builtin:clear-chime', name: 'Clear chime', description: 'Balanced two-note completion cue.' },
  { id: 'builtin:soft-bell', name: 'Soft bell', description: 'Warm bell with a gentle decay.' },
  { id: 'builtin:success-rise', name: 'Success rise', description: 'Short rising three-note confirmation.' },
  { id: 'builtin:gentle-pulse', name: 'Gentle pulse', description: 'Low-key pulse for quieter workspaces.' },
]

const supportedCustomExtensions: Record<string, true> = { aac: true, flac: true, m4a: true, mp3: true, ogg: true, wav: true }
const customMimeTypeByExtension: Record<string, string> = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
}
const builtinIds: Record<BuiltInCompletionSoundId, true> = {
  'builtin:clear-chime': true,
  'builtin:soft-bell': true,
  'builtin:success-rise': true,
  'builtin:gentle-pulse': true,
}
const dbName = 'vibelink-completion-sounds'
const storeName = 'sounds'
let databasePromise: Promise<IDBDatabase | null> | undefined
let sharedAudioContext: AudioContext | undefined
const customSoundBufferCache = new Map<string, Promise<AudioBuffer>>()

const toneRecipes: Record<BuiltInCompletionSoundId, readonly Tone[]> = {
  'builtin:clear-chime': [
    { frequency: 659.25, start: 0, duration: 0.42, gain: 0.62, wave: 'sine' },
    { frequency: 880, start: 0.16, duration: 0.54, gain: 0.54, wave: 'sine' },
    { frequency: 1760, start: 0.16, duration: 0.24, gain: 0.08, wave: 'triangle' },
  ],
  'builtin:soft-bell': [
    { frequency: 783.99, start: 0, duration: 0.78, gain: 0.5, wave: 'sine' },
    { frequency: 1567.98, start: 0, duration: 0.46, gain: 0.12, wave: 'sine' },
    { frequency: 2351.97, start: 0.01, duration: 0.28, gain: 0.05, wave: 'triangle' },
  ],
  'builtin:success-rise': [
    { frequency: 523.25, start: 0, duration: 0.26, gain: 0.42, wave: 'triangle' },
    { frequency: 659.25, start: 0.12, duration: 0.3, gain: 0.44, wave: 'triangle' },
    { frequency: 783.99, start: 0.24, duration: 0.46, gain: 0.5, wave: 'triangle' },
  ],
  'builtin:gentle-pulse': [
    { frequency: 440, start: 0, duration: 0.28, gain: 0.34, wave: 'sine' },
    { frequency: 554.37, start: 0.14, duration: 0.34, gain: 0.3, wave: 'sine' },
  ],
}

export function isCompletionSoundId(value: unknown): value is CompletionSoundId {
  return typeof value === 'string' && (Object.hasOwn(builtinIds, value) || /^custom:[a-z0-9-]{8,}$/i.test(value))
}

function isCustomCompletionSoundId(value: CompletionSoundId): value is `custom:${string}` {
  return value.startsWith('custom:')
}

export function customCompletionSoundValidationError(file: Pick<File, 'name' | 'size'>): string | null {
  const extension = file.name.trim().split('.').pop()?.toLowerCase() ?? ''
  if (!supportedCustomExtensions[extension]) return 'Choose an MP3, WAV, OGG, M4A, AAC, or FLAC audio file.'
  if (file.size <= 0) return 'The selected audio file is empty.'
  if (file.size > maxCustomCompletionSoundBytes) return 'Notification sounds must be 10 MB or smaller.'
  return null
}

export async function addCustomCompletionSound(file: File): Promise<CustomCompletionSound> {
  const validationError = customCompletionSoundValidationError(file)
  if (validationError) throw new Error(validationError)
  const database = await completionSoundDatabase()
  if (!database) throw new Error('Custom sound storage is unavailable.')
  const extension = file.name.trim().split('.').pop()?.toLowerCase() ?? ''
  const record: StoredCustomCompletionSound = {
    id: `custom:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`,
    name: file.name.trim().slice(0, 160),
    mimeType: file.type || customMimeTypeByExtension[extension] || 'application/octet-stream',
    size: file.size,
    createdAt: Date.now(),
    blob: file.slice(0, file.size, file.type || customMimeTypeByExtension[extension]),
  }
  const transaction = database.transaction(storeName, 'readwrite')
  transaction.objectStore(storeName).put(record)
  await transactionComplete(transaction)
  return { id: record.id, name: record.name, mimeType: record.mimeType, size: record.size, createdAt: record.createdAt }
}

export async function listCustomCompletionSounds(): Promise<CustomCompletionSound[]> {
  const database = await completionSoundDatabase()
  if (!database) return []
  const transaction = database.transaction(storeName, 'readonly')
  const records = await requestResult(transaction.objectStore(storeName).getAll()) as StoredCustomCompletionSound[]
  await transactionComplete(transaction)
  return records
    .map(({ id, name, mimeType, size, createdAt }) => ({ id, name, mimeType, size, createdAt }))
    .sort((left, right) => left.createdAt - right.createdAt)
}

export async function removeCustomCompletionSound(id: CompletionSoundId): Promise<void> {
  if (!id.startsWith('custom:')) return
  customSoundBufferCache.delete(id)
  const database = await completionSoundDatabase()
  if (!database) return
  const transaction = database.transaction(storeName, 'readwrite')
  transaction.objectStore(storeName).delete(id)
  await transactionComplete(transaction)
}

export async function prepareCompletionSoundPlayback(): Promise<boolean> {
  return Boolean(await readyAudioContext())
}

export async function playCompletionSound(settings: CompletionSoundSettings): Promise<boolean> {
  if (!settings.completionSoundEnabled) return false
  const volume = clampVolume(settings.completionSoundVolume)
  if (isCustomCompletionSoundId(settings.completionSoundId)) return playCustomSound(settings.completionSoundId, volume)
  return playBuiltInSound(settings.completionSoundId, volume)
}

async function playBuiltInSound(id: BuiltInCompletionSoundId, volume: number): Promise<boolean> {
  const context = await readyAudioContext()
  if (!context) return false
  const now = context.currentTime
  const recipe = toneRecipes[id]
  const master = context.createGain()
  master.gain.setValueAtTime(volume, now)
  master.connect(context.destination)

  for (const tone of recipe) {
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    const start = now + tone.start
    const end = start + tone.duration
    oscillator.type = tone.wave
    oscillator.frequency.setValueAtTime(tone.frequency, start)
    envelope.gain.setValueAtTime(0.0001, start)
    envelope.gain.exponentialRampToValueAtTime(tone.gain, start + Math.min(0.018, tone.duration / 4))
    envelope.gain.exponentialRampToValueAtTime(0.0001, end)
    oscillator.connect(envelope)
    envelope.connect(master)
    oscillator.start(start)
    oscillator.stop(end)
  }

  return true
}

async function playCustomSound(id: `custom:${string}`, volume: number): Promise<boolean> {
  const [context, record] = await Promise.all([readyAudioContext(), customSoundRecord(id)])
  if (!context || !record) return false
  let bufferPromise = customSoundBufferCache.get(id)
  if (!bufferPromise) {
    bufferPromise = record.blob.arrayBuffer().then((bytes) => context.decodeAudioData(bytes))
    customSoundBufferCache.set(id, bufferPromise)
  }
  try {
    const source = context.createBufferSource()
    const gain = context.createGain()
    source.buffer = await bufferPromise
    gain.gain.setValueAtTime(volume, context.currentTime)
    source.connect(gain)
    gain.connect(context.destination)
    source.start()
    return true
  } catch (error) {
    customSoundBufferCache.delete(id)
    throw error
  }
}

async function readyAudioContext(): Promise<AudioContext | null> {
  const AudioContextConstructor = globalThis.AudioContext
  if (!AudioContextConstructor) return null
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') sharedAudioContext = new AudioContextConstructor()
  if (sharedAudioContext.state !== 'running') await sharedAudioContext.resume()
  return sharedAudioContext.state === 'running' ? sharedAudioContext : null
}

async function customSoundRecord(id: `custom:${string}`): Promise<StoredCustomCompletionSound | undefined> {
  const database = await completionSoundDatabase()
  if (!database) return undefined
  const transaction = database.transaction(storeName, 'readonly')
  const record = await requestResult(transaction.objectStore(storeName).get(id)) as StoredCustomCompletionSound | undefined
  await transactionComplete(transaction)
  return record
}

function completionSoundDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase | null>()
  databasePromise = promise
  const request = indexedDB.open(dbName, 1)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'id' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('Could not open custom sound storage.'))
  return promise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('Custom sound storage request failed.'))
  return promise
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  transaction.oncomplete = () => resolve()
  transaction.onerror = () => reject(transaction.error ?? new Error('Custom sound storage transaction failed.'))
  transaction.onabort = () => reject(transaction.error ?? new Error('Custom sound storage transaction was cancelled.'))
  return promise
}


function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0.55
  return Math.min(1, Math.max(0, value))
}

