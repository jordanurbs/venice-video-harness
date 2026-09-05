# Changelog

## 2.22.0 — 2026-09-05

### Added

- **Stream model selectors.** The Stream tab has two dropdowns: the writer
  (which model authors each beat) and the video model family (which t2v/i2v
  pair renders it), each with speed and cost in the label and a plain verdict
  beside it ("keeps up" / "falls behind" / "much slower"). A change applies to
  the next beat; the beat in flight finishes on the models it started with.
  `POST /api/projects/:slug/stream/config`, `StreamEngine.configure()`,
  `--video-family` on the CLI, and `choices` in the manifest. The i2v chain
  survives a family switch. A resumed stream keeps the models in its manifest.
- **Stream writer bakeoff** (`scripts/bakeoff-stream-writer.ts`): times each
  candidate on the real stream prompt against a real project and checks the
  beat parses. Results are in `src/mini-drama/stream-choices.ts` and the README.
- `VeniceClient.chatJson` takes `disableThinking`, which sends
  `venice_parameters.disable_thinking`. The stream writer sets it per choice.

### Changed

- **Default stream writer is `deepseek-v4-flash-0731-fast`** (3.8 s median,
  9/9 valid beats, private), not the project's intelligence model. Kimi K3
  took 35 s per beat with thinking on and ~10 s without, dropping 1 in 9. With
  Turbo's ~30 s render, the fast writer brings a beat to ~35 s wall time for
  15 s of video. `--writer default` means this model now.
- **Per-beat cost is quote-derived.** Turbo at 480P is $0.11 per 15 s
  (`POST /video/quote`), not the $0.18 the old `TURBO_USD_PER_SEC` constant
  assumed. Budgets buy more beats than before.
- `--resolution` on `stream` defaults to the family's draft tier instead of a
  hardcoded `480P`; values are validated against the family.

## 2.21.1 — 2026-09-05

### Fixed

- **Stream tab showed no Start button on a fresh project.** `stream` needs only
  `series.json`, but the browser builds its episode list from
  `series.episodes`, and `stream` never registered its episode. The view fell
  through to "No episodes yet." with the engine attached and beat 1 billed.
  `stream` now registers the episode in `series.json` before anything bills,
  and the view renders with a synthetic episode if the list is still empty.
- **New beats appeared only after a page reload.** Every beat's files fire the
  workspace watcher, which pushes `state-changed`; `App` re-fetches the project
  state, and `StreamView` REPLACED its stream with the on-disk manifest — which
  can lag the `stream-updated` SSE that already delivered the beat. The view
  now merges by beat number (SSE is the truth, disk is a fallback), fetches the
  full state if an event arrives before the initial load, and kicks `play()`
  after each `<video>` source swap.
- **A face-ending beat stalled the whole stream.** MiniMax i2v dies
  server-side on a face-filled start frame after billing (anti-pattern 31); the
  chain made that one frame poison every retry, and the engine stopped after
  three. Now: the writer's system prompt carries a MANDATORY camera rule (end
  every beat wide, never on a human face close-up); and after
  `STREAM_CHAIN_FAILURES_BEFORE_RESET` (2) chained failures on one beat the
  engine renders that beat t2v as a soft reset (`lane: "t2v-reset"`) with the
  previous beat's summary prepended. The Stream tab shows the retry error and
  marks reset beats.
- `renderVideoFile` no longer warns "No start image available" on
  text-to-video models, where no start image is expected.

### Changed

- **The stream writer is an explicit decision.** A new stream asks which model
  writes the beats in a terminal; a non-interactive new stream with no
  `--writer` is a hard error (pass `--writer <model>` or `--writer default`),
  mirroring `loop --mode`. A resumed stream keeps the project default. The
  writer and the per-beat cost print before beat 1 bills. AGENTS.md rule 60
  (g)-(i) records the operating rules.

### Known gap (feature request)

- **No path for the driving agent to author beats.** An operator running the
  agent on a model outside the Venice text registry (e.g. Claude Fable 5.1)
  cannot make that agent the writer. `AuthorFn` is injectable in code only.
  Proposed: `--writer external`, where the engine writes
  `stream/next-beat-request.json` and waits; `venice-video stream-beat -p <dir>
  -e <n> --file beat.json` (or `POST /api/projects/:slug/stream/beat`) accepts
  an `AuthoredBeat`, runs `normalizeBeat`, and renders it. Same shape for
  pinning beat 1 from the CLI.

## 2.21.0 — 2026-09-04

### Added

- **`venice-video stream` — an infinite, live-authored story.** Not a loop. The
  intelligence model writes one beat at a time from the series bible plus a
  rolling `story-so-far.md`; beat 1 renders t2v on MiniMax H3 Max Turbo, every
  later beat renders i2v off the previous beat's last frame. Nothing repeats,
  nothing re-renders, no re-anchoring, no ring buffer: every beat stays on disk
  in order under `episodes/episode-NNN/stream/`. Needs only a project; no
  script, storyboard, or references. Resumable; stops after 3 consecutive
  failures rather than skip a beat. `--direction` folds standing direction into
  every writer prompt. New `src/mini-drama/stream-engine.ts`, `/api/projects/
  :slug/stream/*` endpoints, `stream-updated` SSE event, and a **Stream** tab.

## 2.20.1 — 2026-09-04

### Fixed

