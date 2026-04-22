---
name: video-editing
description: This skill should be used whenever the task is to edit existing video/audio files — re-cutting a generated episode, trimming filler from a VO take, editing raw footage into a delivered cut, or rescuing a truncated TTS render. It codifies the "text + on-demand visuals" philosophy adapted from browser-use/video-use, defines the EDL (edit decision list) format used by the harness, and specifies the ask-confirm-execute-self-eval loop. This is NOT the generation pipeline — when the task is to synthesize new shots from prompts, use the venice-video-model-routing and character-consistency skills instead.
metadata:
  requires:
    bins: ["ffmpeg", "ffprobe", "whisper-cpp", "node", "tsx"]
---

# Video Editing Pipeline

Parallel pipeline to the generation side of the harness. The generation pipeline **synthesizes** shots; this pipeline **cuts** already-existing media. They share ffmpeg and the burn-in-subtitles skill but are otherwise independent.

## When to Reach For This Skill

Use the editing pipeline when the task involves **existing media on disk**:

- Re-cutting a Venice-generated episode because the pacing reads too long
- Trimming umms/uhs/false-starts out of a talking-head VO take
- Editing user-supplied raw footage (interview b-roll, phone takes, screen recordings) into a final cut
- Rescuing a TTS render that truncated mid-script (doubled-ellipsis bug, rule 26)
- Stitching pre-generated shots in a different order than the original storyboard

Do **not** reach for this skill when the task is "generate a new shot", "create a storyboard panel", or "render a video from a prompt". Those go through `generate-episode-videos`, `storyboard-episode`, or `produce-episode`.

## Core Philosophy: Text + On-Demand Visuals

The LLM reads a 12KB `takes_packed.md` file — NOT the video itself. Pixels are only consulted at explicit decision points via `scripts/timeline-view.ts`.

Naive approach: 30 min of footage at 24fps = 43,200 frames × ~1,500 tokens each = **64M tokens of noise**. This pipeline: **12KB of text + a handful of composite PNGs**.

Same principle as giving an LLM a DOM rather than a screenshot. The transcript is the ground truth; visual sampling is only for ambiguous cuts, retake comparisons, and post-render QA.

## The Five Steps

```
1. Transcribe   -> per-source words.json + takes_packed.md
2. Read pack    -> LLM forms a cut strategy
3. Confirm      -> propose strategy, WAIT for user OK
4. Render EDL   -> ffmpeg concat + 30ms audio fades
5. Self-eval    -> cut-qa agent runs timeline_view at every cut boundary
   -> pass: deliver final-edit.mp4
   -> fail: propose fixes, re-render, loop (max 3 iterations)
```

### Step 1 — Transcribe

```bash
npx tsx scripts/transcribe-sources.ts \
  --dir output/<project>/shots \
  --out output/<project>/edit/takes_packed.md \
  --model base.en
```

Flags:

- `--model` — `base.en` is the default (fast, accurate enough for editing decisions). Use `small.en` for noisier real footage or `large` when the clip has accents / domain jargon.
- `--language` — `auto` by default; force to `en`/`es`/etc for speed.
- `--include` — glob list, defaults to common audio+video extensions.
- `--aligned-from <file>` — if the project has a canonical `VO_TEXT` script (TTS-generated content), pass the config file and the pack will use ground-truth words rather than whisper's best guess. Automatically detects truncation.
- `--speaker-map <file>` — JSON `{"<basename>": "CharacterName"}` to label each source's speaker. Defaults to `S0` single-speaker.

After transcription, the edit dir contains one `*.words.json` per source (programmatic consumers) plus `takes_packed.md` (LLM-readable).

### Step 2 — Read the Pack

`takes_packed.md` format:

```
## C0103  (duration: 43.0s, 8 phrases)
file: shot-001.mp4

  [002.52-005.36] Chad Ninety percent of what a web agent does is completely wasted.
  [006.08-006.74] Chad We fixed this.
  [007.12-009.40] Chad Here's what that looks like in production.
```

Read the whole pack. Identify:

