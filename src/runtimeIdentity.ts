export type RuntimeIdentity = {
  kind: 'development' | 'release'
  protected: boolean
  browserTitle: string
  badge: {
    label: string
    detail: string
    description: string
  } | null
}
export function isDevelopmentRuntime(
  configuredFlavor: string | undefined,
  viteDevelopment: boolean,
): boolean {
  if (configuredFlavor === 'dev') return true
  if (configuredFlavor === 'prod') return false
  return viteDevelopment
}


export function runtimeIdentityFor(development: boolean): RuntimeIdentity {
  return development
    ? {
        kind: 'development',
        protected: false,
        browserTitle: 'VibeLink Dev',
        badge: {
          label: 'DEV BUILD',
          detail: 'TEST TARGET',
          description: 'Development build. Use this window to verify current source changes.',
        },
      }
    : {
        kind: 'release',
        protected: true,
        browserTitle: 'VibeLink',
        badge: null,
      }
}

export const appRuntimeIdentity = runtimeIdentityFor(
  isDevelopmentRuntime(import.meta.env.VITE_VIBELINK_APP_FLAVOR, import.meta.env.DEV),
)
