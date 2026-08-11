export const setupStepIds = ['welcome', 'account', 'appearance', 'finish'] as const
export type SetupStepId = typeof setupStepIds[number]

export function isSetupStepId(value: string): value is SetupStepId {
  return setupStepIds.includes(value as SetupStepId)
}

export function setupStepAutoPass(): Partial<Record<SetupStepId, boolean>> {
  return {}
}

export function setupStepTitle(step: SetupStepId): string {
  return ({
    welcome: 'Welcome',
    account: 'Account',
    appearance: 'Appearance',
    finish: 'Finish',
  } satisfies Record<SetupStepId, string>)[step]
}
