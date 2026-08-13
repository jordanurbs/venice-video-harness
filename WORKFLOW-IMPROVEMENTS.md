# Workflow improvement backlog

Notes captured 2026-08-13 during the `il-caso-impossibile` polish pass. Each
item is something we had to hand-fix that the pipeline should ideally prevent or
make cheap. Grouped by theme; **[DONE]** = already shipped this session,
**[TODO]** = to do after the current video wraps. Rough priority in each group.

---

## A. Audio (biggest source of re-work)

- **[TODO] Automated audio QA (`qa-audio`, or fold into `qa-videos`).** Almost
  every audio defect this session was caught by the user, not the pipeline. A
  post-render audio pass should, per shot:
  1. **Transcribe native dialogue (Whisper) and diff against `script` lines** —
     catches (a) the prompt leaking into speech ("the guy says 'theatrical'"),
     (b) truncated lines, (c) wrong/missing lines. This is the single
     highest-value check; it would have caught the two worst audio bugs.
  2. **Detect baked music/score on non-dialogue beats** — Seedance bakes a
     tonal bed/score into native audio despite the no-music suffix + negative
     (confirmed via spectrogram on shot-001: sustained harmonic bands). Flag
     non-dialogue shots whose native track has strong sustained harmonics.
  3. **Detect boundary pops / junk heads** at unit joins (transient spikes).
  Report like `qa-videos`; block/warn on assemble.

