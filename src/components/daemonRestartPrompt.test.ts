import { describe, expect, it } from 'vitest'
import { daemonRestartMessage } from './daemonRestartPrompt'

describe('daemonRestartMessage', () => {
  it('names both builds when the running daemon reported a version', () => {
    const message = daemonRestartMessage({ fromVersion: '0.6.6', toVersion: '0.6.8' })
    expect(message).toContain('0.6.6')
    expect(message).toContain('0.6.8')
  })

  it('does not invent a version for a daemon that predates the identity field', () => {
    const message = daemonRestartMessage({ fromVersion: null, toVersion: '0.6.8' })
    expect(message).toContain('an earlier build')
    expect(message).not.toContain('null')
  })

  it('states the cost of restarting and the cost of waiting', () => {
    const message = daemonRestartMessage({ fromVersion: '0.6.6', toVersion: '0.6.8' })
    // The whole point of asking is that the user can weigh these against each other.
    expect(message).toContain('stops every command')
    expect(message).toContain('keeps them running')
  })
})
