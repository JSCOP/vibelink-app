import { describe, expect, test } from 'vitest'

import { daemonErrorMessage } from './daemonErrors'

describe('daemonErrorMessage', () => {
  test('maps local daemon authentication and protocol errors', () => {
    expect(daemonErrorMessage('AUTH_REQUIRED')).toContain('background service')
    expect(daemonErrorMessage('DAEMON_PROTOCOL_MISMATCH')).toContain('different versions')
    expect(daemonErrorMessage('other failure')).toBe('other failure')
  })
})