- **Takes that overlap in content** (retakes — pick the best one)
- **Filler words and dead air** (candidate trims)
- **VO truncation** (warnings already flagged by the transcriber in aligned mode)
- **Cut candidates** — silence gaps ≥ 0.45s are natural cut points

Only call `timeline-view` at **decision points** — comparing two retakes, checking whether a particular pause is an intended beat or a dead one, verifying mouth-close on the last frame of a talking-head clip before a cut.

```bash
# Only run this when the text alone cannot resolve the decision.
npx tsx scripts/timeline-view.ts \
  --video output/<project>/shots/shot-003.mp4 \
  --start 12.3 --end 16.1 \
  --words output/<project>/edit/shot-003.words.json \
  --out /tmp/tl-shot-003.png
```

### Step 3 — Confirm the Strategy

Before any rendering, **propose a cut strategy and wait for user confirmation**. Include:

- Which sources will appear in the final cut
- Estimated output duration
- Trim and filler-removal rules being applied
- Transition strategy (hard cuts vs crossfades)
- Color grade (if any)
- Subtitle plan (always defer to `burn-in-subtitles` skill — ask yes/no first)

Do not touch the render until the user says go. Mirrors `video-use` design principle 3: "Ask → confirm → execute → self-eval → persist."

### Step 4 — Render the EDL

An EDL is a JSON document (`src/editing/types.ts → Edl`) the LLM authors and mutates through iterations. It is NOT a proprietary tool format — think of it as a cut list with enough metadata for ffmpeg to concat faithfully.

Minimum viable EDL:

```json
{
  "clips": [
    { "sourceId": "C0A31", "startSec": 2.52, "endSec": 6.74, "rationale": "Chad intro + hook" },
    { "sourceId": "C0B55", "startSec": 0.00, "endSec": 4.20, "transitionIn": "crossfade", "transitionMs": 250 },
    { "sourceId": "C0A31", "startSec": 12.30, "endSec": 18.90 }
  ],
  "audioFadeMs": 30,
  "output": {
    "videoCodec": "libx264",
    "audioCodec": "aac",
    "crf": 18
  }
}
```

