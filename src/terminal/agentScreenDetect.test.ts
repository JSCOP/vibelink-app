import { describe, expect, test } from 'vitest'
import { detectAgentScreenState } from './agentScreenDetect'

describe('detectAgentScreenState', () => {
  test('claude permission form reads as blocked', () => {
    const screen = [
      'Some earlier output',
      '──────────────────────────',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No, and tell Claude what to do differently (esc)',
      ' enter to confirm · esc to cancel',
    ].join('\n')
    const detection = detectAgentScreenState('claude', screen, '')
    expect(detection).toMatchObject({ state: 'blocked' })
  })

  test('claude braille spinner title reads as working', () => {
    const detection = detectAgentScreenState('claude', '', '⠹ Zigzagging… (12s)')
    expect(detection).toMatchObject({ state: 'working', ruleId: 'osc_title_working' })
  })

  test('claude live prompt box reads as idle', () => {
    const screen = [
      'response text',
      '──────────────────────────',
      ' ❯ ',
      '──────────────────────────',
      '  ? for shortcuts',
    ].join('\n')
    const detection = detectAgentScreenState('claude', screen, '')
    expect(detection).toMatchObject({ state: 'idle', ruleId: 'live_prompt_box' })
  })

  test('claude transcript viewer holds the previous state', () => {
    const screen = [
      'lots of transcript',
      'Showing detailed transcript',
      '  ctrl+o to toggle',
    ].join('\n')
    expect(detectAgentScreenState('claude', screen, '')).toMatchObject({ state: 'hold' })
  })

  test('codex working footer reads as working', () => {
    const screen = [
      'doing things',
      '• Working (3m 12s · esc to interrupt)',
    ].join('\n')
    expect(detectAgentScreenState('codex', screen, '')).toMatchObject({ state: 'working', ruleId: 'screen_working_fallback' })
  })

  test('korean output does not falsely trip blockers', () => {
    const screen = [
      '한글 출력이 계속 이어집니다',
      '작업을 진행하고 있어요',
      '곧 완료됩니다',
    ].join('\n')
    expect(detectAgentScreenState('claude', screen, '')).toBeNull()
  })

  test('unknown agent kind detects nothing', () => {
    expect(detectAgentScreenState('omp', 'anything', '')).toBeNull()
  })
})
