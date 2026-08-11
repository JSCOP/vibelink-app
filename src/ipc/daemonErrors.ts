/**
 * Local daemon IPC failures surface as opaque codes. Keep this a leaf module:
 * `store.ts` needs it, and importing it from `output.ts` would pull the whole
 * terminal renderer into every store consumer.
 */
export function daemonErrorMessage(error: unknown): string {
  const text = String(error)
  if (text.includes('AUTH_REQUIRED')) return 'VibeLink could not authenticate the local background service.'
  if (text.includes('DAEMON_PROTOCOL_MISMATCH')) return 'VibeLink and its background service are different versions. Restart VibeLink.'
  return text
}
