// Preload that makes any request to a Venice host fail the process. CI loads
// it into every Node process (tests and the CLIs they spawn) through
// NODE_OPTIONS; locally:
//
//   NODE_OPTIONS="--import $PWD/tests/support/no-venice-network.mjs" npm test
//
// Venice bills video and audio jobs at queue time, so a test that reaches the
// real API can cost money even with a bad key. Tests that need the client
// stub `globalThis.fetch` themselves; restoring the original puts this guard
// back. The throw alone is not enough, since retry and error-handling code can
// swallow it, so the process also exits non-zero.

const VENICE_HOST = /(^|\.)venice\.ai$/i;
const attempts = [];
const realFetch = globalThis.fetch;

function hostOf(input) {
  try {
    const url = typeof input === 'string' || input instanceof URL ? new URL(String(input)) : new URL(input.url);
    return { host: url.hostname, path: url.pathname };
  } catch {
    return undefined;
  }
}

globalThis.fetch = async function guardedFetch(input, init) {
  const target = hostOf(input);
  if (target && VENICE_HOST.test(target.host)) {
    attempts.push(`${init?.method ?? 'GET'} ${target.host}${target.path}`);
    throw new Error(`Tests must not reach the Venice API (${target.host}${target.path}). Stub globalThis.fetch or pass a fake client.`);
  }
  return realFetch(input, init);
};

process.on('exit', () => {
  if (attempts.length === 0) return;
  process.stderr.write(
    `\nno-venice-network: ${attempts.length} request(s) to the Venice API were blocked:\n`
    + attempts.map(a => `  ${a}\n`).join(''),
  );
  process.exitCode = 1;
});
