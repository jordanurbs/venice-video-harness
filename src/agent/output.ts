// ---------------------------------------------------------------------------
// Machine-readable output for agent runners.
//
// Any coding agent driving this CLI (Hermes, OpenClaw, Cursor, Claude Code, …)
// reads stdout as text. Prose is fine for a human at a terminal but forces an
// agent to scrape, and the scrape breaks the moment wording changes. These
// helpers let a command emit one clean JSON object on stdout when `--json` is
// asked for, and keep the human rendering byte-for-byte identical otherwise.
//
// Two contracts an agent can rely on, checked by tests:
//   - `--json` prints exactly one JSON object to stdout and nothing else.
//   - a command that failed exits non-zero (see `failJson` / the CLI's
//     top-level catch). Success on stderr-only output is a bug, not a feature.
// ---------------------------------------------------------------------------

/** True when the caller asked for JSON, from either the global or local flag. */
export function jsonRequested(globalJson: unknown, localJson?: unknown): boolean {
  return Boolean(globalJson) || Boolean(localJson);
}

/** Print one JSON object to stdout, pretty-printed so a human can read it too. */
export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Report a recoverable error the way an agent can consume it: a JSON envelope
 * on stdout when `--json`, a clean `error:` line on stderr otherwise, and a
 * non-zero exit either way. Never throws, so callers can `return` right after.
 */
export function failJson(
  json: boolean,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (json) {
    emitJson({ ok: false, error: message, ...extra });
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}
