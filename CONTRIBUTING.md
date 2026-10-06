# Contributing

Bug fixes, model integrations and routing changes land here first (the upstream-first rule in [`AGENTS.md`](AGENTS.md#contract-for-downstream-apps-ssot)). If you are an agent, read `AGENTS.md` before changing anything: its rules and the anti-patterns log are why the code looks the way it does.

## Setup

```bash
npm install
npm test            # builds, then runs tests/*.test.mjs
npm run test:legacy # the older tests/test-*.mjs scripts
```

Node 20 or 22, and ffmpeg on `PATH`. Without ffmpeg, the video-QA and audit-gate tests skip instead of running.

Run the tests with no key and an empty config directory, the way CI does, so nothing can pick up your stored key:

```bash
export VENICE_VIDEO_CONFIG_DIR="$(mktemp -d)" VENICE_API_KEY=
export NODE_OPTIONS="--import $PWD/tests/support/no-venice-network.mjs"
npm test && npm run test:legacy
```

An empty `VENICE_API_KEY` alone is not enough: the user config loader treats it as unset and loads the real key.

## What CI checks

Every PR runs these. A PR merges once they pass and a maintainer approves.

| Check | Fails when | Fix |
|---|---|---|
| `test (node 20)`, `test (node 22)`, `test (node 22, macos)` | a test fails, or any process sends a request to a Venice host | Stub `globalThis.fetch` or pass a fake client (see `tests/audio-queue.test.mjs`) |
| `capabilities.json matches the registry` (inside each test job) | the registry changed but the manifest wasn't regenerated | `npm run manifest` and commit `capabilities.json` |
| `web UI build` | `src/web/ui` doesn't typecheck or build | `npm --prefix src/web/ui run typecheck` |
| `changelog` | `src/` or `packages/*/src/` changed without a `CHANGELOG.md` entry | Add one under `## Unreleased`; a maintainer can apply `no-changelog` for changes that don't need one |

When `main` moves and your PR starts conflicting, a bot adds the `needs rebase` label and comments. Rebase and push; the label clears on its own. If `capabilities.json` conflicts, take `main`'s version and run `npm run manifest`.

## Conventions

- **One change per PR.** Several small PRs review faster than one large one, and they can merge in any order.
- **Tests never reach the Venice API.** Venice bills video and audio jobs at queue time. CI enforces this; the preload above enforces it locally.
- **A CHANGELOG entry under `## Unreleased`**, in the `Fixed`, `Changed` or `Added` section: what changed, why, and the test that covers it. No version bump; releases are cut separately.
- **Registry changes regenerate the manifest.** Anything in `packages/core/src/venice/models.ts` or the capability sets is followed by `npm run manifest`.
- **`packages/core` stays pure.** No Node builtins, npm packages, `process.env`, `Buffer` or `import.meta.url`; `tests/core-purity.test.mjs` fails otherwise.
- **No secrets, renders or project output in commits.** Use `PASTE_YOUR_VENICE_API_KEY_HERE` in examples.

## Paid probes

Some behaviour can only be confirmed with a real render (a model's limits, a refusal shape). That's fine, and it's often what makes a PR convincing. Run it outside the test suite, then say in the PR body what you ran, what came back, and roughly what it cost. Encode the finding as a test against a stub, so CI keeps checking it for free.

## Model drift

A weekly job compares the registry with the public `GET /models` list and keeps the result in one issue labelled `model-drift`. Items from that issue make good first PRs. Not every line is a bug: some ids work without being listed.
