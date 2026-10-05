# Response To Harness Core Proposal

Oct 5, 2026 · Jordan (via opencode review session)

Short answer: **yes.** The direction fits where the harness is going — 2.26.0 (shipped today) added an explicit SSOT contract for downstream apps to `AGENTS.md` ("Contract For Downstream Apps"), and this proposal is that contract working as intended. Answers to your open questions below.

## Answers To The Open Questions

### 1. Core Location

`packages/core` **in this repo**, under npm workspaces, exported as a `venice-video-harness/core` subpath — exactly your phase-2 shape. One repo, one version line, one review surface. A separate package gives core and the CLI two version lines and lets them drift, which is the failure mode the proposal exists to end.

### 2. Data Model

Yes — `series/types.ts` as the starting schema, and yes to all three additions:

- **`takes[]`** — accept. Retries, cost, and QA history per take are gaps in the CLI today.
- **Approval digest** — accept. Binding approval to the panel's bytes plus a settings digest closes a real swap-under-approval hole.
- **`ReferenceSet` as data** — accept, and it is the key unlock. `reference-slots.ts` currently probes the disk (`existsSync`, `readdirSync`), which makes `prompt-builder.ts` Node-only. Taking a `ReferenceSet` as data fixes that without changing CLI behavior: the CLI builds the set from disk with today's file rules.

All three are optional fields; the unchanged CLI keeps working while they land.

### 3. Rule 42 (Panel As Reference, Never Start Frame)

Hold rule 42 as the default. It came out of measured drift incidents (anti-pattern 20, the canopy-run failures), not preference. Your one A/B being inconclusive matches our expectation — the effect only shows up across enough shots. We would genuinely like the blind comparison harness you described: fixed references and panels, 3+ runs per arm, scored blind. If it says a lane should be panel-anchored, we change that lane with evidence attached. Until then, phase 4 keeps rule 42 as the default.

### 4. In-Flight Work To Stay Clear Of

Three open feature branches touch the same files your phases 3-4 rework (`video-generator.ts`, `models.ts`, the prompt path):

- `feat/minimax-multi-angle-camera-trajectory`
- `feat/wan3-reference-audio-lipsync`
- `stream-identity-lock-r2v`

Please hold phases 3 and 4 until those land or are explicitly merged/abandoned. Phase 2 (`packages/core`, pure modules only) can start now — it touches none of them.

### 5. PR Workflow

Small PRs against `main`, phase-gated, exactly as you proposed. We would rather read eight small PRs than two large ones. No long-lived split branch — it rots against main.

## On The Fixes Table

Send the to-harness fixes now, ahead of the split, each as its own small PR with its evidence. Two of them we verified against the code while reviewing this document:

- **5xx retry on `/video/queue`** — confirmed. `src/venice/client.ts` retries 429/5xx on every path, so a 5xx after Venice queued the job can bill twice. Real bug.
- **Poll loop ignores FAILED** — confirmed. The retrieve loop special-cases only `PROCESSING`; a FAILED status loops until the timeout instead of failing fast. Real bug.

The refusal-classification, `-basic` faces-off, validate-before-pay, and approval-digest fixes are equally welcome with their evidence attached.

## Notes On Scope

- Agreed: neither side's prompt design is in scope. Prompt/routing disagreements get settled by the comparison harness, not argument.
- Agreed: you do the extraction work; we review PRs sized for one sitting.
- One heads-up: today's 2.26.0 renamed the location reference plates to a compass set (`north`/`south`/`east`/`west`, all wide shots, one per wall — rule 61 in `AGENTS.md`). Your catalog note about "anchor-derived location angles" refers to the previous `wide` + `angle-2/3/4` names. Legacy names keep working, but build against the compass set.

## Next Step

Phase 1 is complete with this document. If the shape still looks right to you after these answers, open the phase-2 PR (`packages/core` with the pure modules + `capabilities.json` builder taking the version as an argument) whenever you are ready.
