import { describe, expect, test } from 'vitest'
import { recommendVoiceModel, voiceModels } from './models'

describe('voice model recommendation', () => {
  test('uses the deterministic NVIDIA VRAM tiers', () => {
    expect(recommendVoiceModel({ name: 'RTX', vendorId: 0x10DE, dedicatedVideoMemoryMb: 16_000, isNvidia: true })).toEqual({ modelId: 'large-v3-turbo-q8_0', device: 'gpu' })
    expect(recommendVoiceModel({ name: 'RTX', vendorId: 0x10DE, dedicatedVideoMemoryMb: 6_000, isNvidia: true })).toEqual({ modelId: 'large-v3-turbo-q5_0', device: 'gpu' })
    expect(recommendVoiceModel({ name: 'RTX', vendorId: 0x10DE, dedicatedVideoMemoryMb: 3_000, isNvidia: true })).toEqual({ modelId: 'small-q8_0', device: 'gpu' })
  })

  test('falls back to the CPU base model', () => {
    expect(recommendVoiceModel(null)).toEqual({ modelId: 'base-q8_0', device: 'cpu' })
    expect(recommendVoiceModel({ name: 'Radeon', vendorId: 0x1002, dedicatedVideoMemoryMb: 16_000, isNvidia: false })).toEqual({ modelId: 'base-q8_0', device: 'cpu' })
  })

  test('contains the complete curated catalog', () => {
    expect(voiceModels.map((model) => model.id)).toEqual([
      'tiny-q8_0',
      'base-q8_0',
      'small-q8_0',
      'medium-q8_0',
      'large-v3-turbo-q5_0',
      'large-v3-turbo-q8_0',
      'large-v3-q5_0',
    ])
  })
})
