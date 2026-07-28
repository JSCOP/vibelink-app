export type AutomationNavigationRequest = {
  sessionId: string
  automationId: string
  runId: string | null
}

type Listener = () => void

let current: AutomationNavigationRequest | null = null
const listeners = new Set<Listener>()

export function requestAutomationNavigation(request: AutomationNavigationRequest): void {
  current = request
  listeners.forEach((listener) => listener())
}

export function subscribeAutomationNavigation(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAutomationNavigationRequest(): AutomationNavigationRequest | null {
  return current
}

export function clearAutomationNavigation(request: AutomationNavigationRequest): void {
  if (current !== request) return
  current = null
  listeners.forEach((listener) => listener())
}
