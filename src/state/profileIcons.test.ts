import { describe, expect, it } from 'vitest'
import { workspaceContentDescriptors } from '../layout/workspaceLayoutModel'
import { defaultProfileIconName, profileIcons } from './profileIcons'

describe('workspace content descriptor icons', () => {
  it('resolves every built-in descriptor without falling back to the terminal icon', () => {
    for (const descriptor of Object.values(workspaceContentDescriptors)) {
      expect(profileIcons[descriptor.icon], `${descriptor.kind}:${descriptor.icon}`).toBeDefined()
      if (descriptor.kind !== 'terminal') expect(descriptor.icon).not.toBe(defaultProfileIconName)
    }
  })
})