- **Loop regeneration re-rendered shot 1 forever once the ring buffer filled (#26).**
  `LoopEngine.pickNext()` sorted eligible shots by `takes.length` ("fewest takes
  first"), but `takes` is a ring buffer capped at `--max-takes`. After the first
  full pass every shot tied on `takes.length === maxTakes`, so the shot-number
  tiebreak returned shot 1 every cycle — re-rendering (and re-billing) shot 1
  while shots 2..N never refreshed (observed as `001: currentTake 20` while
  `002..005` stayed on takes `[1,2,3]`). It now sorts on `nextTake` (the lifetime
  render counter the ring buffer never touches), giving true round-robin
  regeneration.
- **Loop tab take label.** The per-shot status read `take 20 of 3` (the `3` was
  the ring-buffer count on disk, not a total). It now reads `take #20 · 3 kept`
  with a tooltip explaining the `--max-takes` ring buffer.

## 2.20.0 — 2026-09-04

### Fixed

- **Loop watch mode: t2v `aspect_ratio` 400 + chain-frame past stream end (#25).**
  `renderVideoFile` now sends `aspect_ratio` for every `text-to-video` model
  (MiniMax H3 / H3 Max t2v **require** it — every opening watch take 400'd
  without it). `extractLastFrame` now probes the `v:0` **stream** duration (not
  the container, whose longer audio track pushed the seek past the last
  decodable frame, making ffmpeg exit 0 with no file) and steps back in widening
  offsets until the PNG lands, throwing otherwise so callers fall back to an
  unchained render instead of queueing an `image_url`-less i2v.
- **Loop money leak: a persistently-failing shot is now given up on.**
  `LoopEngine` tracks consecutive render failures per shot and, after
  `MAX_CONSECUTIVE_SHOT_ERRORS` (3), marks the shot `failed`, drops it from the
  scheduler, and stops re-queueing it. Previously a server-side-doomed shot (a
  MiniMax i2v start frame with a human face — billed at queue time, then
  `/video/retrieve` 500s forever) was re-selected fewest-takes-first and
  re-billed every cycle until the budget paused the loop. A manual `regenerate`
  revives a given-up-on shot. `failed`/`lastError` are surfaced on the manifest
  and `loop-updated` events.
- **Create mode no longer degrades a character shot to a face-killing i2v.**
  When a create-mode character shot has no R2V references on disk it now degrades
  to **t2v** rather than i2v-off-a-panel on models that reject face start frames
  (MiniMax) — a character panel almost always shows a face, which would 500.

### Added

- **`venice-video loop --face-continuity` (on by default).** Prompts each chained
  character shot to end on the character's face so the next clip's i2v
  continuation is smoother. **Auto-suppressed** on i2v models that reject face
  start frames (all MiniMax i2v lanes — a face-ending frame is the next start
  frame and would trip the server-side death), so it can't break the watch loop;
  it activates on a face-accepting i2v lane. `--no-face-continuity` to disable.
  New `i2vRejectsFaceStartFrame()` capability in `models.ts`.
- **`scripts/probe-minimax-r2v-face.ts`** — one paid 5s probe to settle whether
  MiniMax H3 Max **R2V** accepts face-bearing reference sheets (the open question
  behind create-mode character loops). **Verified 2026-09-04: it does** (render
  succeeded in ~13s) — only i2v *start frames* die on a face, so create-mode
  character loops are viable.
- Injectable `errorBackoffMs` on `LoopEngine` (test seam).

See AGENTS.md rule 58 and anti-pattern 31.

## 2.19.0 — 2026-09-04

### Added

- **`venice-video loop` — infinite loop mode (watch + create).** Boots the local
  web UI (a new **Loop** tab) plus an in-process `LoopEngine`
  (`src/mini-drama/loop-engine.ts`) that renders the approved shot script
  continuously and plays the whole plan as a live browser loop, hot-swapping each
  shot in as its take finishes and regenerating fresh takes while it plays. Two
  modes, **chosen by a required decision at session start** — "is this for LOOPING
  (creative flow, lower quality) or PRODUCTION (gather usable shots, higher
  quality)?" — asked interactively in a terminal and a hard error in a
  non-interactive run with no `--mode` (never a silent default). `--mode` accepts
  natural words (`looping`/`loop`/`fun`, `production`/`prod`/`gather`). The modes:
  **watch** (looping) renders
  **MiniMax H3 Max Turbo at 480P** — the first generation is t2v, every later shot
  chains i2v off the previous last frame, and it **never uses R2V** (too slow for
  a loop); identity is NOT locked. **create** renders the **non-Turbo** H3 Max
  family at 768P using the real reference-first routing — character shots on
  `minimax-h3-max-reference-to-video` with the full `@Image` reference stack +
  voice-donor audio (identity locked, takes usable), each shot rendered
  independently, degrading to i2v/t2v when references are missing.
  - **Continuous by default:** the loop regenerates forever (it does not stop
    after N takes); `--max-takes` is a ring buffer (candidate takes kept per shot,
    older ones pruned + deleted), not a stop condition. It stops only on Pause,
    `--once`, or the budget.
  - **Last-frame chaining** defaults to the mode (on for watch, off for create,
    since R2V and a start frame can't combine on MiniMax); `--no-chain` forces it
    off. Shot 1 renders normally, every later chained shot renders i2v off the
    previous shot's last frame so the loop plays as one continuous piece.
  - **Full-length takes:** every generation renders the model max (15s default),
    override with `--duration`.
  - **Budget as pause, not a hard stop:** `--budget` (default $2) pauses the loop;
    the UI **Resume** button (and per-shot regenerate) authorizes another budget's
    worth, so "Start/Resume" always does something. `--unbounded` removes the cap.
  Both modes skip the storyboard/QA gates, write only under
  `episodes/episode-NNN/loop/` (per-take mp4s + `loop-manifest.json`), and never
  touch canonical renders or `series.json`. Resumable across restarts; pins and
  per-shot regenerate from the UI. New
  `/api/projects/:slug/loop/{state,start,stop,pin,regenerate}` endpoints, a shared
  `EventHub` `loop-updated` event, and loop state surfaced through
  `collectEpisodeState`. See AGENTS.md rule 58.
- **MiniMax H3 Max (simple-prompt) models now improvise dialogue.** In
  native-dialogue mode, `buildVideoPrompt` and `buildMontagePrompt` render a
  speaker's scripted line as INTENT for these models — `[@ImageN, voice,
  delivery] conveys: "…"` plus a "improvise naturally in character, keep the
  meaning and tone, don't recite word for word" note — instead of the
  directorial `[…]: "exact line"` quote. Gated on
  `shouldImproviseDialogue(modelId, series)` (`modelWantsSimplePrompt` AND
  `audioStrategy !== 'lip-sync'`). Seedance/Wan/Kling keep the exact quote, and
  exact-lip-sync keeps the exact line (the `audio_url` drives the words). See
  AGENTS.md rule 59. Note: captions for these shots should come from
  transcribing the rendered audio, not `script.json`.
- **`resolveShotReferenceInputs` / `ensureVoiceReferenceForShot` exported from
  `video-generator.ts`.** The per-shot reference/scene/voice resolution block was
  extracted from `renderSingleShotUnit` into a shared `resolveShotReferenceInputs`
  helper (behavior-identical; `renderSingleShotUnit` now calls it) so loop create
  mode resolves the exact same reference stack the real pipeline does instead of a
  divergent copy.
- **`resolution` override on `renderVideoFile`.** Honored only when the model
  lists it (validated against the registry, else the family default applies), so
  loop mode can pin H3 Max Turbo to its 480P draft tier without disturbing the
  `768P`/`2K`/`720p` auto-pins every other path relies on.
- **MiniMax H3 Max + H3 Max Turbo** (probe-verified 2026-09-03):
  `minimax-h3-max-text-to-video` / `-image-to-video` / `-reference-to-video`
  and `minimax-h3-max-turbo-text-to-video` / `-image-to-video`. 768P/480P,
  5-15s, native non-toggleable audio, `private`, uncensored. $0.024/s and
  $0.012/s at 768P (base H3 is $0.10/s). Turbo ships no R2V lane. Two new
  video families — `minimax-h3-max` and `minimax-h3-max-turbo` — both routing
  identity to `minimax-h3-max-reference-to-video`, which is the only lane in
  the pair with `audio_input: true` and therefore also the family lip-sync model.
- **`promptStyle` on `VideoModelSpec`, and a simple-prompt path in the prompt
  builder.** H3 Max models are `promptStyle: 'simple'`: they stage their own
  framing, coverage, and cutting from a plain statement of intent, and the
  directorial stack flattens that. `buildVideoPrompt` and `buildMontagePrompt`
  now drop spatial blocking, the locked location description, and the
  geography-hold paragraphs for these models, and use the compact aesthetic
  instead of the full one. Identity declarations, reference role clauses, the
  beat, dialogue, sound, and the hard-cut instruction are kept — those are not
  inferable. Gate new behavior on `modelWantsSimplePrompt(id)`, not id checks.
  Every other family is unchanged (`'directorial'` is the default).

### Fixed

- **The resolution pin no longer sends H3 Max to 2K.** `renderVideoFile` matched
  `minimax-h3` by substring, so every `minimax-h3-max-*` render would have been
  pinned to `2K` — a hard 400 on those models. The `minimax-h3-max` branch now
  precedes it and pins `768P`.
- **Montage windows are bounded by the montage model, not a flat 30s.**
  `resolveMontageMaxDurationSec` accepted a `montageModel` and ignored it,
  always returning Seedance 2.5's 30s ceiling. Pointing `montageModel` at any
  shorter-ladder model (H3 Max tops out at 15s) therefore planned 30s units
  that all failed `assertShotDurationsValid` *after* the plan was written. The
  ceiling now comes from the model's `maxDurationSec` and an explicit
  `montageMaxDurationSec` is clamped to it. New `resolveMontageMinDurationSec`
  does the same for the floor, so H3 Max montages respect its 5s ladder start
  instead of Seedance's 4s.
- **Registry resolution ORDER is now load-bearing, and the Creator app honors
  it.** The app defaults to the first allowed resolution whenever a plan's own
  value isn't offered, and Venice's live `/models` lists H3 Max as
  `["480P", "768P"]` — so the app would have rendered every H3 Max shot at its
  draft tier. H3 Max entries list `['768P', '480P']` deliberately, and the app
  reorders the live list to follow the manifest
  (`VideoModelCapabilities.preferredResolutionOrder`). When editing a
  `resolutions` array, treat position 0 as the default, not as arbitrary.

## 2.18.0 — 2026-08-21

### Added

- **Seedance 2.5 renders default to `bitrate_mode: "high"`.** Every Seedance 2.5
  generation now attaches `bitrate_mode: "high"` to the `/video/queue` body,
  which encodes at ~5-6x the bitrate for a visibly sharper file with far fewer
  compression artifacts. It does **not** affect token price (the field is a
  pure encode setting, not a compute tier). Applies to the whole family
  (`seedance-2-5-text-to-video` / `-image-to-video` / `-reference-to-video`,
  and the `-basic` id spellings) across both queue paths: the shared
  `queueVideo` helper and the mini-drama series/episode/montage pipeline
  (`renderVideoFile`). Non-Seedance-2.5 models never receive the field, so the
  wan-3-0 / Veo / Kling fallbacks are untouched.
  - New helpers in `src/venice/models.ts`: `resolveBitrateMode(model, override?)`
    and `isSeedance25VideoModel(model)`, plus the `BitrateMode` type and
    `DEFAULT_SEEDANCE_25_BITRATE_MODE` constant.
  - Overridable per call: pass `bitrateMode: 'standard'` to `queueVideo` /
    `renderVideoFile` to opt back into smaller files.
  - The chosen mode is recorded in the video recipe/provenance sidecar
    (`extra.bitrateMode`).

## 2.17.0 — 2026-08-13

### Added

- **`storyboard-episode --shots <list>` — targeted panel regeneration.** Rebuild
  only specific panels (comma/range list, e.g. `--shots 5,8,11` or `--shots 5-9`)
  instead of the whole episode. Implies `--force` for the listed shots: their
  existing panels are archived and rebuilt from the current reference set; every
  other shot is left untouched, and all three passes (draft, refine, scene-ref)
  honor the filter. The reference preflight is scoped to the targeted shots, so
  an unrelated entity that lost its refs can't block a narrow rebuild. This is
  the "I removed a bad character/location reference, rebuild just the panels that
  were drafted from it" path.

- **Web UI: per-shot "Regenerate panel" + "Regenerate affected panels".** The
  Shots view now flags panels whose recipe was drafted from a reference image
  that has since been removed from disk (an amber `refs removed` badge, plus a
  banner listing the affected shots and the missing references). A per-shot
  "Regenerate panel" button rebuilds one panel; the banner's "Regenerate
  affected panels" button rebuilds them all in one `storyboard-episode --shots`
  pass. Staleness is computed from the current panel's recipe passes only (the
  passes at/after the most recent draft), so it clears as soon as a panel is
  rebuilt and never false-positives on the append-only history of an archived
  panel. Video-render passes never count — they feed the `.mp4`, not the `.png`.

### Fixed

- **Timeline exports keep clip audio at 0dB (native audio plays).** The spine
  emitted `<adjust-volume amount="-96dB"/>` on every clip — a hangover from the
  panels→video era when clips had silent audio and all sound came from connected
  lanes. On native-audio cuts (Seedance dialogue/ambient baked into the clips)
  that muted everything on import. Now every asset-clip is `0dB` (FCPXML +
  DaVinci exporters). Connected dialogue/SFX/music still ride their own lanes.
  (Follow-up idea: mute a clip only when a lane-1 dialogue clip replaces it, for
  Venice-TTS dialogue-replace projects — captured in WORKFLOW-IMPROVEMENTS.)

- **Timeline exports no longer leave a ~1-frame black gap at every cut.** The
  spine emitted each clip's `offset` and `duration` by rounding floats to frames
  independently (`toRationalTime(startSec)` vs `toRationalTime(durSec)`), so the
  cumulative offset rounding and per-clip duration rounding disagreed by up to a
  frame — on import each shot appeared to flash to black just before the next.
  All three exporters now accumulate clip offsets in INTEGER FRAMES, so clip
  N+1's offset is exactly clip N's offset + clip N's duration and the spine is
  perfectly contiguous. The sequence/`<duration>` total is the summed frames,
  and connected-audio child offsets are computed against the parent clip's
  frame-accurate offset (not the float `startSec`). Applies to
  `timeline-export/fcpxml.ts`, `davinci-fcpxml.ts`, and `premiere-xmeml.ts`
  (whose integer `<start>`/`<end>` were likewise derived from the cumulative
  float and are now accumulated).

- **Timeline media paths default to ABSOLUTE again (relative broke FCP
  linking).** A prior change in this same Unreleased cycle made the exporters
  write media paths RELATIVE to the XML by default for cross-machine
  portability. That regressed Final Cut Pro: with relative `./scene-001/...`
  `src` values FCP failed to link many clips and relinking threw an error (FCP
  effectively wants absolute `file://` paths). The default is now ABSOLUTE
  `file://` again, which FCP links and relinks reliably. Relative output is
  preserved as an OPT-IN via a new `--relative` flag on `export-timeline` /
  `export-fcpxml` (still useful for Resolve/Premiere); `--absolute` and the
  bare default both emit absolute paths. Cross-machine portability is handled
  by FCP's File > Relink Files > Original Media (Locate All at the folder); a
  future `export-timeline --bundle` (self-contained media copy beside the XML)
  is the durable portability answer. The `pathToMediaSrc()` helper in
  `timeline-export/probe.ts` still supports both modes.

- **`shot.nativeAudio` (mute/duck/keep) is now honored in the native mix, not
  only the dialogue-replace path.** The per-shot override was applied only when
  replacing dialogue with Venice TTS; in the default native path it was ignored
  despite the documented "shot.nativeAudio always wins" contract. It is now
  applied in `normalizeClip` (via an audio `volume` filter) so it works in every
  assembly. The motivating case: Seedance sometimes bakes a score/drone into a
  non-dialogue beat's native track (visible as harmonic bands in a spectrogram),
  which fought the post music bed and popped at the next cut; `nativeAudio:
  'mute'` on those beats now leaves only the post bed.

- **Audio pop at hard cuts between separately-generated units.** `assembler.ts`
  `normalizeClip` now applies a short audio fade (20ms in / 40ms out) to every
  clip during normalization. Hard cuts between a montage master and a
  single-shot render popped because Seedance singles often carry a junk audio
  burst at their head and native lines can end without a breath tail; the
  per-clip de-click removes the click without audibly shortening speech.
  Complements the cut-qa audio-pop check (rule 29).

### Changed

- **Location references are now coherent same-room angles (anchor → derive), and
  storyboard plates are off by default.** See AGENTS.md rule 56 for the full
  rationale. Two coupled changes:
  - **`location-generator.ts` derives angles from one wide plate.** `wide.png`
    is the only from-scratch t2i generation (the hero establishing plate);
    `angle-2` / `angle-3` / `angle-4` are each a `/image/multi-edit` re-angle of
    `wide.png` (nano-banana-2-edit), with a "SAME room, only the camera moves"
    contract. This replaces the old `wide` / `medium` / `detail` ladder — three
    INDEPENDENT text-to-image gens (same seed, different prompt) that produced
    three different-looking rooms and were fed to the video model together as
    "the same place," the root cause of location drift. Angle prompts lead with
    the wall that should fill the new frame (a negative "turn away from X"
    reverts to the master). The edit model preserves the wide's exact frame (no
    1:1 crop). Legacy `medium`/`detail` are still read on old projects; the
    default set is `wide,angle-2,angle-3,angle-4`. `wide.png` is generated first
    automatically when a derivation needs it. Validated on `il-caso-impossibile`
    (detectives-study, 3/3 coherent angles).
  - **Storyboard blocking plates no longer auto-generate.**
    `workshop-episode` / `generate-videos` skip plate generation unless
    `videoDefaults.useStoryboardPlates: true` (`resolveUseStoryboardPlates`).
    A full pictorial plate used as an R2V reference pulls every shot in a beat
    toward one composition ("too similar" drift) and is a conflicting fourth
    environment signal; spatial consistency now rides the coherent location
    angles + the shot's text `blocking` (rule 49). Plates stay available via
    `generate-storyboard-refs` and are still consumed as the PROTECTED slot
    when present on disk. `reference-slots.ts`, the location-ref lookups
    (`video-generator.ts`, `cli.ts`), the plate base image
    (`storyboard-reference-generator.ts`), and the art-angle lists
    (`workshop.ts`, `web/state.ts`) were updated to the new angle names.

## 2.17.0 — 2026-08-11 (reference drafting; shipped in 2.17.0)

### Added

- **Web UI: "Generate videos — skip storyboard" button.** Renders an episode
  straight from references without panels or the storyboard QA gate
  (`generate-videos --skip-qa`). On Seedance R2V this is pure reference mode:
  character sheets, blocking plates, and location angles carry all
  consistency and no start frame is sent. Shots with no references at all
  are skipped with a warning. Shown in the Shots view whenever the QA gate
  is not yet cleared; the billed-render confirm spells out the trade.

- **`fix-flagged` — batch panel repair (web UI "Fix all flagged" button).**
  Reads the episode's `qa-report.json` and runs the fix-panel multi-edit pass
  across every flagged shot in one command. `--severity critical,moderate`
  (default; FLAG-LOW is excluded — stylistic variance that identity edits
  rarely improve), `--requa` re-runs `qa-storyboard --shots <fixed>` on just
  the repaired panels. Each fix feeds the QA report's specific findings into
  the recipe trail. Whitelisted in the web UI job runner; the Shots view shows
  a "Fix all flagged" button whenever critical/moderate flags exist.

- **Per-shot reference-usage visibility.** Every reference-conditioned pass
  (draft, plate, fix) now records a `referenceUsage` summary in the recipe
  sidecar — which identities were anchored to real reference bytes vs
  prompt-text fallback, and what the base image was. The web UI Shots view
  shows a per-shot badge: green `refs n/n` when fully anchored, amber with
  the affected names when any character fell back to text-only (missing
  sheet, or dropped by the multi-edit 2-layer budget). Text-only fallback
  drafts record usage too, so degraded panels are visible at a glance
  instead of buried in job logs.

### Fixed

- **`fixPanel` required `front.png` specifically and threw when a character
  had only `anchor.png`/`three-quarter.png`** — one source of "sometimes the
  reference isn't used": the whole refinement pass failed for that shot and
  the unrefined draft shipped. Now resolves anchor → front → three-quarter,
  the same precedence as the reference-slot allocator and reference drafting.

- **Character reference sheets could ship with no character in the prompt.**
  `buildCharacterReferencePromptParts` put the style cue first and greedily
  appended parts until the per-model cap; a long authored aesthetic (390-char
  style) on a model with the conservative 300-char default cap consumed the
  whole budget, so every angle of every character shipped the SAME truncated
  style-only prompt — 16 near-identical scene tableaus with invented figures,
  objects rendered as people (venice-4m-users). Three fixes:
  - Priority inverted: the angle instruction + a character anchor (traits,
    wardrobe, trimmed description) are now a guaranteed floor; the style cue
    gets the remaining budget and is word-boundary truncated.
  - `nano-banana-2`/`-edit` added to `MAX_POSITIVE_PROMPT_CHARS` at 1500 —
    they previously fell through to the 300 default, a seedream-specific
    silent-reject guard.
  - Dropped the `not ${palette}` / `not ${filmStock}` negative additions:
    multi-word "not X" phrases tokenize into individual negative terms
    ("oxblood", "gold leaf"), actively suppressing the series' own palette.
  - Placeholder wardrobe values ("n/a", "none") on object cast members no
    longer leak into prompts.

- **Storyboard drafting never sent reference images (root cause of character
  drift).** `generateWithReferences` claimed to attach character/location
  reference bytes to `/image/generate`, but the endpoint has no reference
  input and the bytes were silently dropped — every "reference-anchored"
  panel and blocking plate was drafted from prompt text alone, leaving the
  storyboard QA agent to repair identity and geography panel by panel.
  Panel and plate drafting now routes through `/image/multi-edit` (the only
  image endpoint that accepts reference bytes) via the new
  `draftPanelWithReferences` (`src/venice/reference-draft.ts`):
  - **Character shots with a location:** the panel is composed INTO the
    location plate (base image) with character refs as layers — geography
    inherited pixel-for-pixel, identity from real reference bytes, one call.
  - **Character shots without a location:** t2i scene draft, then an
    immediate identity composite before the panel lands.
  - **Establishing shots with a location:** drafted as an edit of the
    location plate instead of a text-only regeneration.
  - **Blocking plates** (`storyboard-reference-generator.ts`) use the same
    location-base + character-layer composition.
  - Pass-2 identity refinement is skipped for reference-drafted panels
    (identity is already real; a second edit only degrades).
  - `generateWithReferences` is deprecated with a runtime warning; the
    legacy `storyboard/assembler.ts` lane still calls it.
  - Multi-edit post-processing (WebP fix + 1:1→target aspect restore) is
    extracted from `panel-fixer.ts` into shared `src/venice/edit-post.ts`.

## 2.16.0 — 2026-08-10

Released: the `seedance-2-5-montage` branch merged to main (PR #24) after a
full paid montage E2E (60s two-scene trailer → per-beat cuts → media library →
valid FCPXML 1.10 → assembled 1440p master). Everything under the
`2.16.0-montage` heading below ships in this release, plus:

### Added

- **Voice harvest from rendered clips.** `generate-voice-reference
  --from-shot <n>` (and `lock-character --voice-from-shot <n>`) extract a
  character's voice-donor clip from an already-rendered shot — silence-trimmed
  at both ends, normalized to the Venice 2-15s window, recipe pass logged, no
  Venice call — so later shots lock to the voice the audience actually heard.
  Optional `--from-start` / `--from-end` window the spoken line.

### Changed

- **Route + audio-strategy copy reframed.** Montage is "default — recommended";
  standard is the special-purpose per-shot escape hatch (non-groupable scripts,
  per-shot control, non-Seedance families). Exact lip-sync is named
  special-purpose (music videos, pre-recorded VO, language swaps) — native
  dialogue already covers voice consistency via `reference_audio_urls`.

### Fixed

- **webp/png reference mismatch:** when Venice returns webp bytes for a
  requested `.png`, the harness keeps the `.webp` sibling AND transcodes to the
  requested name, so fixed-name resolvers (reference-slots, panel-fixer,
  storyboard refine) still find the asset.
- **Intermittent empty vision responses** (kimi-k3) consume `chatJson`'s retry
  attempt instead of failing the panel immediately.
- **Silently dropped SFX:** `export-timeline` now warns when a file in
  `audio/sfx/` has no `shot-NNN` filename anchor (or references a missing
  shot) instead of dropping it from the timeline without a word.

## 2.16.0-montage (branch: seedance-2-5-montage) — 2026-08-07

### Changed

- **Render route is now an upfront question at project creation.** `venice-video
  new` (interactive) and `new-series` (flags) ask "montage vs standard", or take
  `--route montage|standard`: montage (advanced/editor) = one single-pass
  generation per scene, auto-cut into a media library for later editing;
  standard (beginner) = 2.0-era per-shot / short multi-shot planning, more
  automated but more prone to consistency drift. The answer sets
  `videoDefaults.montageMode` (montage→true, standard→false); omitting it keeps
  the montage-first default. New `RENDER_ROUTE_CHOICES` in
  `src/mini-drama/choices.ts`; `CreateSeriesOptions.montageMode` in
  `src/series/manager.ts`.
- **Seedance 2.5 is now the default video model across every lane** (was
  Seedance 2.0 R2V Enhanced). `DEFAULT_ACTION_MODEL`, `DEFAULT_ATMOSPHERE_MODEL`,
  `DEFAULT_CHARACTER_CONSISTENCY_MODEL`, `DEFAULT_MULTISHOT_MODEL`,
  `resolveVideoFamilyDefaults('seedance'|'auto')`, and the in-family
  `resolveLipSyncModel('seedance'|'auto')` all resolve to
  `seedance-2-5-reference-to-video`, matching the montage lane. This unifies the
  whole harness on 2.5: single-pass up to 30s, up to 30 reference images,
  `audio_url` + reference audio in-family. Trade-off: 2.5 caps at 720p (the
  mini-drama generator already pins 720p for Seedance, so no request regresses);
  2.0 R2V Enhanced (1080p) stays registry-known and selectable via
  `videoDefaults`. Added `seedance-2-5-reference-to-video` to
  `MODELS_SUPPORTING_AUDIO_INPUT` (its spec is `audio_input: true`; the
  registry-coverage test enforces the set). Regenerated `capabilities.json`.
  See AGENTS.md rule 51.
- **`sd25-pe` skill installed** at `.agents/skills/sd25-pe/` — the Seedance 2.5
  Prompt Optimizer plus a harness-bridge section mapping its compiled Prompts
  onto the harness fields (montage SEQUENCE grammar, @Image discipline, no-music
  suffix; the harness stays authoritative on identity/refs/duration/resolution).

### Added

- **Seedance 2.5 in the registry.** `seedance-2-5-text-to-video` /
  `seedance-2-5-image-to-video` / `seedance-2-5-reference-to-video` — live on
  quote/queue only (not on GET /models), probed 2026-08-07. Every integer
  duration 4s-30s, 480p/720p, aspect 21:9/16:9/4:3/1:1/3:4/9:16,
  ~$0.29/s at 720p (30s ≈ $8.67). R2V accepts `audio_url`,
  `reference_audio_urls`, and `reference_video_urls`; image-reference budget
  raised to **30** on the 2.5 R2V lane (release-note ceiling 30/10/10, 50
  total — enforced harness-side). Added to `MODELS_USING_IMAGE_TAGS`,
  `MODELS_SUPPORTING_REFERENCE_IMAGES`, `MODELS_SUPPORTING_REFERENCE_AUDIO`,
  and `MAX_REFERENCE_IMAGES_BY_MODEL`.
- **Montage-first generation (this branch's default).** The planner groups
  each scene (consecutive shots sharing a `location`) into ONE single-pass
  `montage` unit up to 30s on `seedance-2-5-reference-to-video`, prompted
  with the timestamped SEQUENCE grammar from the vault's "Make a full trailer
  with Seedance 2.5" pack (`buildMontagePrompt`): SHOT header ("cut it
  yourself in the edit"), @Image identity declarations from the standard
  reference slot plan, per-beat `[0:03-0:05] …` blocks with diegetic sound,
  geography hold, one style token ending in "Face stable throughout, no
  deformation. Diegetic sound only, no music, no on-screen text.", short
  negative. New module `src/mini-drama/montage.ts` (scene grouping, beat
  layout, montage planning, post-render cutting).
- **Beat-accurate cutting into a media library.** After the render,
  `cutMontageIntoShots` slices the clip at the SAME `montageBeats`
  timestamps the prompt declared (scaled to the actual rendered duration):
  canonical `scene-001/shot-NNN.mp4` files for the assembler AND organized
  copies in `episode-N/media-library/scene-NN/` with the uncut master and a
  `manifest.json` per scene.
- **`autoEdit` toggle.** `videoDefaults.autoEdit: true` (or
  `generate-videos --auto-edit`) chains straight into `assemble-episode`
  after the cut; the default `false` (or `--no-auto-edit`) stops at the
  media library for hand editing / the Venice Video Creator.
- **Opt-outs.** `videoDefaults.montageMode: false` or
  `generate-videos --no-montage` restores the 2.0-era per-shot / 15s
  multi-shot planner (unchanged). Inserts, title cards, `mustStaySingle`,
  and exact-lip-sync shots fall through as singles automatically.
  `videoDefaults.montageModel` / `montageMaxDurationSec` override the lane.
- **Smoke tests:** `scripts/smoke-montage-plan.ts` (grouping, plan, prompt),
  `scripts/smoke-montage-cut.ts` (cutting + library layout + manifest).
- **Duration preflight** understands montage units: validates the unit total
  against the 2.5 ladder instead of per-beat windows.

## 2.15.0 — 2026-08-06

### Added

- **Capability manifest: the probe-verified registry is now a machine-readable
  export downstream clients can sync against.** New
  `src/venice/capabilities-manifest.ts` builds a versioned JSON manifest
  (`schemaVersion: 1`) carrying the full `VIDEO_MODELS` registry, the eight
  exact-id capability sets (elements, referenceImages, sceneImages, endImage,
  imageTags, audioInput, perReferenceAudio, referenceAudio), the budgets
  (per-model reference-image caps, image-model prompt caps, the 2500-char
  video prompt limit), and the routing defaults (action / atmosphere /
  character-consistency / multi-shot / lip-sync / image models). Three ways
  to consume it:
  - `venice-video capabilities` — emits the manifest on stdout.
  - `capabilities.json` at the repo root — a committed snapshot regenerated
    by `npm run manifest` (wired into `prepack`, shipped in the npm tarball),
    so clients can fetch the raw file from GitHub `main` or read it from an
    npm install. `generatedAt` is pinned while data is unchanged, so the
    snapshot only diffs when the registry actually moves.
  - Library exports: `buildCapabilitiesManifest()`,
    `renderCapabilitiesManifest()`, `CAPABILITIES_SCHEMA_VERSION`.

  The manifest is data only — prompt builders and planners still ship with
  each client. First consumer: the Venice Video Creator macOS app, which
  fetches it at launch (behind a user toggle) to keep its
  `VideoModelCapabilities` allowlists current between app releases.
  `tests/capabilities-manifest.test.mjs` guards registry coverage, set
  consistency, known-id routing defaults, deterministic rendering, and the
  CLI command's JSON shape.

### Fixed

- **`MODELS_SUPPORTING_END_IMAGE` no longer lists the Wan 2.7 i2v family.**
  The live queue rejects `end_image_url` on Wan 2.7 i2v (Uncensored/Spicy):
  "This model does not support end_image_url" — probed 2026-07-06 during the
  Venice Video Creator app sync. The `VideoModelSpec` entries already said
  `supportsEndImage: false`; the set had silently drifted from the registry.
  Caught by the app's bundled-manifest test the day the manifest went live.

## 2.14.1 — 2026-08-05

### Changed

- **README: added a human-facing "Installing the CLI" section.** Installation
  was documented only inside the agent-runner quick start; a person at a
  terminal had no plain install path. The new section covers prerequisites
  (Node 20+, ffmpeg/ffprobe), the global npm install with `setup` (interactive
  or `--api-key`/`--workspace`/`--skip-validation`) and `doctor`, the three
  bins on PATH (`venice-video`, `video-harness`, `storyboard`), the
  from-source path (clone, `npm install`, `npm run build`, `npm run dev --` /
  `node dist/mini-drama/cli.js`, `.env` for the API key), and pointers to
  `pipeline` and `shell`. Docs only.

## 2.14.0 — 2026-08-05

### Changed

- **Provider-neutral workspace: `.claude/` → `.agents/`, `CLAUDE.md` symlink
  removed.** The knowledge pack (20 command playbooks, 10 sub-agent roles,
  9 skills, hooks-config) now lives at `.agents/` — a neutral name any coding
  agent (Cursor, Claude Code, Hermes, OpenClaw, Codex, opencode) can read
  without implying a provider. Every reference was rewritten: `package.json`
  `files[]`, `src/agent/guide.ts` (the `agent-guide` text shipped inside the
  binary), source-comment cross-references, `AGENTS.md`, `README.md`, and all
  intra-pack links (`hooks-config.json`, skills, commands, agents). The
  `CLAUDE.md → AGENTS.md` symlink is gone — `AGENTS.md` is the single
  orchestration hub. Claude Code's own `settings.local.json` was untracked
  (provider-local state, now git-ignored along with any `.claude/` a specific
  runner drops in a checkout).
- **What deliberately still says `.claude`:** external tools' own read paths.
  Claude Code and Cursor consume skills from `~/.claude/skills/` /
  `<workspace>/.claude/skills/` — that is their convention, not this repo's
  layout — so the `venice-video-mcp-install-skills` docs still name those
  targets, and the optional Seedance Skill OS install still lands wherever
  the runner reads. Historical CHANGELOG entries are unchanged (they describe
  the tree as it was). No code behavior changes; docs, packaging, and the
  embedded agent-guide text only.

## 2.13.1 — 2026-08-05

### Changed

- **README: Video Model Routing catches up with the 2.13.0 multi-shot default.**
  The routing table gained a "Multi-shot units" row naming
  `seedance-2-0-enhanced-reference-to-video` as the default lane (`Lens switch.`
  separators, pure reference mode from the full slot plan) with
  `kling-o3-pro-image-to-video` demoted to an explicit
  `videoDefaults.multiShotModel` override, and the "carry these" rule 3 now
  notes the planner applies Seedance native multi-shot by default. Docs only.

## 2.13.0 — 2026-08-05

### Changed

- **Multi-shot units now default to Seedance 2.0 R2V Enhanced — the Kling i2v
  lane is an explicit override only.** `DEFAULT_MULTISHOT_MODEL` /
  `resolveMultiShotModel()` (new, `src/series/types.ts`) route every
  multi-shot generation unit to `seedance-2-0-enhanced-reference-to-video`,
  the same reference-first lane as singles. The old default,
  `kling-o3-pro-image-to-video`, has NO `elements` and NO
  `reference_image_urls` support, so every multi-shot unit silently dropped
  all identity anchoring (anti-pattern 1's underlying trap). Specifics:
  - **New `buildMultiShotPrompt()`** dispatches on the resolved model. The
    Seedance path builds ONE native multi-shot generation per rule 21:
    identity declarations from the unit's @Image slot plan up front, role
    clauses for the blocking plate and location angles, per-beat
    `Shot N (Xs):` blocks (names → `@ImageN`, authored `Blocking:` restated
    per beat, `[@ImageN, voice, delivery]: "line"` dialogue), literal
    `Lens switch.` separators, and a geometry-hold clause pinned to the plate
    (rule 49). ≤2500-char video prompt cap with aesthetic-first trimming.
  - **Pure reference mode for the whole unit:** `reference_image_urls` pushed
    in slot-plan order (union of the window's characters + the beat's plate +
    location angles), no `image_url` start frame, no `end_image_url`. The
    unit also carries voice-donor `reference_audio_urls` (@AudioN) for its
    dialogue speakers, deduped across beats within Venice's 3-clip budget.
  - **Planner:** unit type renamed `kling-multishot` → `multishot` (the old
    name still parses from existing generation-plan.json files); units carry
    the resolved model; multi-shot windows can no longer span locations
    (rule 21b — one slot plan per generation); the 15s window limit message
    no longer names Kling (both lanes cap at 15s).
  - **Override:** `videoDefaults.multiShotModel` (new) selects another lane
    explicitly — setting it to `kling-o3-pro-image-to-video` restores the
    legacy Kling 3.0 format (`buildKlingMultiShotPrompt` is retained and
    still exported). `KLING_MULTISHOT_MODEL` is deprecated but resolvable.
  - **Docs:** AGENTS.md rule 18 rewritten (Seedance default, Kling as
    override), anti-pattern 1 annotated, `venice-video-model-routing`
    (SKILL/README/decision trees) and `character-consistency` updated.
  - **Tests:** `test-spatial-consistency.mjs` now covers the dispatcher —
    default resolution, Lens-switch structure, slot plan (plate + location),
    per-beat blocking with @ImageN substitution, geometry hold, and the
    explicit Kling override path; `audio-routing.test.mjs` asserts the
    grouped unit renders on Seedance R2V.

## 2.12.0 — 2026-08-05

### Added

- **Spatial consistency is now authored data, not per-generation inference
  (rule 49).** Visual consistency was already reference-anchored, but *where*
  characters and objects sit — screen side, depth, facing, position relative to
  the set — was re-inferred by the model on every generation, which is where
  side-swaps, teleporting props, and mirrored geography came from
  (anti-pattern 28). Two new fields carry the geometry through the whole
  pipeline:
  - **`Location.spatialAnchors`** — the locked geography of a place: 3-5 named
    landmarks and their fixed relative positions. Baked into the location's
    reference angles at generation time, injected as
    `Fixed layout (never rearrange): …` into every panel and video prompt for
    shots tagged with the location, and sticky on merge (an existing anchor
    set is never overwritten by a later script part). `add-location` takes
    `--spatial-anchors`.
  - **`ShotScript.blocking`** — the shot's authored geometry: 1-2 sentences
    placing each character/object relative to the named anchors, the frame
    (screen left/right, foreground/background), and their facing/eyeline.
    Injected verbatim (with `@ImageN`/`@ElementN` name substitution) into the
    panel prompt (`BLOCKING: …`), the video prompt (`Blocking: …`), and the
    Kling multi-shot per-shot blocks; it also seeds the beat's storyboard
    blocking-plate description. `insert-shot` inherits the anchor shot's
    location and blocking for same-scene splices and takes `--location` /
    `--blocking` overrides.
- **The script LLM is now required to author the geometry.** Both workshop
  system prompts (`workshop` in `workshop.ts` and `workshop-script` in
  `cli.ts`) demand `spatialAnchors` per location and `blocking` per character
  shot, with continuity rules: characters keep their screen sides and relative
  positions across consecutive shots unless a movement is written into the
  action, screen direction and eyelines obey the 180-degree rule, and blocking
  always references the location's named anchors. `workshop-script` warns when
  character shots are missing `blocking` or locations are missing
  `spatialAnchors` (post-condition advisory, same pattern as the duration and
  no-music checks).
- **`qa-storyboard` reads geometry.** A fourth SPATIAL CONTINUITY dimension
  checks each panel against the shot's stated blocking and the location's
  landmarks, and the command now attaches the nearest prior panel from the
  same location so side-swaps, mirrored geography, and moved landmarks are
  caught against real coverage instead of prose alone. A spatial flip that
  breaks the scene is FLAG-CRITICAL; a wrong frame side or relocated landmark
  is FLAG-MODERATE.
- **Stronger geometry clauses in video prompts.** The blocking-plate clause now
  explicitly forbids mirroring/swapping ("each character stays on the same
  side of the scene… do not mirror, swap, or rearrange who stands where"), and
  plateless location shots get a geography-hold clause pinned to the location's
  first `@ImageN` slot. Blocking plates themselves are prompted for legible
  placement (screen side, distance, facing, landmark relations readable in one
  look) and carry the location's fixed layout.
- **Docs and knowledge pack updated together:** AGENTS.md rule 49 +
  anti-pattern 28, README "carry these" rule 8, `agent-guide` (binary +
  `venice-agent-guide` skill), `shot-composition` (spatial blocking rules),
  `character-consistency` (Layer 5: spatial anchoring),
  `venice-video-model-routing` (blocking/fixed-layout prompt lines),
  `prompt-engineer` ([BLOCKING] template section), `storyboard-qa`, and the
  `qa-storyboard` / `workshop-episode` playbooks.
- **Tests:** `tests/test-spatial-consistency.mjs` covers blocking injection in
  panel/video/multi-shot prompts, `@ImageN` substitution inside blocking,
  fixed-layout injection, the no-mirroring and geography-hold clauses, plate
  descriptions inheriting blocking, and the workshop prompt contract.

## 2.11.2 — 2026-08-05

### Changed

- **README: added `HERMES-AGENT-SETUP.md` and trimmed the ACP explainer.** A
  paste-ready re-setup prompt for Hermes users on an old global install (which
  shipped only the compiled CLI — no `AGENTS.md`, skills, or MCP) is now linked
  from the Hermes/OpenClaw quick start. Removed the "ACP does not run the
  harness" section — it was conceptual myth-busting, not setup or operating
  guidance — and reworded the "separate runtime" section to stand on its own.
  The operational runtime/long-render guidance is unchanged. Docs only.

## 2.11.1 — 2026-08-05

### Changed

- **README agent instructions rewritten around the published packages.** With
  both `venice-video-harness` and `venice-video-mcp` on npm, the Hermes/OpenClaw
  path is now a plain global install rather than a two-repo clone with
  hand-written absolute paths. Added a "Quick start for Hermes and OpenClaw"
  block, rewrote "Registering the MCP server" to lead with the published
  `venice-video-mcp` bin (and an `npx -y venice-video-mcp` variant) while keeping
  the clone + `HARNESS_BIN`/`HARNESS_PATH` path as a documented dev alternative,
  and switched the companion-skills step to the on-PATH
  `venice-video-mcp-install-skills` bin. Clarified that with both packages
  installed globally you set none of the harness path variables — the MCP finds
  `venice-video` on `PATH`. Softened the stale "npm latest trails this repo"
  version-drift note. Docs only; no code change.

## 2.11.0 — 2026-08-05

### Added

- **The CLI now describes itself, so the operating knowledge travels inside the
  binary instead of only in a checkout.** A knowledge pack that lives in a file
  array can be left out of a tarball or unreachable to a runner that never
  clones; a command cannot. Three new commands:
  - `venice-video agent-guide [--json]` — the ~80/20 core rules (find the next
    step, queue-time billing and re-attach, long renders needing background
    invocation, the human gates, consistency-first generation). Sourced from
    `AGENTS.md`, kept in `src/agent/guide.ts`.
  - `venice-video pipeline [--json]` — the ordered stages, the artifact each
    produces, the two human gates, and the literal command that advances each.
    Mirrors the on-disk state machine in `src/session/status.ts`.
  - The same core rules are also installable as a skill
    (`.claude/skills/venice-agent-guide/`), so a runner that pulls skills from
    GitHub (for example `hermes skills install
    jordanurbs/venice-video-harness/venice-agent-guide`) gets them without a
    clone or an npm publish.

- **`--json` on the agent-facing read commands** — `status`, `doctor`, `queue`,
  `pipeline`, and `agent-guide`, plus a global `--json`. Output is exactly one
  JSON object on stdout; the human text rendering is unchanged. An agent no
  longer has to scrape prose whose wording can shift.

### Changed

- **Honest exit codes.** `venice-video status` with no project selected now exits
  non-zero instead of printing a note and exiting 0 — an agent checking `$?` was
  seeing success on an error.

- **Ordinary failures are a clean `error:` line, not a Node stack trace.** A usage
  error in a non-TTY used to surface as an uncaught exception with a
  `Node.js v22.x` footer that reads as a crash. The top-level handler now prints
  the message and exits 1; set `VENICE_VIDEO_DEBUG=1` for the stack.

- **Gate errors state the condition and the command that clears it, and no longer
  present `--skip-approval` / `--skip-qa` as a "Bypass".** The skip flags bypass
  the check without making the underlying approval true, so they are not the fix
  for an agent — the error now says so.

- **The MCP server's harness resolution order was reversed so intent wins.**
  `venice-video-mcp` now resolves `HARNESS_BIN`, then `HARNESS_PATH/dist`, then a
  `venice-video` on `PATH` (previously `PATH` outranked `HARNESS_PATH`). Setting
  `HARNESS_PATH` is an explicit statement of intent and must beat an ambient,
  often-stale global install. Resolution is also logged once to stderr
  (`[venice-video-mcp] harness: …`) so it can never again pick the wrong binary
  silently. See `venice-video-mcp` 0.4.0.

- **`install-skills` grew `--target hermes` and `--dir <path>`** so the companion
  skills can be installed into a runner's own skills directory
  (`~/.hermes/skills/venice/`) rather than only a Claude-shaped `.claude/skills/`.
  `--target openclaw` errors honestly — its skills path is not verified on any
  machine yet — and points at `--dir`.

## 2.10.0 — 2026-08-05

### Added

- **The agent operating contract now ships in the published package.** `AGENTS.md`
  (47 agent rules, 20 production anti-patterns), `.claude/commands/`,
  `.claude/agents/` and `.claude/skills/` are in the `files` array. Until now the
  package published only `dist` and the README, so an agent driving a global
  install — Hermes Agent and OpenClaw both do — had the compiled CLI and nothing
  that explains it: no pipeline order, no gate map, no model-routing rules, no
  anti-patterns. It saw `--help`, a flat list of 40-plus commands, and guessed.
  That was the largest single cause of poor agent-driven output, and it was a
  knowledge gap rather than a missing capability. Verify with
  `ls "$(npm root -g)/venice-video-harness/AGENTS.md"`. `.cursor/rules/` stays
  repo-only, being IDE configuration rather than operating knowledge.

- **README > "Driving this from an agent"** — explicit instructions for a coding
  agent operating the harness. Covers the three integration surfaces and what
  each one gives the agent, MCP registration with the companion skills, the
  version-drift preflight, the cwd/workspace trap, the two pipeline gates and why
  not to route around them with `--skip-approval` / `--skip-qa`, queue-time
  billing and re-attach instead of blind retry, the output-parsing sharp edges
  (no `--json`, `status` exiting 0 on "No project selected", usage errors
  arriving as Node stack traces), a complete non-interactive run, and the twelve
  rules with the most effect on output quality.

- **Two sections on where the harness actually runs**, replacing a single
  too-narrow note about ACP. ACP (Agent Client Protocol) connects an *editor* to
  an *agent* over stdio, with the editor supplying the working directory — it
  neither runs the harness nor provisions a runtime, so the harness has no
  position in an ACP conversation and MCP remains the tool-side protocol.
  Provisioning a separate runtime for long renders is a genuinely good fit but is
  a different mechanism (in Hermes, `terminal.backend`: local / docker / ssh /
  modal / daytona / singularity), and it has four prerequisites the default
  images do not meet: `venice-video`, `ffmpeg` and `ffprobe` in the image, the API
  key passed through, a persistent workspace volume, and a retrieval step home.
  **The trap worth knowing:** `pending-jobs.json` lives in the per-machine config
  directory, so on an ephemeral container the record that makes an interrupted
  render re-attachable dies with the container and an already-billed render
  becomes unrecoverable — mount the config dir, or keep generation on a
  persistent backend.

- **Documented the harness-resolution order the MCP server uses, because it has a
  silent failure mode.** The server tries `HARNESS_BIN`, then `venice-video` on
  `PATH`, then `HARNESS_PATH/dist/mini-drama/cli.js` — so a global install
  outranks `HARNESS_PATH`, and a config setting only `HARNESS_PATH` on a machine
  with a global `venice-video` drives the **global** copy. Since npm `latest`
  trails this repo, that silently runs an older binary: newer flags fail and fixed
  bugs reappear while everything looks configured correctly. Verified by
  handshaking the server both ways and reading back the `command` field in the
  response, which names the binary that answered. The README now says to set
  `HARNESS_BIN` and how to confirm which copy is live.

- **Guidance on long-render invocation.** `generate-videos`, `assemble-episode`,
  `produce-episode`, `finish` and `upscale` run 3–10 minutes, while a typical
  agent terminal tool defaults to a 180-second timeout and caps a foreground
  command at 600s (Hermes's numbers). A foreground render is killed partway
  through, and because Venice bills at queue time it is already paid for. These
  stages must be invoked as background commands with completion notification, and
  a killed render is recovered by re-running the identical command rather than
  starting over.

## 2.9.0 — 2026-08-05

### Added

- **`venice-video update`** (alias `upgrade`) installs the latest published
  release, so upgrading is no longer a remembered npm incantation. `--check`
  reports what is available and installs nothing, `--dry-run` prints the exact
  npm command first, `--tag` follows a dist-tag other than `latest`, and a build
  ahead of the tag is reported rather than downgraded unless `--force` is given.
  The install targets the prefix the running copy lives in rather than the `npm`
  first on `PATH`: a version manager can leave those pointing at different
  prefixes, and then `npm install -g` reports success while the executable that
  actually runs stays on the old version. The new version is read back off disk
  afterwards, and a mismatch says to check `command -v venice-video`. A copy
  inside a project's `node_modules` or a git checkout is not installed over —
  each prints the command that does own it.

- **The intelligence model is now a project setting.** The workshop, the shot
  script and storyboard QA are the three steps that reason rather than render,
  and the model behind them is chosen when the project is created: **Kimi K3**
  (default), GLM 5.2 or Grok 4.5 on the **private** tier, where the prompt stays
  on Venice infrastructure; Fable 5, Opus 5, GPT 5.6 Sol or Qwen 3.8 Max on the
  **anonymized** tier, where it is routed to an external provider with
  identifying metadata stripped. The wizard asks, `--intelligence` states it
  upfront, `series.new` takes `intelligenceModel`, and `--model` still overrides
  a single run. Existing projects have no stored choice and fall back to the
  default. Previously the pipeline was hardwired to `llama-3.3-70b`, which
  neither reasons nor reads images.
- A text-only choice is paired with a vision-capable companion **from the same
  privacy tier** — GLM 5.2 borrows Grok 4.5 for QA, never an anonymized model.
  Sending a private project's panels to a weaker tier to work around a missing
  capability would break the promise the operator made when they picked private.
  The pairing is shown in the wizard and as a pill on the treatment page.

### Fixed

- **`qa-storyboard` could not have worked for any user.** Its default model,
  `qwen-2.5-vl`, was sunset from the Venice catalog and returns
  `Specified model not found`. Every panel hit the error path, was recorded as
  `FLAG-LOW` "Vision API error", and the run then reported "No critical issues"
  and suggested `qa-approve` — green-lighting a storyboard where nothing had
  been checked. The default now comes from the project's intelligence model, and
  shots whose vision call failed are counted separately as unchecked and
  suppress the approval suggestion.
- Venice error messages are no longer discarded. The client read only
  `error.message`, but the API also returns `{error: "..."}` for routing
  failures and `{issues: [{message}]}` for validation, so the two most useful
  messages — `Did you mean: …` on an unknown model, and `Image content is not
  supported by this model` — were being replaced with a bare
  `Venice API returned HTTP 400`.
- Structured-output requests now retry once with the parse error quoted back to
  the model. GLM 5.2 drops a closing brace roughly one attempt in three, which
  previously failed the whole command; it now completes reliably. Fence
  stripping also tolerates a model that narrates before its JSON.
- Vision requests were capped at 2000 `max_tokens`, which a reasoning model can
  spend entirely on thinking and return empty content. Raised to 4000, and an
  empty reply now says which of the two causes it was.
- An explicit `--model` on `qa-storyboard` is used verbatim rather than being
  silently swapped for a known vision model.

## 2.8.0 — 2026-08-05

### Added

- **The treatment page tracks the run.** `WORKSHOP.html` is re-rendered by every
  command that produces an artifact, so the tab you already have open is one
  reload away from current. It gains a Production progress card (stage, panel /
  clip / dialogue counts, and the next command) and an Output column on the shot
  script showing each shot's panel — replaced by the clip's poster frame once it
  renders — with badges for panel, clip, voiceover and QA verdict. Hover a
  flagged verdict to read the issue. `WORKSHOP.md` carries the same progress
  summary.
- Thumbnail encoding is cached against each file's mtime in
  `.treatment-thumbs.json`, so a refresh re-encodes only what changed (~10ms for
  an unchanged episode, versus ~280ms cold).

### Fixed

- **`storyboard-episode` suggested `/qa-storyboard`, which cannot be run.** A
  leading `/` is reserved for the shell's meta-commands, and the suggestion also
  omitted `-p` and `-e`. Every suggested next step is now a complete, runnable
  command line. The same applied to the `generate-videos` QA-gate error and the
  `storyboard-episode` approval error, which printed `<project>` placeholders.
- **`status` told workshop-driven projects to re-approve a script they had
  already shot.** `storyboard-episode` accepts either `script-approved.json` or
  `script.status === 'approved'`, but the status reporter checked only the file
  — and `workshop --approve` sets only the status. It now mirrors the real gate.
- A shot whose dialogue object carries an empty line rendered as empty quotes in
  the shot script; it now reads as no dialogue.

## 2.7.0 — 2026-08-05

### Added

- **Wan 3.0** as a selectable video family. It is the only family that renders
  past 15s — the ladder runs 5/10/15/20/25/30s at 480p, 720p, and 1080p, with
  native audio always on and a 9-image reference stack on the R2V lane. It
  accepts no audio input, so projects on Wan 3.0 fall back to Wan 2.7 for exact
  lip-sync.
- Creative references are now shown on the workshop page. Image and video
  references render as an inline gallery in `WORKSHOP.html` (downscaled WebP
  thumbnails embedded as data URIs, so the file stays self-contained; video
  posters come from a frame at 0.5s), and image references become markdown
  embeds in `WORKSHOP.md`. Anything that can't be decoded still lists as a path.
- Setup and workshop questions announce that they are skippable, and each
  optional prompt now shows `[Enter to skip]`.

### Changed

- **Exact lip-sync is family-aware instead of always Wan 2.7.** Seedance 2.x
  and MiniMax H3 both accept a top-level `audio_url` on their R2V lanes, so a
  project on either family now lip-syncs in-family, keeping its full reference
  stack. Only families with no audio-driven lane route out to Wan 2.7.
- The Seedance keyframe pre-pass (rule 32) now runs only for lip-sync models
  that take no reference images. An in-family R2V lip-sync render is one
  generation instead of two, roughly halving the per-shot cost.
- `mustStayAsWanLipSync` is renamed `mustRenderAsExactLipSync`; the old name
  remains as a deprecated alias.
- Wizard, flag, and prompt copy no longer names a specific lip-sync model where
  the model depends on the project's family.

## 2.6.0 — 2026-07-31

### Added

- `venice-video shell` — a persistent interactive session. Commands run without
  a process restart, so the Venice client's rate-limit pacing and caches stay
  warm across a whole production instead of resetting on every invocation.
- A selected project and part. `use <project> [part]` makes `-p` and `-e`
  optional on every command; `unuse` clears it. The selection is stored in user
  config, so it applies to one-shot commands and survives restarts.
- Background commands: suffix any command with `&`, then `/jobs`,
  `/jobs log <id>`, and `/jobs cancel <id>`. Output from a backgrounded render is
  captured to its own buffer rather than sprayed over the prompt.
- `venice-video status` — reports where a project sits in the pipeline and which
  command to run next.
- `venice-video queue` — lists Venice renders left in flight, with `prune` and
  `clear` subcommands.
- Shell conveniences: tab completion for commands, flags, and project slugs; a
  persistent history file; a context-aware prompt; `!<cmd>` passthrough to the
  system shell.

### Fixed

- **Interrupted renders no longer orphan paid work.** Each Venice `queue_id` is
  now recorded to disk *before* polling starts. Re-running a command re-attaches
  to the pending job instead of submitting and billing a second render. Previously
  a Ctrl-C, crash, or dropped connection lost the id while Venice kept charging.
- `Ctrl-C` now cancels the in-flight operation through an `AbortSignal` threaded
  into every Venice request, poll loop, and retry backoff, rather than only
  killing the process between requests.
- Video polling gained an overall timeout and a consecutive-error ceiling, so a
  wedged render fails instead of hanging indefinitely.
- Tests no longer inherit an ambient `VENICE_VIDEO_WORKSPACE`, which could
  silently redirect the projects they create.

## 2.5.3 — 2026-07-31

- Workshop generation now writes a formatted, self-contained `WORKSHOP.html` alongside JSON and Markdown.
- The HTML presents story, inputs, structure, visual language, cast, locations, production plan, references, open questions, and the shot script in a browser-friendly layout.
- The CLI opens `WORKSHOP.html` automatically in the default browser after generation/revision when running interactively; failure to open never fails the workshop.
- Workshop status now lists the HTML path, and all rendered content is HTML-escaped.

## 2.5.2 — 2026-07-31

- The Creative references prompt now says to drag a file or directory into the terminal.
- Dragged quoted paths, escaped spaces, and `~` paths are normalized automatically.
- Reference directories are recursively inventoried (up to 100 files); supported text references are read into workshop context, while image/video/audio paths and metadata are preserved for planning.
- Leaving references or other optional creative fields blank explicitly tells the workshop to propose strong answers from the project concept instead of treating them as missing requirements.

## 2.5.1 — 2026-07-31

- Replaced the vague “What should the finished project accomplish?” workshop prompt with concrete, project-specific audience-outcome questions.
- Film asks what the audience should feel, understand, or keep thinking about when it ends.
- Product video asks what viewers should understand, believe, and do next; music video, screenplay adaptation, and series receive similarly specific questions.
- Added examples directly in the interactive prompt and renamed the noninteractive flag to `--outcome` while retaining `--objective` as a deprecated alias.

## 2.5.0 — 2026-07-31

- Integrated the Topaz 2x/4x video-upscale engine into the standalone CLI.
- Added Standard vs 4K delivery selection to the complete project workshop.
- Added `venice-video finish`, which finds the assembled project master, estimates cost, requires confirmation, and writes a preserved 4K delivery master under `masters/`.
- Added advanced `venice-video upscale` for arbitrary finished video files.
- Large masters are split into upload-safe chunks, processed concurrently and resumably, concatenated without another video encode, and remuxed with the original audio.
- Registered `topaz-video-upscale` in the model catalog and added finishing/delivery regression tests.

## 2.4.4 — 2026-07-31

- Added `venice-video workshop` as the project-level creative control center.
- The workshop develops objective, audience, runtime, logline, synopsis, themes, structure, aesthetic, cast, voices, locations, audio approach, production risks, open questions, and the complete shot script in one coherent process.
- Added structured revision feedback, status inspection, readable `WORKSHOP.md`, and explicit approval that materializes production state.
- Replaced unclear manual command-chain handoffs after `new` and `new-script` with the guided workshop.
- Kept low-level commands as advanced controls rather than the default onboarding experience.

## 2.4.3 — 2026-07-31

- Film projects now use Film/Part terminology in script scaffolding and workshop output instead of Episode language.
- Added `new-script` and `workshop-script` commands while preserving `new-episode` and `workshop-episode` compatibility aliases.
- Film script prompts no longer force 60-second episode timing, one-location structure, cliffhangers, or mandatory episodic title cards.
- Film script templates default to five minutes when no requested duration exists; concepts can request any target duration.

## 2.4.2 — 2026-07-31

- Native dialogue now remains on the selected R2V family and uses Seedance/HappyHorse voice-donor references when available.
- Wan 2.7 routing now requires the explicit Exact lip-sync strategy.
- Reworded the audio wizard to distinguish native voice-reference generation from exact audio-driven mouth movement.
- Reordered model families to Automatic, Seedance, MiniMax H3, HappyHorse, Grok Imagine, Kling O3.

## 2.4.1 — 2026-07-31

- Added an install-time diagnostic that warns when npm's global executable directory is missing from `PATH` and prints the exact shell command to fix it.
- Added README troubleshooting for successful global installs where `venice-video` is not found.

## 2.4.0 — 2026-07-31

First standalone CLI release.

### Added

- Global `venice-video` command that runs without Cursor, Claude Code, OpenCode, MCP, or another agent host.
- `venice-video setup` for validated API-key and workspace configuration.
- `venice-video doctor` plus configuration inspection and cleanup commands.
- Film-first `venice-video new` wizard. Film projects may be any length.
- Explicit project workspaces instead of relying on the current directory.
- Resumable episode production with a standalone vision-QA approval gate.
- Importable TypeScript package surface for the Venice client, model registry, video generation, and series management.
- Packed-artifact tests covering setup, key masking, private file permissions, and Film creation.

### Changed

- Video retrieval now uses the configured Venice client instead of reading the environment directly.
- Sharp updated to 0.35.3 to resolve inherited 2026 libvips vulnerabilities.
- npm artifacts are restricted to compiled output, documentation, and the license.

### Compatibility

- Existing `video-harness` and `storyboard` executable aliases remain available.
- Repository `.env` and `VENICE_API_KEY` workflows remain supported.
- Agent orchestration files remain in the repository but are not included in the npm package.
