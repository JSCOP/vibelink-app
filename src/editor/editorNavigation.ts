export type EditorNavigationTarget = {
  lineNumber: number
  column: number
}

type EditorNavigationHandler = (target: EditorNavigationTarget) => void

const handlers = new Map<string, EditorNavigationHandler>()
const pendingTargets = new Map<string, EditorNavigationTarget>()

export function requestEditorNavigation(sessionId: string, relPath: string, target: EditorNavigationTarget): void {
  const key = `${sessionId}\0${relPath}`
  const normalized = {
    lineNumber: Number.isFinite(target.lineNumber) ? Math.max(1, Math.trunc(target.lineNumber)) : 1,
    column: Number.isFinite(target.column) ? Math.max(1, Math.trunc(target.column)) : 1,
  }
  const handler = handlers.get(key)
  if (handler) {
    handler(normalized)
    return
  }
  pendingTargets.set(key, normalized)
}

export function registerEditorNavigation(
  sessionId: string,
  relPath: string,
  handler: EditorNavigationHandler,
): () => void {
  const key = `${sessionId}\0${relPath}`
  handlers.set(key, handler)
  const pending = pendingTargets.get(key)
  if (pending) {
    pendingTargets.delete(key)
    handler(pending)
  }
  return () => {
    if (handlers.get(key) === handler) handlers.delete(key)
  }
}
