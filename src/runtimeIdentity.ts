export type RuntimeIdentity = {
  kind: 'development' | 'release'
  protected: boolean
  browserTitle: string
  badgeLabel: string
  badgeDetail: string
  description: string
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
        badgeLabel: 'DEV BUILD',
        badgeDetail: 'TEST TARGET',
        description: 'Development build. Use this window to verify current source changes.',
      }
    : {
        kind: 'release',
        protected: true,
        browserTitle: 'VibeLink',
        badgeLabel: 'RELEASE HOST',
        badgeDetail: 'PROTECTED',
        description: 'Protected release host. Do not use this window to verify development changes or close it during self-hosted development.',
      }
}

export const appRuntimeIdentity = runtimeIdentityFor(
  isDevelopmentRuntime(import.meta.env.VITE_VIBELINK_APP_FLAVOR, import.meta.env.DEV),
)
