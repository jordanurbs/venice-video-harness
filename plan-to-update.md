# Harness Core Proposal

Oct 5, 2026 · @Beard

Proposal: split venice-video-harness into a pure `core` package and the CLI that consumes it, so a browser app can run the same production loop and send improvements back as PRs. We would do the extraction work; we are asking whether it fits your direction before starting.

## Where we are

Our browser app runs the harness pipeline, but as a rewrite twice removed: harness (Node CLI) → a Mac Swift port → a TypeScript port of the Swift. No harness code was ever imported; the rules were re-implemented each time, and our comments still cite them by number ("harness rule 42"). We compared the two codebases on 2026-10-05 against harness 2.25.0.

| Area | Finding |
| --- | --- |
| Catalog | Our `capabilities.json` is a hand copy of the 2.18.0 manifest (109 video models). Harness 2.25.0 has 121, with the Seedance 2.0 ladder to 4K and 2.5 to 1080p. Ours also carries two additions the harness never had (`supportsCameraTrajectory`, `minimax-h3-max-multi-angle`). |
| Packaging | `exports` exposes only `.`, and that entry imports `fs`, `process.env`, `Buffer` and `async_hooks`. 21 of 100 harness modules are browser-safe as they stand (`venice/models.ts`, `venice/types.ts`, `series/types.ts`, `storyboard/*`, `agent/*`). |
| Prompt core | `mini-drama/reference-slots.ts` finds references by probing the disk (`front.png`, `anchor.png`, `readdirSync` on location angles), and `prompt-builder.ts` imports it, so the prompt builder cannot run outside Node. |
| Routing | Harness rule 42: the panel is a reference, never a start frame. Our shipped code renders image-to-video from the approved panel. One live A/B (3 shots, same references) did not settle which is better. |
| Failure handling | We are ahead: validation before the paid call, refusal classification, one retry only when credits were refunded, output validation. The harness `client.post` retries 429/5xx on every path, including `/video/queue`, so a 5xx after Venice queued the job can bill twice. |
| Newer harness work we lack | `bitrate_mode: high` on Seedance 2.5, multi-voice `reference_audio_urls`, the MiniMax `i2vRejectsFaceStartFrame` guard, montage-first generation, post-render identity checks, anchor-derived location angles. |

Both sides have moved ahead of the other, and neither can take the other's changes without a rewrite. That is the problem this proposal addresses.

## The shape

&#91;embedded content: core, its ports, and the two hosts\]

Both hosts run the same loop. Core never imports `fs`, `sharp`, ffmpeg or `fetch`; it declares the ports and the host supplies them. This is the pattern Prettier, Excalidraw, Remotion and Lighthouse use to run one engine in a CLI and a browser.

## What moves into core

Core is plain data in, plain data out. It never touches the filesystem, ffmpeg, `sharp`, `process.env` or the network. Anything that must touch the world goes through an interface core declares, and each host implements it its own way.

| Into `core` | Stays in the CLI |
| --- | --- |
| `venice/models.ts`, `venice/types.ts`, `venice/text-models.ts`, `capabilities.json` and its builder (version passed in, not read from `package.json`) | `venice/client.ts` transport (or a `fetch`-only variant in core with `Uint8Array` instead of `Buffer`) |
| `series/types.ts`: the schema, which becomes core's data model | File layout: `characters/<slug>/front.png`, `series.json`, episode folders |
| `mini-drama/prompt-builder.ts` and `reference-slots.ts`, taking the available references as data instead of probing disk | `sharp`, ffmpeg and ffprobe calls: frame extraction, luma scans, image dimensions, PNG repair |
| `generation-planner.ts`, `montage.ts` planning half, `music-cues.ts` planning half: the pure functions already there | Rendering, cutting and file writes from those same modules |
| QA rubrics and verdict parsing from `video-qa.ts` and the storyboard QA command; request building from `video.ts`; refusal classification | Running the vision model, reading frames, writing `qa-report.json` |
| The orchestration state machine: stages, gates, retry policy, what counts as approved (today spread across `cli.ts`, `video-generator.ts`, `session/status.ts`, `agent/pipeline.ts`) | `commander` commands that call into it |

Ports core declares (names are suggestions):

- `ReferenceStore`: which images exist for a character, location or panel, and their bytes or URLs.
- `ImageProbe`: dimensions, decodability, frame extraction from a clip.
- `VisionJudge`: send frames plus a rubric, get a verdict.
- `VideoBackend`: quote, queue, poll, download, with the request body built by core.
- `Clock` and `Logger`.

The CLI implements these with `fs`, `sharp` and ffmpeg. The web app implements them with OPFS, canvas and WebCodecs. Both run the same loop.

## The data model

Core owns one schema, and it starts from the harness's `series/types.ts`. Our app is an unreleased beta, so we adapt to the harness model rather than asking for a merged one. The harness's series files and our project files both become persistence adapters over core's types.

Where the two differ today, and what we would do:

| Concept | Harness | Ours today | Proposal |
| --- | --- | --- | --- |
| Keys | Characters and locations matched by name | Stable ids | Adopt names as the public key; keep an id only if the harness wants one for renames |
| Locations per shot | One slug | Several | Adopt one, with a second location as a reference image when a shot needs it |
| Dialogue | One line per shot, NARRATOR and V.O. by name | An array with a `voiceOver` flag | Adopt the harness shape; propose an array only if the harness wants multi-line shots |
| Style | `AestheticProfile`, five fields | One `styleBlock` string | Adopt the profile |
| Shot duration | `"5s"` string | `durationSeconds` number | Adopt the string; core exposes `parseShotDuration` already |
| Transition, camera | Free text | Enums and a trajectory object | Adopt free text, keep our validation as a core helper |
| Panel approval | `qa-report.json` on disk | Approval bound to the panel's bytes plus a settings digest | Propose the digest binding to core: it stops an approved panel being swapped under a shot |
| Takes | Rendered files per shot | A `takes[]` array with QA score, issues, cost and recipe | Propose `takes[]` to core: retries, costs and QA history need it |
| Reference views | `front.png`, `anchor.png`, angle files by name | Locked reference plus angle asset ids | Core takes a `ReferenceSet` as data; file names stay a CLI concern |