- **[TODO] `voiceDescription` must not leak into spoken audio.** Root cause of
  the "theatrical" bug: the full prose `voiceDescription` ("...measured,
  theatrical gravity that cracks into strained...") is injected verbatim into
  the Seedance dialogue bracket `[@ImageN, <voiceDescription>, <delivery>]:` and
  the model vocalizes parts of it. Fixes:
  - **Harness:** add a `compactVoiceDescription()` that keeps only the first
    timbre clause (~50 chars, drop performance verbs / stage directions) and use
    it in the dialogue bracket in `buildVideoPrompt`, `buildMontagePrompt`,
    `buildSeedanceMultiShotPrompt` (and Kling). Same for `delivery` — cap it.
  - **Workshop:** author concise, timbre-only `voiceDescription`s (no "cracks
    into", "theatrical", narrative arcs). Add to the workshop system prompt +
    lint.
  - (This project was fixed by shortening the data value by hand.)

- **[TODO] Default non-dialogue beats to `nativeAudio: 'mute'` (or auto-duck)
  when a post music bed exists.** We hand-muted shots 1 & 2 to kill the baked
  score. The planner could set non-dialogue beats to mute-native-by-default on
  montage/native projects that ship a music bed, since their native track is
  usually just baked ambience/score that fights the post mix. Make it a
  `videoDefaults` toggle.

- **[TODO] Auto-trim Seedance junk heads on single units.** `qa-videos` already
  detects the head luma flash; extend it to trim the first N ms (video+audio)
  off single-shot renders so the de-click isn't the only defense.

- **[DONE] Per-shot `nativeAudio` (mute/duck/keep) now honored in the native
  mix, not just dialogue-replace** (`assembler.ts normalizeClip`).
- **[DONE] De-click fade (20ms in / 40ms out) on every clip at assembly** to
  kill hard-cut pops.

## B. Object cast & props

- **[TODO] Validate object-cast members are actually objects.** `THE PRINTED
  SLIP` shipped with a *person* description ("mid 20s, handsome, strong
  features") and a person age/gender, even though its reference image was a
  correct slip. Lint (workshop + a standalone validator): a cast member whose
  `baseTraits` starts with "inanimate object" (or that is clearly a prop) must
  NOT have person descriptors (human age like "mid 20s", "handsome", gendered
  male/female, "voiceDescription" of a speaking person). Flag / offer autofix.

- **[TODO] Enforce "object cast stays out of locations" BIDIRECTIONALLY.** The
  rule already forbids naming a hero prop in a location's description. But the
  failure here was the reverse + a shot-blocking collision: the location baked a
  *machine* into a "machine alcove", and shot-004's blocking placed the
  object-cast `THE ORACLE` "in the machine alcove" — two different machines in
  one spot, so the slip printed from the wrong one. Improvements:
  - Location features that duplicate an object-cast role (an alcove that IS
    where the Oracle lives) should be **empty stages**; the prop enters via its
    own reference. Detect location `spatialAnchors`/features that are functional
    duplicates of an object-cast noun ("machine alcove" vs `THE ORACLE`).
  - Lint shot blocking that places an object-cast member *inside/at/before* a
    named location feature of the same kind → flag likely conflation.
  - When an object-cast prop is the hero of a shot, make sure its reference
    matches what the location shows (or the location shouldn't show a
    competitor). Consider deriving the prop ref from the location plate when
    they're meant to be the same thing (what we did by hand for the Oracle).

- **[TODO] Lock on-screen TEXT per prop-instance.** `THE PRINTED SLIP` showed
  "4,000,000 USERS. 0 RECORDS." coming out of the machine (shot-010) but "NO
  RECORDS EXIST." when held up (shot-011) — the same physical slip, two texts,
  because the text is baked into each shot's prose independently. For props that
  carry text, track the text as prop state and keep consecutive shots of the
  same instance consistent; QA should flag the same object-cast appearing in
  adjacent shots with different quoted text.

## C. Re-render ergonomics (biggest cost sink)

- **[TODO] Targeted single-shot re-render, montage-aware.** We re-rendered
  `montage-001-004` THREE times because shot-004 lives inside it and there's no
  way to re-render one shot of a montage without re-rendering the whole unit.
  Add `generate-videos --shots <list>` (mirror `storyboard-episode --shots`)
  that re-renders the named shots as **singles** (force out of their montage,
  archive+replace just those cuts) without regrouping/re-rendering neighbors.
  This alone would have saved most of the paid re-renders this session.

- **[TODO] Stable montage grouping / warn on regroup.** Changing a shot's
  `type` (insert→close-up on shot-005) silently regrouped the montage plan
  (005 joined 006-008, 009 split into its own unit), which re-rendered more
  shots than intended and left stale montage masters (`montage-s01-006-009`
  orphaned next to `005-008`/`009-009`). Make `generate-videos` (a) print a
  clear plan diff vs the last `generation-plan.json` and what will re-render,
  and (b) clean up / archive orphaned montage masters that are no longer in the
  plan.

- **[TODO] First-class "omit shot from cut".** To drop the inconsistent shot-009
  we archived its `.mp4`, which has a nasty side-effect: `generate-videos` would
  then re-render that shot's whole montage unit (missing cut). Add a
  `shot.omit` flag (or `assemble-episode --exclude 9`) that drops a shot from
  assembly + FCPXML without deleting the render or triggering a re-render.

- **[TODO] `edit-shot` CLI for trims/omit/native-audio.** trimStart/trimEnd/
  omit/nativeAudio are script fields with no quick setter. A
  `edit-shot -e N --shot K --trim-end 1.2 --omit --native mute` would beat
  hand-patching `script.json`.

## D. QA / verification gaps

- **[TODO] `qa-videos` is visual-only.** It cannot see audio defects (leaks,
  baked music, truncation, pops) — see group A. It also doesn't diff dialogue.
- **[TODO] Truncated-line detector.** shot-004's line ran to the last frame with
  no trailing silence (montage beat too short). A check: native speech energy
  active in the final ~150ms of a cut ⇒ likely truncated ⇒ flag (extend the
  beat / hold the frame / re-render).
- **[TODO] Prompt/description ↔ output text diff for on-screen text** (title
  cards, slips): OCR the rendered text and compare to the intended string.

## F. Timeline export / portability

- **[REVERTED] Relative media paths by default** — briefly shipped
  (`./scene-001/shot-001.mp4` relative to the XML) for cross-machine
  portability, but it broke Final Cut Pro: relative `src` values failed to link
  and relinking errored (FCP effectively wants absolute `file://` paths). The
  default is ABSOLUTE `file://` again. Relative is now OPT-IN via `--relative`
  (still useful for Resolve/Premiere); `--absolute` is the explicit default.
  Cross-machine portability is handled by FCP's File > Relink Files > Original
  Media (Locate All at the folder) until `--bundle` lands.
- **[DONE] Contiguous frame-accurate spine** — clip offsets accumulate in
  integer frames so clip N+1's offset == clip N's offset + duration exactly, in
  all three exporters. Fixes the ~1-frame black gap that appeared at every cut
  from independently rounding offset vs duration.
- **[DONE] Clip audio at 0dB in exports** (was `-96dB`, which muted native
  audio on import). **[TODO]** make the clip mute conditional — only mute a clip
  when a lane-1 dialogue clip replaces it (Venice-TTS dialogue-replace projects),
  otherwise 0dB; today it's unconditionally 0dB.
- **[TODO] Optional media-bundling export** — a `export-timeline --bundle`
  that copies the referenced clips + audio next to the XML into a single
  self-contained folder (or zips it) for handoff. This is the durable
  portability answer now that relative-by-default is reverted.

## E. Location references (mostly shipped)

- **[DONE] Anchor→derive location angles** (one wide hero plate; angle-2/3/4
  are multi-edits of it) — replaced the wide/medium/detail ladder that produced
  three different rooms. See AGENTS.md rule 56.
- **[DONE] Storyboard plates off by default** (`useStoryboardPlates`).
- **[TODO] Real-photo / harvested location anchor** — `add-location --wide
  <file>` to import a real establishing photo (or a harvested frame) as the wide
  plate, then derive angles from it (the location analog of `harvest-anchor`).
- **[TODO] Smarter per-shot location angle selection** — pick the derived angle
  whose facing best matches the shot's blocking, and consider sending fewer
  location refs per shot to reduce conflicting signal.

---

## Meta-lesson

The recurring theme: **defects surfaced only when a human watched the cut.**
Most of group A/B/D is about giving the pipeline eyes and ears (audio QA,
dialogue diff, object-cast validation, text OCR) so these are caught before a
paid render/assembly, and group C is about making the inevitable fixes cheap
(single-shot re-render, omit flag) instead of full-montage re-rolls.
