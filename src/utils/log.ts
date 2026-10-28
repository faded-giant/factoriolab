/**
 * Analytics hook. Upstream sends these events to Google Analytics; this fork
 * keeps the call sites but sends nothing anywhere.
 */
export function log(_event: string, _value?: string): void {
  // Intentionally empty
}