The rows marked "adopt" cost us a migration and nothing on the harness side. The three marked "propose" are additions we think the harness benefits from; they are optional fields, so an unchanged CLI keeps working.

## Phases

Every phase is additive, lands as its own PR, and keeps `npm test` and `test:legacy` green. The CLI's behaviour does not change until phase 4, and then only where a live comparison says the change is better.

1. **Agree the shape.** This document, your edits, and a decision on the open questions below. Gate: you say go.
2. **`core` as a workspace package, pure modules only.** Move the already-pure modules (`models`, `types`, `text-models`, `series/types`, `agent/*`) plus `capabilities.json` into `packages/core`, export them from a `venice-video-harness/core` subpath, pass the version into the manifest builder. The CLI imports from core; nothing else changes. Gate: tests green, `npm pack` ships both.
3. **Split IO out of the planning modules.** `generation-planner`, `montage`, `music-cues`, `video-qa` rubrics, `video.ts` request building: pure half to core, IO half stays. `reference-slots` and `prompt-builder` take a `ReferenceSet` as data; the CLI builds it from disk with the same file rules as today. Gate: the existing reference-slot and prompt tests pass unchanged against the new entry points.
4. **The loop in core.** Stages, gates, retry policy and approval rules as one state machine over the ports. The CLI commands become thin callers. Our fixes from the table below land here as they are accepted, each with its evidence. Gate: the CLI's end-to-end tests and one live episode render identically before and after.
5. **The web app consumes core.** We migrate our project format to core's schema, implement the ports over the browser APIs, and delete our copies of the prompt, routing and QA code. Gate: our live comparison suite renders the same fixtures through core with no regression.

We would do phases 2 to 5. Phase 2 is small and proves the packaging. Phases 3 and 4 are the real work and each is reviewable in pieces.

## Fixes worth sending now

These do not depend on the split. Each would be a small PR with its evidence attached.

| Direction | Change | Evidence |
| --- | --- | --- |
| To harness | Do not retry `POST /video/queue` on 5xx; a job may already be queued and billed | `client.post` retry loop; our runner never retries the queue call |
| To harness | Treat `-basic` Seedance ids as faces-off twins and block them on shots with people before submit | 31 of 32 takes with a character reference failed on a `-basic` id in one project; face-capable ids were refused about 6% of the time |
| To harness | Classify refusals: `provider_content_policy` with `credits_refunded` retries once, a `/video/queue` 422 on a face-capable id with images is a face-screening refusal (an image problem, not the prompt) | Live tests, 2026-10-01: the same image was refused 5 times, the prompt wording never mattered |
| To harness | Fail fast when a poll reports FAILED instead of looping to the deadline | Harness polls ignore the status |
| To harness | Validate duration and resolution before the paid call instead of silently snapping | Our validator with a "try Xs" hint |
| To harness | Bind panel approval to the panel's bytes plus a settings digest | Stops an approved panel being replaced under a shot |
| To web app | Send `bitrate_mode: high` on Seedance 2.5 | Harness 2.18 |
| To web app | Guard MiniMax image-to-video on a face start frame (`i2vRejectsFaceStartFrame`) | Harness 2.20: bills, then never completes |
| To web app | Size thresholds by resolution for silent-reject detection | Harness `rejection.ts`; our flat threshold under-catches at 2K and 4K |
| To web app | The 409 `needs_consent` handshake and `/video/complete` cleanup | Harness `video-generator.ts`, `video.ts` |
| To web app | Refresh the catalog to 2.25.0 (13 models, the resolution ladders) | Automatic once phase 2 lands |

Not on this list: either side's prompt design. Our one A/B of panel-as-start-frame against reference-only was inconclusive, and we would want three or more runs per arm before proposing or dropping any prompt behaviour. We can run those and share the clips and scores.

## What we contribute, and what we ask

We contribute the engineering. We have already built a browser-safe version of this loop once (`packages/production` in our app: no DOM, all IO through a ports file, the orchestrator and QA on top of plain data), so the extraction is a known shape to us, not a first attempt. We would also contribute a live comparison harness: fixed references and panels rendered through two code versions, scored blind, with side-by-side clips. That is how we would settle any prompt or routing disagreement, rather than by argument.

What we ask from you:

- A yes or no on the direction, and edits to anything above that does not fit how you want the harness to grow.
- Review time on PRs sized to be read in one sitting. We would rather send eight small ones than two large ones.
- The data-model decisions in the table above where we wrote "propose": optional fields, but they shape phase 4.

We are not asking for commit access, and we are not asking you to change the CLI's behaviour. If the split is not something you want in this repo, we would still send the fixes in the table above.

## Open questions for you

- [ ] Is a `core` + CLI split in this repo something you want, or would you rather core be its own package that the CLI depends on?
- [ ] Does `series/types.ts` as the starting schema fit, with the three optional additions (`takes[]`, approval digest, a `ReferenceSet` passed as data)?
- [ ] Rule 42 (panel as reference only, never a start frame) versus panel as first frame: do you have measured results either way? We have one inconclusive run and can produce more.
- [ ] Anything in flight on your side (montage, stream, loop modes) that the split should stay clear of until it lands?
- [ ] How do you want PRs: against `main`, or a long-lived branch for the split?
