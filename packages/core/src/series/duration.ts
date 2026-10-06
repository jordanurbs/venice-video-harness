// ---------------------------------------------------------------------------
// Shot duration strings.
//
// `ShotScript.duration` and `GenerationUnit.duration` are the same `"5s"`
// strings the Venice registry ladders use (`VideoModelSpec.durations`), so one
// pair of helpers converts them. They lived in `mini-drama/generation-planner`
// (Node-only); a browser host that holds the schema needs them too.
// ---------------------------------------------------------------------------

/**
 * Seconds from a shot duration string: `"5s"` -> 5. Anything that is not a
 * whole number of seconds with the `s` suffix reads as the 5-second default,
 * the same fallback the planner has always applied.
 */
export function parseShotDuration(duration: string): number {
  const match = duration.match(/^(\d+)s$/);
  return match ? parseInt(match[1], 10) : 5;
}

/**
 * The inverse: seconds -> `"5s"`, rounded to a whole second and never below
 * 1 (no registry ladder goes lower).
 */
export function formatShotDuration(seconds: number): string {
  return `${Math.max(1, Math.round(seconds))}s`;
}
