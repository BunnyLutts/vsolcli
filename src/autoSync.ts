// Pure scheduling helpers for the periodic background sync. Kept free of
// `vscode` so the rules can be unit tested without an extension host.

export const MAX_PERIODIC_BACKOFF_FACTOR = 8;
export const MAX_PERIODIC_DELAY_MS = 15 * 60 * 1000;

/**
 * Delay before the next background sync.
 *
 * Starts at the configured interval and doubles for each consecutive failure so
 * an unreachable server or an expired session does not get hammered every
 * interval, capped at {@link MAX_PERIODIC_DELAY_MS}.
 */
export function periodicDelayMs(intervalMs: number, failures: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  const exponent = Math.max(0, Math.min(Math.floor(failures), 8));
  const factor = Math.min(2 ** exponent, MAX_PERIODIC_BACKOFF_FACTOR);
  return Math.min(intervalMs * factor, MAX_PERIODIC_DELAY_MS);
}