The harness renderer (`src/editing/render.ts`) turns this into an `ffmpeg concat` with 30ms audio fades at every cut boundary (video-use's "no pops" rule).

Archive-first per workspace rule `.cursor/rules/shot-asset-safety.mdc`: if `final-edit.mp4` already exists, it is renamed to `final-edit-v1.mp4` before the new render lands.

### Step 5 — Self-Eval via cut-qa

After the render, spawn the `cut-qa` agent (see `.claude/agents/cut-qa.md`). It checks:

| Check | Trigger |
|-------|---------|
| Visual jump at cut | Frame hash-diff between last frame of clip N and first of N+1 |
| Aspect regression | `ffprobe` resolution vs series `storyboardAspectRatio` |
| Subtitle overlap with in-frame text | OCR on frames where captions are visible |
| VO truncation | Ground-truth script alignment vs final audio |
| Lighting discontinuity | Mean-luma delta across cut boundaries |
| Audio pops | Peak-detection at cut boundaries minus the 30ms fade window |

On failure: cut-qa proposes specific EDL edits. Re-render. Max 3 iterations before surfacing to the user.

## EDL Authoring Rules

- **`sourceId` must exist in the pack.** Use the `C####` id from `takes_packed.md`, not the file path.
- **`startSec` / `endSec` are in source time**, not trailer time.
- **Use `rationale` liberally.** The next iteration of the agent reads it to understand prior choices.
- **Default transitions are hard cuts** (`"transitionIn": "cut"`). Only add crossfades when there's an aesthetic reason — cut-qa flags unmotivated fades as clutter.
- **Never author negative durations** or `startSec >= endSec`. The renderer will throw.
- **Filler-word trims go in `trimStartMs` / `trimEndMs`** as fractional-second offsets, not as extra clips. Keeps the cut list readable.

## Filler-Word Detection

`src/editing/silence.ts` pairs `ffmpeg silencedetect` with a filler-word word-list (`umm`, `uh`, `like`, `you know`, `i mean`). The LLM proposes trims; the user confirms before they land in the EDL. Never trim filler words the user has not approved — some speakers use "you know" as an intentional rhetorical device.

## Interaction With Other Skills

- **`burn-in-subtitles`** — after the edited cut is locked, this skill hands off to `burn-in-subtitles` for caption derivation. Always ask "burn in subtitles? yes/no" before invoking.
- **`venice-video-model-routing`** — this skill does NOT generate new shots. If the strategy requires a shot that does not exist (e.g. a reaction cutaway the user did not record), that's a generation task — switch to the generation pipeline, render the shot with Seedance R2V, then come back here to splice it in.
- **`character-consistency`** — N/A for pure editing (the footage is already shot). Relevant only when an editing session has to generate a new insert shot mid-flow.
- **`shot-composition`** — useful when proposing re-orderings: do not cut from a close-up to an identical close-up (anti-pattern: jump cut by accident).

## Session Persistence

Each edit session writes `output/<project>/edit/session.json` (`EditSession` in `types.ts`) with:

- `takesPackPath`
- The current `edl`
- Every `CutQaReport` from each iteration

Analogous to video-use's `project.md` persistence: resuming an editing session next week picks up where the last one ended, including prior cut-qa findings so the agent doesn't re-relitigate resolved issues.

## Anti-Patterns (Editing-Specific)

### E1. Hand-Estimating Cuts From Timestamps You Guessed

Symptom: agent picks `endSec` values that don't align with actual word boundaries, producing cuts that clip off syllables.
Fix: ALWAYS source `startSec` / `endSec` from the `takes_packed.md` phrase boundaries or from `*.words.json`. Never invent a timestamp.

### E2. Removing "..." Filler From Kokoro VO Takes

Symptom: agent sees `...` in a Kokoro-generated VO and trims it as dead air.
Fix: Kokoro renders `...` as an intentional breath gap. These are beats, not filler. The filler-word trimmer ignores them by default.

### E3. Crossfade on Every Cut

Symptom: agent defaults to `"transitionIn": "crossfade"` for every clip, producing a soupy, unfocused cut.
Fix: default to hard cuts. Crossfades communicate "same scene, time passes". Use rarely and intentionally.

### E4. Re-Rendering The Whole Edit to Fix One Clip

Symptom: cut-qa flags a clip; agent re-renders the full 15-minute cut just to patch 2 seconds.
Fix: `src/editing/render.ts` supports `--only-clip N` to re-render a single clip and patch it into the existing concat. Use it for iteration loops.

### E5. Deleting A Source File Mid-Session

Symptom: agent decides a source is unusable and deletes it.
Fix: **never delete generated shot files** (workspace rule `shot-asset-safety.mdc`). Exclude from the EDL instead; if truly needed, archive under `<source>-v1.<ext>`.

### E6. Skipping User Confirmation "Because It's Obvious"

Symptom: agent sees a clear cut strategy and renders without asking.
Fix: ALWAYS propose-then-confirm. The render is cheap; regenerating a 20-minute cut because you guessed wrong about intent is not. Video-use design principle 3 is non-negotiable.

## Quick Reference

| Step | Command / Artifact |
|------|---------------------|
| Transcribe | `npx tsx scripts/transcribe-sources.ts --dir <sources> --out <edit>/takes_packed.md` |
| Read pack | Read `takes_packed.md` |
| Inspect cut candidate | `npx tsx scripts/timeline-view.ts --video <file> --start X --end Y --words <f>.words.json --out /tmp/tl.png` |
| Propose strategy | Markdown summary → AskQuestion for confirmation |
| Render | EDL → `src/editing/render.ts` → `final-edit.mp4` |
| Self-eval | `cut-qa` agent → `CutQaReport[]` in `session.json` |
| Subtitles | Hand off to `burn-in-subtitles` skill |

## See Also

- `.claude/skills/burn-in-subtitles/SKILL.md` — downstream captioning
- `.claude/skills/venice-video-model-routing/SKILL.md` — generation side for insert shots
- `.claude/agents/cut-qa.md` — post-render QA agent
- `.claude/commands/edit-footage.md` — end-to-end playbook
- `src/editing/types.ts` — EDL, Take, EditSession type definitions
- `.cursor/rules/shot-asset-safety.mdc` — archive-first rule
