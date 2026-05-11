# venice-video-harness — EXT roadmap implementation notes

Companion to `HARNESS_HANDOFF.md`. Captures what landed, what was deferred, and the cross-PR dependency graph.

This document is checked in so a future maintainer (or a future Claude session) can resume work without re-reading every PR.

---

## PR map (all open as of 2026-05-11)

| # | EXT | Branch | Targets | Status |
|---|-----|--------|---------|--------|
| 1 | — | `feat/baseline-models-kling-o3-4k-happyhorse` | `main` | Open. Pre-roadmap baseline: Kling O3 4K + HappyHorse 1.0 model families pulled out of the working tree. |
| 2 | EXT-2 | `feat/silent-rejection-guard` | `main` | Open. `VeniceRejectionError`, 30KB image / 100KB video thresholds, wired into `generateImage` / `generateWithReferences` / `pollVideoResult`. |
| 3 | EXT-1 + EXT-10 | `feat/wan-2-7-lipsync` | `main` | Open. Wan 2.7 family in the registry; `audio-preflight.ts` with `WanAudioTooShortError` + ffmpeg `apad` trailing-silence pad. CLAUDE.md routing table updated. |
| 4 | EXT-3 | `feat/prompt-builder-cap` | `main` | Open. Per-model `MAX_POSITIVE_PROMPT_CHARS`. `buildCharacterReferencePromptParts()` splits positive / negative additions. |
| 5 | EXT-7 + EXT-9 + EXT-11 | `feat/motion-classified-routing` | `feat/wan-2-7-lipsync` | Open. **Re-target to `main` after #3 merges.** `ShotScript.motion` + `faceVisible`; `mustStayAsWanLipSync()` breaks bundles; auto end-frame for lip-sync shots. |
| 6 | EXT-4 + EXT-12 | `feat/music-cues` | `main` | Open. `MusicCueSpec` + `music-cues.ts` module with crossfade + `musicHold` automation. Assembler accepts cues + placementMap + shots. |
| 7 | EXT-5 + EXT-6 | `feat/audio-mix-defaults` | `feat/music-cues` | Open. **Re-target to `main` after #6 merges.** `audio-mix.ts` with `trimAndFadeSfx` + `loudnessNormalize`. Assembler runs a final -16 LUFS pass. |
| 8 | EXT-8 | `feat/shot-anchored-audio` | `main` | Open. `shot-paths.ts` with `shotKey` / `dialogueFileForShot` / `placeNarrationCues` / `findCollidingNarrationStarts`. Assembler warns on every fall-through. `tests/test-shot-paths.mjs` passes. |
| 9 | EXT-13 | `feat/insert-shot-cli` | `main` | Open. `ShotScript.shotIdSuffix` + `insert-shot` command. Scaffold form — script edit + archive + next-steps; panel / video / re-assembly use existing commands. |
| 10 | EXT-14 | `feat/fcpxml-export` | `main` | Open. `fcpxml-export.ts` module + `export-fcpxml` CLI. Captures the FCPXML 1.10 gotchas inline (media-rep child, connected children of primary, parent-local offset, audioRate/Channels probe). |

---

## Suggested merge order

The handoff doc proposed this order; the PRs were built in the same shape:

1. PR #1 (baseline)
2. PR #2 (silent-reject guard — defensive, no API surface change)
3. PR #3 (Wan 2.7) — large surface; review the model-registry additions carefully
4. PR #5 (motion routing) — depends on #3; re-target to `main` after #3 merges
5. PR #4 (prompt-builder cap)
6. PR #6 (music cues)
7. PR #7 (audio mix defaults) — depends on #6; re-target to `main` after #6 merges
8. PR #8 (shot-anchored audio)
9. PR #9 (insert-shot CLI)
10. PR #10 (FCPXML)

Each PR is **independently mergeable** at the file level — the dependency on #3 / #6 from #5 / #7 is that those PRs *reference types* added by the parent. Once parents merge to `main`, the dependents can be re-targeted to `main` via the GitHub UI without rebasing.

---

## Deferred / partial

Captured here so the next session knows what's left:

### EXT-13: insert-shot is scaffold-only
The CLI command only does the **script-editing** half (archive previous script, splice in the new shot record with a suffix letter, save). Panel + video + re-assembly are left to the existing commands (`storyboard-episode`, `generate-videos`, `assemble-episode`). A fuller `insert-shot` would orchestrate the full sub-pipeline for the single inserted shot — would touch `panel-fixer`, `video-generator`, and the assembler's placement-map re-derivation. Tracked as a follow-up.

### EXT-12 musicHold automation is generic
The `buildMusicHoldExpr` produces an ffmpeg `volume=` expression with stinger / swell / drop automation. It's tested via the build but no live cue has driven it through a real assembly yet. Production-level fine-tuning of the +6 dB stinger, +4 dB swell, and -60 dB drop levels may need adjustment after listening.

### Test coverage
There's no test framework configured. EXT-8 has a smoke test at `tests/test-shot-paths.mjs` (12 assertions, all pass). Other modules are verified only by `npm run build`. A future PR could land vitest + a handful of unit tests for the most-fragile modules (`audio-preflight`, `music-cues`, `fcpxml-export`).

### Sync from upstream
The `last-synced` comment at the top of `src/venice/models.ts` is still `2026-03-18`. The Wan 2.7 entries were added by hand using live-API probing — the next full registry sync should keep them.

---

## Cross-cutting notes

### Branch and PR strategy
Direct pushes to `main` are blocked. The chain of branches off `main` works because PRs are independently mergeable; the two cases where one PR depends on another (#5 → #3, #7 → #6) use the GitHub `--base` flag to target the parent branch. Once the parent merges to `main`, re-target via UI.

### Convention: zero-padded shot ids
EXT-8 makes `shotKey()` the canonical normalization. New code must use `dialogueFileForShot` / `panelFileForShot` / `videoFileForShot` from `src/mini-drama/shot-paths.ts` instead of ad-hoc template literals. The Glass v4 silent-failure bug was the motivation; the smoke test catches the pattern.

### ffmpeg / ffprobe assumed on PATH
EXT-1, EXT-4, EXT-5, EXT-6, EXT-14 all shell out to `ffmpeg` / `ffprobe`. `audio-preflight.ts` / `audio-mix.ts` / `music-cues.ts` / `fcpxml-export.ts` use `execFile` via `node:child_process`. Failures fall back gracefully where possible (EXT-6's loudnorm restores the un-normalized master on filter failure).

### Wan 2.7 production caveats live in the model registry
The Wan 2.7 model entries in `src/venice/models.ts` have inline comments capturing the live-API gotchas (aspect_ratio rejected on i2v, audio_url < 3s rejected with a generic error from i2v but a clear one from t2v, R2V uses per_reference_audio not audio_url). These notes should follow any future registry sync.
