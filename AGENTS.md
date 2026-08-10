# Venice Video Harness

This workspace is an agent-first, Venice-optimized harness for **consistency-first video creation at any length and format**.

It is meant to be operated through natural language by any coding agent (opencode, Claude Code, Cursor, Codex, etc.). The user should not be asked to run terminal commands manually. The agent reads the rules, selects the right playbooks, and executes code as needed.

The shared `VENICE_API_KEY` lives in `.env` and is sourced by many scripts: do not move or rename `.env`.

## What This Harness Does

1. Helps an agent plan and execute consistency-first Venice video workflows
2. Supports recurring characters, locked visual systems, and reference-driven generation
3. Provides reusable orchestration through `AGENTS.md` plus the playbooks, sub-agent definitions, and skills in `.agents/` (provider-neutral markdown — usable by any coding agent, renamed from `.claude/` in 2.14.0)
4. Includes a comprehensive model registry covering 50+ Venice video, image, audio, and music models
5. Includes a working narrative reference implementation in `src/mini-drama/`
6. Preserves generated media by archiving instead of destructively replacing

## Supported Use Cases

This harness is not limited to any single video format. It supports:

- **Episodic series** (drama, comedy, documentary, educational)
- **Trailers and teasers**
- **Branded cinematic sequences**
- **Product launch videos**
- **Recurring-character social content**
- **Narrative explainers**
- **Style-locked creative campaigns**
- **Long-form content** (assemble multi-shot sequences of any length)
- **Any Venice workflow where visual continuity matters**

## How To Operate

The intended interface is:
- Natural-language requests to the agent
- Orchestration rules in `AGENTS.md`
- Workflow playbooks in `.agents/commands/`
- Reusable Venice knowledge in `.agents/skills/`
- Underlying TypeScript and script execution in `src/` and `scripts/`

The CLI and scripts are the execution layer underneath the harness, not the primary user interface.

For a human driving the CLI directly, `venice-video shell` opens a persistent
session: `use <project> [part]` selects a project once and every command then
defaults `-p` / `-e` to it, `&` backgrounds a render, `/jobs` inspects those
background commands, and `status` reports the pipeline stage plus the next
command to run. The selection lives in user config, so an agent shelling out to
one-shot commands inherits it — always pass `-p` explicitly rather than relying
on whatever the user happens to have selected.

## Venice API Coverage

### Video Endpoints

| Endpoint | Purpose | Module |
|----------|---------|--------|
| `POST /video/queue` | Queue video generation | `src/venice/video.ts` |
| `POST /video/retrieve` | Poll/download result | `src/venice/video.ts` |
| `POST /video/quote` | Get cost estimate | `src/venice/video.ts` |
| `POST /video/complete` | Cleanup after download | `src/venice/video.ts` |

### Image Endpoints

| Endpoint | Purpose | Module |
|----------|---------|--------|
| `POST /image/generate` | Text-to-image | `src/venice/generate.ts` |
| `POST /image/multi-edit` | Layered multi-image editing | `src/venice/multi-edit.ts` |
| `POST /image/upscale` | AI upscaling | `src/venice/edit.ts` |
| `POST /image/background-remove` | Background removal | `src/venice/edit.ts` |
| `POST /images/edit` | **DEPRECATED** (May 2025) | `src/venice/edit.ts` |

### Audio Endpoints

| Endpoint | Purpose | Module |
|----------|---------|--------|
| `POST /audio/speech` | Text-to-speech (Kokoro, Qwen3) | `src/venice/audio.ts` |
| `POST /audio/queue` | Queue music/SFX generation | `src/venice/audio.ts` |
| `POST /audio/retrieve` | Poll/download audio result | `src/venice/audio.ts` |
| `POST /audio/complete` | Cleanup after download | `src/venice/audio.ts` |

### Chat Endpoint

| Endpoint | Purpose | Module |
|----------|---------|--------|
| `POST /chat/completions` | Vision-based QA, script generation | `src/venice/client.ts` |

## Model Registry

The full model registry lives in `src/venice/models.ts` with typed specs for every model. Key categories:

### Video Models (50+ models)

**Action / Movement / Dialogue:**
- `kling-v3-pro-image-to-video` (3-15s, audio, `end_image_url`)
- `kling-o3-pro-image-to-video` (3-15s, audio, `end_image_url`)
- `kling-2.6-pro-image-to-video` (5-10s, audio, `end_image_url`)
- `wan-2.6-image-to-video` (5-15s, 1080p, audio, `audio_url` input)
- `sora-2-pro-image-to-video` (4-12s, 1080p, audio)

**Atmosphere / Establishing / Mood:**
- `seedance-2-0-enhanced-reference-to-video` (default for ALL lanes since 2026-07-30 — atmosphere shots anchor to location refs via `@Image` tags)
- `seedance-2-0-image-to-video` (4-15s, 720p, native stereo audio — legacy atmosphere default)
- `veo3.1-fast-image-to-video` (4-8s, up to 4K, audio)
- `veo3-fast-image-to-video` (8s, audio)
- `pixverse-v5.6-image-to-video` (5-8s, up to 1080p, audio)

**Character Consistency (Reference-to-Video):**
- `seedance-2-0-enhanced-reference-to-video` (**THE default for all three lanes** — action, atmosphere, character. 4-15s, 1080p-capable, `reference_image_urls` up to **9**, `@Image` tags, `reference_audio_urls`, native audio, ~1.5x standard R2V price. Delisted from GET /models but live on queue/quote.)
- `seedance-2-0-reference-to-video` (standard R2V, 4-15s, `reference_image_urls` up to 9, `@Image` tags, native audio)
- `happyhorse-1-1-reference-to-video` (R2V, 3-15s, `reference_image_urls` up to 9, per-reference audio, phoneme-level lip-sync)
- `minimax-h3-reference-to-video` (R2V, **5-15s**, `reference_image_urls` up to 9, `audio_url` input, native stereo audio, **2K only**)
- `kling-o3-standard-reference-to-video` (fallback only when characters alone overflow the 9-ref budget; 3-15s, `elements`, `reference_image_urls`, `scene_image_urls`)
- `kling-o3-pro-reference-to-video` (3-15s, full reference support)

**MiniMax H3 (open-weight omni-modal, added 2026-07-31):**
- `minimax-h3-text-to-video` / `minimax-h3-image-to-video` / `minimax-h3-reference-to-video`
- One model covers T2V, I2V, and multimodal reference, with native stereo audio in the render. 24fps, 2500-char prompt limit.
- **2K is the only resolution.** `resolution: '720p'` is a hard HTTP 400 — there is no cheap draft tier, so every H3 take is a finish-quality spend. The generator pins `resolution: '2K'` for any `minimax-h3-*` model.
- **The duration ladder starts at 5s.** 3s and 4s both 400. Script H3 episodes on a 5-15s grid; the duration preflight rejects off-ladder shots before anything is queued.
- Pricing at time of sync: $0.81 for 5s, $2.44 for 15s (~$0.16/s at 2K) — roughly a third of what the other families cost per second.
- `audio` is not configurable (like HappyHorse), so the generator omits the field entirely.
- i2v inherits aspect from the start image and exposes no `aspect_ratios`; t2v and R2V accept `16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9`.
- **R2V is pure-reference-only.** Sending `image_url` (or `end_image_url`) alongside `reference_image_urls` is a hard 400: *"image_url and end_image_url cannot be combined with reference media for this model."* `minimax-h3-reference-to-video` is therefore in `MODELS_USING_IMAGE_TAGS`, which is what puts the generator in pure reference mode. It honors `@ImageN` tags — verified by paid render, both tagged characters landed on their assigned `@Image1` / `@Image2` slots.
- **Reference aspect influences output orientation, so keep a 16:9 plate in the stack.** With the harness's normal slot plan (1:1 character sheets + the 16:9 storyboard blocking plate) and `aspect_ratio: '16:9'`, a paid render returned a true 2560×1440. But a stack of uniformly portrait references returned 1440×1920 *despite* `aspect_ratio: '16:9'` — the requested ratio did not override them. Character-only H3 shots with no blocking plate are the orientation risk; check the first-frame contact sheet before assembling.

**Long Duration:**
- `longcat-image-to-video` / `longcat-distilled-image-to-video` (up to **30s**, no audio)
- `ltx-2-fast-image-to-video` / `ltx-2-v2-3-fast-image-to-video` (up to **20s**, up to 4K)
- `ltx-2-19b-full-image-to-video` (up to **18s**, audio)

**Budget / Fast:**
- `wan-2.6-flash-image-to-video` (5-15s, fast)
- `kling-v3-standard-image-to-video` (3-15s)
- `grok-imagine-image-to-video` (5-15s)

### Video Model Capabilities

| Capability | Models |
|-----------|--------|
| `elements` (structured @Element refs) | Kling O3 R2V (standard + pro) |
| `reference_image_urls` (flat ref array) | Seedance 2.0 R2V family (**up to 9**), HappyHorse 1.1 R2V (**up to 9**), MiniMax H3 R2V (**up to 9**), Kling O3 R2V, Vidu Q3 (legacy 4-image budget elsewhere) |
| `scene_image_urls` (environment refs) | Kling O3 R2V (standard + pro) |
| `end_image_url` (frame targeting) | All Kling image-to-video, PixVerse Transition |
| `audio_url` (background audio input) | Wan 2.6, Wan 2.5 Preview, Seedance 2.0 R2V family, MiniMax H3 R2V |
| `reference_audio_urls` (voice-donor clips, @AudioN) | Seedance 2.0 R2V / Enhanced R2V / Fast R2V, HappyHorse 1.1 R2V (≤3 clips, 2-15s each, ≤15s aggregate, needs ≥1 reference image) |
| `@Image` tags (flat ref prompt syntax) | Seedance 2.0 R2V, Grok Imagine R2V |
| Native stereo audio with lip-sync | Seedance 2.0 (8+ languages) |
| Native stereo audio, not toggleable | HappyHorse 1.1, MiniMax H3 (omit the `audio` field or the request 400s) |
| 2K output | MiniMax H3 (2K is its ONLY resolution) |
| 4K output | Veo 3.1, LTX 2.0 |
| 30s duration | Longcat |
| 20s duration | LTX 2.0 Fast, LTX 2.0 v2.3 Fast |
| 15s duration | Seedance 2.0, Kling O3/V3, Wan 2.6 |

### Image Generation Models

`nano-banana-pro` (default for storyboard), `nano-banana-2`, `gpt-image-2` (high-quality alternative to nano-banana-pro), `gpt-image-1-5`, `flux-2-pro`, `flux-2-max`, `grok-imagine`, `hunyuan-image-v3`, `qwen-image-2`, `qwen-image-2-pro`, `recraft-v4`, `recraft-v4-pro`, `seedream-v4`, `seedream-v5-lite`, `chroma`, `hidream`, and more.

### Multi-Edit Models (10 models)

`qwen-edit`, `qwen-image-2-edit`, `qwen-image-2-pro-edit`, `flux-2-max-edit`, `gpt-image-2-edit` (high-quality alternative to nano-banana-pro-edit), `gpt-image-1-5-edit`, `grok-imagine-edit`, `nano-banana-2-edit`, `nano-banana-pro-edit`, `seedream-v4-edit`, `seedream-v5-lite-edit`

### TTS Models

- **Kokoro** (`tts-kokoro`): 50+ voices across English, Chinese, Japanese, Korean, Spanish, French, Hindi, Italian, Portuguese
- **Qwen3** (`tts-qwen3-0-6b`, `tts-qwen3-1-7b`): Style-prompted voices (Vivian, Serena, Dylan, Eric, Ryan, Aiden, etc.) with emotion/delivery control
- **ElevenLabs** (`elevenlabs-tts-v3`, `elevenlabs-tts-multilingual-v2`): Premium TTS

### Music / SFX Models

- **Music**: `elevenlabs-music`, `minimax-music-v2`, `minimax-music-v25`, `minimax-music-v26`, `lyria-3-pro`, `ace-step-15`, `stable-audio-25`
- **Expressive speech / prompt-driven audio**: `seed-audio-1-0` (BytePlus Seed Audio 1.0 — `music`-type async model with 25 named voices, speed 0.5–2, 2048-char prompt; premium prompt-directed narration/VO). Generate with `generate-audio --prompt … [--voice … --speed … --out …]`, or pass `--model seed-audio-1-0 --voice … --speed …` to `generate-music`.
- **SFX**: `elevenlabs-sound-effects-v2`, `mmaudio-v2-text-to-audio`

## Default Venice Routing

**Core principle (reference-first, default model Seedance 2.5 as of 2026-08-07): Seedance 2.5 R2V (`seedance-2-5-reference-to-video`) for ALL lanes — action, atmosphere, and character. Every shot renders in pure reference mode (no start image) from an `@Image` slot plan: character sheets, storyboard blocking plates, and multiple location angles (up to 30 refs on Seedance 2.5). Scenes ship as ONE Seedance 2.5 single-pass generation by default — the montage lane up to 30s (rule 50), or a native multi-shot up to 15s when montage is off — NOT as hand-stitched bundles. Seedance 2.0 R2V Enhanced (the prior default; 1080p-capable) is still registry-known and selectable via `videoDefaults`.**

Every shot uses reference-to-video for consistency. Seedance 2.0 R2V Enhanced is the default for all three lanes, using flat `reference_image_urls` with `@Image` prompt tags allocated by the central slot planner (`src/mini-drama/reference-slots.ts`): (1) one primary angle per character, (2) the beat's storyboard blocking plate (PROTECTED — shows where characters stand in the location relative to each other), (3) location angles wide→medium→detail, (4) second character angles. Overflow drops second character angles first, then trailing location angles; plates are dropped last. The Kling O3 fallback now fires only when the character count alone would overflow the 9-ref budget (7+ characters), not at 3+. Empty establishing/mood shots also run R2V, anchored to location refs.

**Scene-level default: Seedance native multi-shot.** When a scene comprises 2–3 consecutive beats of the same character (or pairwise-overlapping characters) in a continuous action, **always render the whole scene as a single Seedance R2V generation up to 15s with `Lens switch.` separators between beats** — not as separate renders concatenated at assembly time. Identity, environment, lighting, and voice-donor references hold across the lens switches inside a single generation; separate renders drift between cuts even with the same refs. Cost is also 3× lower and wall-clock is faster. The planner should bundle beats by default and only split when (a) the project explicitly selected exact lip-sync and a beat needs Wan 2.7 driven by a specific dialogue MP3; (b) beats span different locations or non-overlapping character pools; or (c) total runtime exceeds 15s. See rule 21.

Preferred defaults (overridable per-project via `series.json` → `videoDefaults`):

| Role | Default Model | When Used |
|------|--------------|-----------|
| Character shots (up to ~6 characters) | `seedance-2-5-reference-to-video` | Default R2V — up to 30 `reference_image_urls` with `@Image` tags (chars + storyboard plate + location angles), pure reference mode (no start image), every integer 4-30s, 480p/720p (harness pins 720p), native stereo audio |
| Character shots (budget overflow) | `kling-o3-standard-reference-to-video` | Auto-fallback — structured `elements` + `reference_image_urls`. Rare on 2.5's 30-ref budget; kept for extreme character counts / scene-image needs |
| Native character dialogue | `seedance-2-5-reference-to-video` | Default. Generates the authored line in-frame; `reference_audio_urls` voice donors preserve timbre/accent/pacing. Native mouth sync is prompt-driven, not deterministic to an exact supplied recording. |
| Exact lip-sync, low/medium motion | `resolveLipSyncModel(family)` | Only when `audioStrategy: lip-sync`. Venice speech drives mouth movement through `audio_url`; min 3s audio. Stays in-family on Seedance (`seedance-2-5-reference-to-video`) and MiniMax H3 (`minimax-h3-reference-to-video`), both of which accept a top-level `audio_url`. Other families fall back to `wan-2-7-image-to-video`, which needs a keyframe from a Seedance R2V identity pass (rule 32). |
| Native/high-motion dialogue | `seedance-2-5-reference-to-video` | Preserves identity across large motion with native prompt-driven dialogue and voice references; does not follow an exact dialogue audio file. |
| Multi-character dialogue shot | `wan-2-7-reference-to-video` | `per_reference_audio` — each `elements[].audio_url` drives a different speaker's mouth. Max 10s. |
| Establishing / mood / action (no chars) | `seedance-2-5-reference-to-video` | Anchors to location reference angles via `@Image` tags; pure reference mode. (`seedance-2-0-image-to-video` remains available for panel-anchored work.) |
| Image Generation (all panels) | `nano-banana-2` | Global default for character AND faceless panels. Seedance no longer restricts face-bearing input to seedream (see below). `gpt-image-2` / `nano-banana-pro` are high-quality alternatives with sharper typography |
| Multi-Edit (all panels) | `nano-banana-2-edit` | Global default for character fixes and style-match. `gpt-image-2-edit` is a high-quality alternative |
| TTS | `tts-kokoro` | 50+ voices, fast, consistent |
| Music | `elevenlabs-music` | High quality music generation |
| Expressive speech / audio | `seed-audio-1-0` | Prompt-directed narration/VO with named voices + speed (async queue) |
| SFX | `elevenlabs-sound-effects-v2` | Best sound effect quality |

### Image / Video Family Pairing

**Venice removed the Seedance seedream-only face restriction (2026-07).** Seedance 2.0 previously rejected face-bearing input images that weren't produced by `seedream-v5-lite` / `seedream-v5-lite-edit`; it now accepts face-bearing images from **any** image family. The harness therefore uses a single high-quality default — `nano-banana-2` — for every panel, character-bearing or faceless, generation and multi-edit alike. Override per-series via `videoDefaults.imageDefaults.generationModel` / `editModel`.

### Seedance Pre-flight Gate (neutralized)

The former provenance-driven pre-flight gate is a **no-op** as of 2026-07. Because Seedance accepts any image family, there is nothing to validate, reroute, or launder before a Seedance call — `ensureSeedanceCompatibility()` (`src/venice/seedance-preflight.ts`) always proceeds, and `series.videoDefaults.seedanceCompatibility` is no longer auto-set. Provenance sidecars (`shot-NNN.provenance.json`) are still written as harmless metadata (they still record `hasFace` for other tooling), but nothing gates on them anymore.

> Note: the Seedance face **consent** attestation (HTTP 409 `needs_consent`, handled at queue time) is a separate mechanism and is unaffected.

The provenance sidecar format is `shot-NNN.provenance.json` next to each PNG:

```json
{
  "generationModel": "nano-banana-2",
  "editModels": ["nano-banana-2-edit"],
  "hasFace": true,
  "createdAt": "...",
  "updatedAt": "..."
}
```

The storyboard assembler, panel-fixer, reference-manager, and mini-drama panel generator all write this automatically. Images without sidecars (e.g. old assets from before this change) are treated as "unknown" and will trigger the pre-flight gate so the user can decide whether they have faces. If you know an existing image has no face, you can hand-edit the sidecar to set `"hasFace": false` and it will pass.

## Video Queue Request Parameters

The full request schema for `POST /api/v1/video/queue`:

```json
{
  "model": "kling-v3-pro-image-to-video",
  "prompt": "A slow dolly shot pushes forward...",
  "duration": "8s",
  "image_url": "data:image/png;base64,...",
  "end_image_url": "data:image/png;base64,...",
  "negative_prompt": "low quality, blurry",
  "aspect_ratio": "9:16",
  "resolution": "1080p",
  "audio": true,
  "audio_url": "data:audio/mpeg;base64,...",
  "video_url": "data:video/mp4;base64,...",
  "reference_image_urls": ["data:image/png;base64,..."],
  "elements": [
    {
      "frontal_image_url": "data:image/png;base64,...",
      "reference_image_urls": ["data:image/png;base64,..."],
      "video_url": "data:video/mp4;base64,..."
    }
  ],
  "scene_image_urls": ["data:image/png;base64,..."]
}
```

**Parameter availability is model-dependent.** The harness automatically skips unsupported params per model. Use `getVideoModel()` from `src/venice/models.ts` to check capabilities.

## Editing Pipeline

Parallel to the generation pipeline. The generation pipeline **synthesizes** shots from prompts; the editing pipeline **cuts** already-existing media (either Venice-generated or user-supplied raw footage). They share ffmpeg and the burn-in-subtitles skill but are otherwise independent.

Inspired by [browser-use/video-use](https://github.com/browser-use/video-use), the editing pipeline adopts the "text + on-demand visuals" philosophy: the LLM reads a compact `takes_packed.md` transcript rather than frame-dumping the video, and only calls `timeline-view` composite PNGs at explicit decision points.

### When To Reach For Editing vs Generation

| Task | Pipeline | Entry Point |
|------|----------|-------------|
| Synthesize new shots from prompts | Generation | `/produce-episode`, `/generate-episode-videos` |
| Re-cut a generated episode for pacing | Editing | `/edit-footage` |
| Trim filler words from a VO take | Editing | `/edit-footage` |
| Edit raw user-supplied footage | Editing | `/edit-footage` |
| Rescue a truncated TTS VO | Editing | `/edit-footage` |
| Add branded lower-thirds / title cards | Editing | `overlay-designer` agent |
| Post-assembly QA on any rendered video | Editing | `cut-qa` agent |

### The Five Steps

1. **Transcribe** via local `whisper-cpp` → per-source `*.words.json` + `takes_packed.md` pack
2. **Read pack** — LLM forms a cut strategy from text
3. **Confirm** — propose strategy to user, wait for yes
4. **Render EDL** — JSON cut list → ffmpeg concat with 30ms audio fades (archive-first)
5. **Self-eval** — `cut-qa` agent runs 6 programmatic checks at every cut boundary; max 3 fix iterations

### Required Tools

- `whisper-cpp` on PATH (`brew install whisper-cpp`) for transcription
- A whisper.cpp model at `~/.cache/whisper.cpp/ggml-base.en.bin` (or `$WHISPER_CPP_MODELS_DIR`)
- `sharp` npm dep (included) for the timeline_view composite
- All other requirements come from the generation pipeline

### Key Files

- `.agents/skills/video-editing/SKILL.md` — full philosophy, EDL format, anti-patterns
- `.agents/commands/edit-footage.md` — end-to-end playbook
- `.agents/agents/cut-qa.md` — post-render quality gate
- `.agents/agents/overlay-designer.md` — branded motion-graphics planner
- `src/editing/` — type definitions, packer, aligner, EDL renderer, self-eval
- `scripts/transcribe-sources.ts` — transcription CLI
- `scripts/timeline-view.ts` — filmstrip + waveform + word-labels composite
- `scripts/render-overlay.ts` — overlay compositing

## Architecture

```
src/
  venice/           Venice API client layer (model-agnostic)
    client.ts       HTTP transport with retries and rate limiting
    models.ts       Complete model registry with capabilities
    video.ts        Video queue/retrieve/quote/complete
    generate.ts     Image generation
    multi-edit.ts   Multi-image layered editing
    edit.ts         Upscale, background remove
    audio.ts        TTS, music, SFX, queued audio
    voices.ts       Voice catalog (Kokoro + Qwen3)
    types.ts        Full API type definitions
  series/           Project state and character management
    types.ts        Character, ShotScript, SeriesState types
    manager.ts      Create/load/save series
  mini-drama/       Reference narrative video implementation
    cli.ts          Commander CLI (25+ commands)
    prompt-builder  Image + video prompt construction
    video-generator Video rendering with frame chaining
    generation-planner  Single vs multi-shot planning (up to 6 shots per unit)
    panel-fixer     Multi-edit character correction
    subtitle-generator  SRT from script
    assembler       Video assembly + audio mix
  editing/          Parallel editing pipeline (inspired by browser-use/video-use)
    types.ts        WordTiming, Take, TakesPack, Edl, EditSession, Overlay
    packer.ts       Collapse word streams -> takes_packed.md
    aligner.ts      Ground-truth script alignment + truncation detection
    providers/      Transcriber providers (whisper.cpp default)
    silence.ts      silencedetect wrapper + filler-word detection
    edl.ts          EDL authoring / validation / serialization
    render.ts       EDL -> final-edit.mp4 with 30ms audio fades (archive-first)
    self-eval.ts    Programmatic cut-qa checks (aspect, jump, pop, truncation)
    overlays.ts     Overlay manifest types + Venice-logo validator
  storyboard/       Legacy screenplay pipeline
  characters/       Character extraction
  parsers/          Fountain + PDF parsing
  assembly/         Remotion scaffold
```

## Included Reference Implementation

The `src/mini-drama/` directory contains a full narrative video pipeline. It demonstrates:

- Series creation with locked aesthetics and seed
- Character design with 4-angle reference images
- Voice audition and locking via Venice TTS
- Episode script workshopping via LLM
- Two-pass storyboard generation (generate + multi-edit refine)
- Vision-based QA for character/setting consistency
- Video generation with model routing and frame chaining
- Audio post-production with layered ambient beds
- Subtitle burn-in and final assembly

Use it directly for narrative content, or adapt the patterns for any format.

## Budgeting

This harness is quality-first, not bargain-first. When planning runs, account for:
- Image generation + multi-edit refinement passes
- Video generation (varies by model and duration)
- Venice TTS, SFX, ambience, and music
- Re-renders needed to fix continuity issues

Use `POST /video/quote` (via `quoteVideo()`) to estimate costs before committing to generation.

## Agent Rules

1. Never ask the user to run terminal commands manually.
2. Treat the user's natural-language request as the primary interface.
3. Read the relevant command/playbook before executing a workflow.
4. Prefer reusable harness patterns over one-off hacks.
5. Preserve generated shot assets by archiving prior versions instead of deleting them.
6. Keep secrets out of source control.
7. Use the model registry (`src/venice/models.ts`) to validate model capabilities before making API calls.
8. Check model support for `elements`, `reference_image_urls`, `scene_image_urls`, `end_image_url`, and `audio_url` before including them in requests.
9. **Never group shots with different characters into multi-shot units.** Multi-shot grouping requires pairwise character overlap between consecutive shots — shots cutting between different speakers (e.g., host → guest) must be separate singles so each gets R2V identity anchoring.
10. **Always validate durations against model specs, but PREFER 15s.** Seedance 2.0 accepts every integer 4-15s and HappyHorse 1.1 accepts 3-15s natively (confirmed against `GET /api/v1/models?type=video`). For any beat that could be 15s, default to 15s — 2x15s shots beat 5x6s on identity stability (no inter-shot drift), motion completion (gestures and expressions land), continuity (fewer cuts to police), and cost. Only use shorts (3-8s) for deliberate quick beats: hard cuts, sight gags, single-frame reactions, the closing title card. The `insert-shot` CLI defaults `--duration` to `15s` for this reason. The `workshop-episode` system prompt also instructs the script LLM to prefer 12-15s shots; if the LLM ignores it, the post-condition advisory in stdout flags the draft. The video queue function still auto-snaps invalid durations to the nearest valid value as a safety net.
11. **Front-load style in all prompts.** Aesthetic/style descriptions must appear at the START of prompts, not buried at the end. This prevents style drift across angles and shots.
12. **Use cfg_scale 10 for character references and storyboard panels.** Lower values (e.g., 7) allow the model too much freedom, causing style inconsistency between angles.
13. **Always pass `aspectRatio: '16:9'` (or the series ratio) explicitly to R2V video generation.** The R2V model requires `aspect_ratio` and will default to 16:9 if omitted, but always be explicit to prevent orientation bugs.
14. **Never multi-edit close-up face shots on 16:9 panels.** The 1024x1024→16:9 crop removes ~25% from top/bottom, losing foreheads and chins. Generate close-up panels from scratch with `nano-banana-pro` instead, then use multi-edit only for medium/wide shots.
15. **Match lighting across consecutive shots in the same location.** When generating panels for sequential shots in the same environment, style-match later shots against earlier ones. Explicitly describe the established lighting in each subsequent prompt.
16. **Use `silhouetteCharacters` for distant/silhouetted figures.** Characters visible only as silhouettes (e.g., figure in doorway) go in `silhouetteCharacters`, not `characters`. This ensures they appear in panels without triggering R2V routing or "no people" negative prompts.
17. **Describe the Venice AI logo as crossed-keys, never as "triple-V" or "VVV".** The actual logo is two ornate skeleton keys crossed in an X with a chevron/book at top. Use the full geometric description in prompts, or multi-edit with the logo PNG as reference.
18. **Multi-shot units render on Seedance 2.0 R2V Enhanced by default (2026-08-05) — the Kling multi-shot lane is an explicit override only.** `DEFAULT_MULTISHOT_MODEL` / `resolveMultiShotModel()` in `src/series/types.ts` route every multi-shot generation unit to the SAME reference-first lane as singles: one Seedance native multi-shot generation with `Lens switch.` separators (rule 21), anchored to the full @Image slot plan (character sheets, blocking plate, location angles) in pure reference mode — no start frame. `buildMultiShotPrompt()` dispatches on the resolved model. The old default, `kling-o3-pro-image-to-video`, has NO `elements` and NO `reference_image_urls` support, so every multi-shot unit silently dropped ALL identity anchoring (anti-pattern 1's trap, and the reason grouping rules had to police characters so hard). To deliberately use the Kling format anyway, set `videoDefaults.multiShotModel: "kling-o3-pro-image-to-video"` — the legacy Kling 3.0 structure (subjects up front, `Shot N (Xs):` labels, `[Character, voice]: "dialogue"`, `Immediately, cut to:` separators, max 6 shots / 15s; see the [Kling 3.0 Prompting Guide](https://blog.fal.ai/kling-3-0-prompting-guide/)) is kept behind that override.
19. **Seedance 2.0 R2V uses `@Image` tags, not `@Element` tags.** When the resolved model is Seedance R2V, replace character names with `@Image1`, `@Image2` in prompts. Do NOT use `@Element` tags — Seedance does not support structured elements. The prompt builder handles this automatically via `useImageTags`.
20. **Keep Seedance prompts under 60 words for best results.** Seedance responds to precision, not volume. Use the 5-part structure: Subject, Action (present tense, one verb), Camera (shot size + movement), Style (lighting, color), Constraints (what to exclude). See [Seedance prompting guide](https://venice.ai/blog/seedance-sota-video-generation-live-on-venice).
21. **Default to Seedance native multi-shot for any 2–3 beat scene.** Before planning a bundle of separate Seedance renders, first ask whether the beats can fit into ONE generation up to 15s with `Lens switch.` separators between them. The native multi-shot path is the default; bundled separate renders are the fallback. Identity, environment, and lighting hold across the lens switches inside a single generation, and the result costs and takes ~3× less than three separate renders. Reach for a bundle only when (a) a beat needs Wan 2.7 lip-sync to a specific dialogue MP3, (b) beats span different locations or non-overlapping characters, or (c) total runtime > 15s. Prompt structure: one front-loaded STYLE + character anchor at the top, then per-beat `Shot N (Xs): ...` blocks with the 5-part structure (Subject, Action, Camera, Style, Constraints) kept under ~50 words each, separated by literal `Lens switch.` lines. Pass character refs once via `reference_image_urls` and reference them inline as `@Image1`, `@Image2`, etc. in every beat.
22. **Seedance excels at physics-aware prompting.** Describe forces, not just actions — "tires smoke as car drifts 90 degrees" rather than "car turns." Friction, weight, material interactions, and contact physics produce better results with Seedance's physics-aware training.
23. **3+ character shots auto-fallback to Kling O3 R2V.** When the default R2V model is Seedance (flat refs, max 4 images), shots with 3+ characters automatically fall back to Kling O3 R2V which supports structured `elements` for better per-character identity separation.
24. **Seedance accepts face-bearing input images from ANY image family (2026-07).** Venice removed the old restriction that Seedance 2.0 only accepted face-bearing images produced by `seedream-v5-lite` / `seedream-v5-lite-edit`. There is no longer any seedream requirement: generate character portraits, character panels, and references with the global default `nano-banana-2` (or any family you prefer) and feed them straight to Seedance. The provenance-driven pre-flight gate is now a no-op (`ensureSeedanceCompatibility` always proceeds) and `seedanceCompatibility` is no longer auto-set. Provenance sidecars are still written as metadata but nothing gates on them. (Historical context: anti-pattern 13.) The Seedance face **consent** attestation (409 `needs_consent`) is unrelated and still handled at queue time.
25. **Always ask before burning in subtitles.** Before assembling the final video on any project that includes a VO track, ask the user "Burn in subtitles? (yes / no)" — burn-in is a permanent baked-into-pixels decision and is not always wanted. If yes, follow `.agents/skills/burn-in-subtitles/SKILL.md`: never hand-estimate caption timings, always derive them from `ffmpeg silencedetect` on the rendered VO via `.agents/skills/burn-in-subtitles/scripts/derive-captions.ts`, and use single `...` ellipses only in TTS VO_TEXT (doubled `......` cause Kokoro/ElevenLabs to silently truncate the audio).
26. **Never use doubled ellipses in TTS VO scripts.** Kokoro and ElevenLabs handle single `...` reliably as breath gaps. Doubled `......` cause silent truncation — the audio file ends mid-script with no error, and you only catch it when downstream captions reference dropped text. Use commas + single `...` for combined rhythm, or break across multiple TTS calls and concat with ffmpeg `apad`.
27. **Editing pipeline is text-first.** When the task is to cut / trim / re-order existing media (not synthesize new shots), always transcribe sources first via `scripts/transcribe-sources.ts` and reason over `takes_packed.md`. Call `scripts/timeline-view.ts` ONLY at explicit decision points — never frame-dump to browse the footage. See `.agents/skills/video-editing/SKILL.md`.
28. **Never render an EDL without user confirmation of the cut strategy.** Post a summary (sources, duration, trim rules, transitions) and wait for "yes" before calling `renderEdl()`. The render is cheap; a throwaway 15-minute render because intent was guessed is not. Mirrors video-use design principle 3.
29. **Always run cut-qa after every assembly / edit render.** The `cut-qa` agent runs programmatic checks (aspect, visual jump, VO truncation, **dialogue/VO overlap** — assert no two spoken clips play simultaneously, see rule 35, lighting, audio pop, subtitle overlap) at cut boundaries. Max 3 fix iterations before surfacing to the user. Applies to BOTH the generation-pipeline assembler and the editing-pipeline render.
30. **Overlays are a post-process, never baked into the EDL render.** Lower-thirds, title cards, chapter markers, and logo-bugs live in an `OverlayManifest` rendered via `scripts/render-overlay.ts` on top of `final-edit.mp4`. Changing overlay wording must not require re-rendering the cut.
31. **Never auto-trim silence gaps that originated from `...` in a TTS script.** Those are intentional breath beats rendered by Kokoro / ElevenLabs, not dead air. The filler-word detector (`src/editing/silence.ts`) excludes them. User confirmation is required for every filler-word trim before it lands in an EDL.
32. **Keyframe-only lip-sync models get their keyframe from a Seedance R2V pass — not from a panel.** This path runs only when `audioStrategy: lip-sync` AND the resolved lip-sync model takes no `reference_image_urls`; native dialogue stays on Seedance/HappyHorse with voice-donor references. **Most projects never hit it:** `resolveLipSyncModel(family)` keeps Seedance and MiniMax H3 projects on their own R2V lane (both accept a top-level `audio_url`), which already anchors identity from the reference stack, so those render in a single pass. Only families with no audio-driven lane fall back to `wan-2-7-image-to-video`, whose sole identity anchor is the single `image_url` keyframe — and a panel-derived keyframe drifts mid-clip because the panel was generated without strong character anchoring. Pipeline (transparent to the user): (a) render a quick Seedance R2V identity-lock pass via `videoDefaults.characterConsistencyModel` with all character refs and no audio → `shot-NNN-r2v-keyframe.mp4`; (b) extract frame 1 → `shot-NNN-r2v-keyframe.png`; (c) render via the lip-sync model using that keyframe as `image_url` and the dialogue MP3 as `audio_url`. If the dialogue MP3 isn't on disk yet, the generator inline-TTS-renders it via the character's locked voice and saves it at the canonical `audio/dialogue-shot-NNN.mp3` path so the assembler picks it up later. Cost ~$0.85/shot total, versus one render in-family. Skipped automatically when: the lip-sync model takes reference images, no dialogue, high motion, or multi-speaker dialogue (Wan 2.7 R2V `per_reference_audio` instead). **Opt-out:** per-shot via `ShotScript.disableSeedanceKeyframe = true`; series-wide via `series.json` `videoDefaults.seedanceKeyframeForWan: false`; one-off via `generate-videos --no-seedance-keyframe`. If Stage A or the keyframe extraction errors out, the generator logs the failure and falls back to the panel-anchored single-pass render. Note the attachment of the dialogue MP3 to `audio_url` is independent of this pre-pass — it happens for every audio-input-capable exact-lip-sync route.
33. **Native model dialogue is preferred over exact TTS-driven lip-sync; suppress music/SFX in the video prompt.** Seedance 2.0 and HappyHorse 1.1 generate in-character dialogue with voice-donor references; the audio-driven `audio_url` lane is reserved for the explicit exact-lip-sync strategy when the panel prompt carries a detailed voiceDesc and per-shot delivery direction. The harness now defaults `assemble-episode --dialogue-replace` to OFF (was on) and `--native-volume` to 1.0 (was 0.2). Music and ambient/SFX are added in post via `musicCues[]` / `media.generate_music` / `media.generate_ambient` / `assemble.mix_audio`. To keep the video model from baking music or sound effects into the dialogue track, `prompt-builder.ts` appends `background music, soundtrack, score, musical score, sound effects, sfx, foley, orchestral hits, sound design, audio drops` to every `negative_prompt`, and the `workshop-episode` system prompt instructs the script LLM to include the same negative in every shot description. Venice TTS remains the exception path for accent control, language swap, or repairing a botched native take — call `override-audio --dialogue` to produce `dialogue-shot-NNN.mp3` files, then pass `--dialogue-replace` to `assemble-episode` (and drop `--native-volume` to ~0.2).
34. **Venice deprecation headers are now logged as structured warnings.** `VeniceClient.post*` reads `x-venice-model-deprecation-warning` and `x-venice-model-deprecation-date` from every response and emits a `⚠ MODEL DEPRECATION:` line on stderr the first time each unique (model, date) pair is seen in the process. HTTP 410 Gone responses also get a structured warning. The MCP wrapper pattern-matches these into `warnings[]` so the agent driving the pipeline sees them in tool responses, instead of only finding out post-sunset when a model starts 404ing (the exact failure mode we hit with `qwen-2.5-vl` sunsetting 2025-09-22). See `src/venice/client.ts::reportVeniceDeprecation`.
35. **Schedule dialogue/VO with a global no-overlap scheduler driven by MEASURED clip durations — never by the script's planned shot lengths.** At assembly time, two audio clips may never play at once unless they are intentionally layered (e.g. a music bed vs a line). Build the schedule against the actual `ffprobe` duration of each rendered/normalized segment, not the `duration` field in the script (the rendered clip is almost always shorter or longer than its planned slot). Algorithm: walk shots in timeline order keeping a single `nextFreeSec` cursor; place each line at `max(shotStart + lead, nextFreeSec + gap)`; set `nextFreeSec = placedStart + audioDur`; use one cursor for ALL spoken lines regardless of speaker (narrator AND character) — a per-speaker cursor is the classic bug (see anti-pattern 19). Keep a small `gap` (≈0.2-0.3s) between consecutive lines. SFX and the music bed are exempt because they are meant to underlay. After mixing, verify with the cut-qa overlap check.
36. **Author VO so each line fits its shot, and when it can't, extend the picture — never let audio bleed into the next shot.** A line of TTS runs ≈2.3-2.7 words/sec plus ~0.4s lead-in; budget `shotSeconds × 2.4` words and write to it. If a finished line is longer than its shot's video, the assembler must (a) extend that shot by freezing/holding its last frame to cover the audio (`ffmpeg tpad=stop_mode=clone:stop_duration=...`), or (b) the line must be shortened/split — it must NOT spill onto the next shot. Long narrator lines over short establishing shots are the usual offender; either tighten the narration or hold the frame. This is the authoring complement to the scheduler in rule 35.
37. **Re-anchor every separately-rendered shot to the SAME locked references and restate the character's invariant traits in every prompt.** Identity, scale, palette, and wardrobe drift across independently generated shots even when the story is continuous. For each shot pass the identical canonical `reference_image_urls` (not a frame grabbed from a different shot), and repeat the character's fixed traits inline every time (markings, hair color, costume, and **relative size** — e.g. "as tall as the boy"). Size is a trait the model forgets most: if a character's scale changed in-story (grew/shrank), encode a `sizeState` per shot and state it explicitly. Prefer Seedance native multi-shot (rule 21) for consecutive beats precisely because identity/scale/lighting hold within one generation; across separate renders, the per-prompt trait restatement is what holds them together. Verify drift on a contact sheet of first-frames before assembling (see anti-pattern 20).
38. **Direct the scene, don't decorate it.** Before writing any shot's `description` or `delivery` — in `workshop-episode`, `insert-shot`, or a manual `script.json` edit — decide what the beat is DOING (the turn, POV, power, subtext) and name ONE intention, then derive camera/light/blocking/performance/sound from it. Do not stack "cinematic / epic / beautiful / masterpiece / 4k" adjectives; they give the model nothing to serve. Hold one directorial voice across the episode. This is baked into the `workshop-episode` system prompt (`src/mini-drama/cli.ts`) so both the CLI and the venice-video-mcp `episode.workshop` inherit it. Direct **intention/camera/light/blocking/performance/sound only** — identity is locked downstream (rules 9, 19, 32), so never hand-write full physical character descriptions or reference-image tags into `description`. When a take is close-but-wrong, fix ONE variable at a time; when continuing, direct from the accepted footage's real ending, not the original plan. The optional **Seedance 2.0 Skill OS** (install into `.agents/skills/seedance-20/`; see README "Directing layer") supplies the full `directing-engine`, `retake-protocol`, `continuation-handoff`, `seedance-copyright`, and `seedance-antislop` behind this rule; ignore its non-Venice surface/API references.
39. **Every AI pass writes a recipe sidecar; finishing passes must append to it.** Each generated/edited asset gets `shot-NNN.recipe.json` (via `appendRecipePass()` in `src/venice/recipe.ts`) — an append-only log where every entry is a replayable Venice call: kind (`generate` / `multi-edit` / `video-generate` / `mechanical`), role (`content` / `identity` / `look` / `mechanical`), model, prompt, negative, seed, cfg, and reference-image paths (stable on-disk paths, never data: URIs). The harness writes it automatically for character refs, storyboard passes 1–3, the seedance launder pass, keyframe extraction, and video renders. **Finishing convention:** shots are finished with AI model calls, not local pixel edits — any post-harness polish/fix pass (agent, MCP, one-off script) must go through `appendRecipePass()` too, which also updates the provenance sidecar in the same write so the Seedance gate stays honest. Roles make finishing safe: `look` passes can be redone freely; `identity` passes (character refine, R2V anchors, seeds, `@Image` mappings) must not be disturbed by a look polish; redoing a `content` pass invalidates everything after it. To regenerate a shot that matches the episode, replay its recipe (same STYLE string, seed, cfg, refs, style anchor — the `.style-anchor.png` in each scene dir is intentionally kept on disk) instead of hand-prompting. The pass-1 `--debug` prompt dump is superseded by this; the recipe is always written.
40. **Dialogue shots on reference-audio-capable models carry a per-character voice-donor clip (`reference_audio_urls`, bound in-prompt as @AudioN).** When a shot routes to a reference-audio model (Seedance 2.0 R2V family, HappyHorse 1.1 R2V) and the speaker is a visible non-narrator character, the harness attaches that character's voice reference so the native model dialogue keeps the same timbre/accent/pacing across shots. The clip lives at `characters/<slug>/voice-reference.mp3` — generated on demand via `seed-audio-1-0` from the character's `voiceDescription` (or supplied by the operator). The generator auto-creates a missing clip inline before rendering (mirroring the inline dialogue-TTS pattern) and persists `voiceReferencePath` to `character.json`. Wire-in rules: Venice REQUIRES ≥1 reference image alongside reference audio (audio-only is rejected), each clip is 2-15s with an aggregate ≤15s across ≤3 clips (out-of-budget clips dropped + warned), and the @AudioN index in the prompt MUST match the push order into `reference_audio_urls`. The prompt binds it as "Use @Audio1 only for voice identity — timbre, accent, pacing; regenerate clean studio dialogue" so the model doesn't copy any junk-tail noise. Opt-outs: `generate-videos --no-voice-reference`, or series-wide `videoDefaults.voiceReferenceForDialogue: false`. Explicit clips: `generate-voice-reference` / `lock-character --voice-reference <file>` (CLI), `character { action: "generate_voice_reference" }` / `character { action: "lock", voiceReference }` (MCP). Wan 2.7 lip-sync shots do NOT take reference audio — they get `audio_url` instead (rule 32).
41. **Locations are first-class entities with generated reference images, folded into panels and video like character refs.** A `Location` (name, slug, description, lightingNotes, seed) carries 3 faceless reference angles (`wide` / `medium` / `detail`, generated with `nano-banana-pro`, provenance `hasFace:false`) under `locations/<slug>/`. Tag any shot with `location: <slug>`. Effects: (a) **storyboard Pass 1** injects the location's locked `description` + `lightingNotes` into the panel prompt (serves anti-pattern 7) and adds the wide/medium ref as an environment anchor (closer shot types prefer `medium.png`); (b) **Pass 2 refine** prefers the location ref as the environment/style anchor (characters first, location takes the last free slot); (c) **video**: Kling O3 R2V shots auto-populate `scene_image_urls` from the location (hand-set `sceneImagePaths` override wins); Seedance / HappyHorse (no `scene_image_urls`) get location angles via the reference slot planner (`reference-slots.ts`) — up to ALL THREE angles (wide → medium → detail, closer shot types lead with medium) land in `reference_image_urls` with per-angle `@ImageN` role clauses ("a second angle of the same location"), within the 9-image budget. Create locations with `add-location` / `generate-location-references` (CLI) or the `location` MCP tool (`add` / `generate_references` / `list`). `workshop-episode` also emits a `locations[]` array, tags every shot with a slug, and auto-generates any missing refs right after saving the draft (cost logged). Reuse existing slugs across episodes instead of redefining a place.

42. **The reference stack is the shot's single source of consistency (reference-first, 2026-07-30).** Seedance 2.0 R2V Enhanced is the default for ALL lanes and every shot renders in **pure reference mode — no `image_url` start frame** — from an ordered `@Image` slot plan built by `src/mini-drama/reference-slots.ts`: (1) one primary angle per character ("@Image1 is Bob"), (2) the beat's **storyboard blocking plate** (PROTECTED), (3) location angles wide→medium→detail ("@Image5 is a second angle of the castle courtyard"), (4) second character angles. Budget is per-model (`getMaxReferenceImages`, 9 on Seedance R2V family + HappyHorse 1.1 R2V, 4 legacy elsewhere); overflow drops second character angles first, then trailing location angles — plates last. The prompt's `@ImageN` indices and the `reference_image_urls` push order come from the SAME slot list, so they can never disagree. Storyboard plates are composed images of a scene beat (multiple characters positioned in a location relative to each other — "@Image7 shows Bob and Alice fighting over the golden chalice inside the courtyard") generated per beat by `storyboard-reference-generator.ts` (auto-planned in `workshop-episode` / `generate-videos`, manual via `generate-storyboard-refs`), stored at `storyboards/<slug>.png`, and bound with the role clause "use it ONLY for composition, blocking, and spatial relationships; take each character's appearance from their own reference." Different beats of the same scene get different plates (different angles/moments) — every asset must stay consistent across space and time. Last-frame chaining and panel start-frames remain available for i2v models and the rule-32 keyframe pipeline, but are NOT used on the reference-first path.

43. **Never re-submit a render whose `queue_id` might still be in flight — re-attach instead.** Venice charges at queue time, not at download time, so a lost `queue_id` is money already spent. Every queued video/audio render is now recorded to `pending-jobs.json` in the config dir *before* the first poll (`src/venice/job-store.ts`), keyed by output path. `generateVideo`, `generateQueuedAudio`, and `renderVideoFile` all check for an existing record first and resume polling it; the record is cleared only on successful download or a definitive terminal failure. Consequences for an agent: (a) if a generation command is interrupted, re-run the SAME command with the SAME output path — that re-attaches; do not "start fresh", and do not delete the pending record to make a warning go away; (b) inspect in-flight work with `venice-video queue` and only `queue clear` a record you know is dead (Venice keeps a job ~1h; `isStale` flags older ones); (c) `queue` is Venice's side of the work while the shell's `/jobs` is only the current session's background commands — they are different lists. Cancellation is cooperative: an `AbortSignal` is threaded through the client, poll loops, and retry backoff via `AsyncLocalStorage` (`src/venice/operation-context.ts`), so a Ctrl-C stops polling but does NOT stop Venice from finishing and billing the render.

44. **Every suggested next step is a runnable command line, and every state-changing command refreshes the treatment page.** Two rules that both exist because the operator cannot see what the harness knows. (a) **Never print a bare verb or a slash-prefixed name as a suggestion.** `/` is reserved for the shell's meta-commands (`/help`, `/status`, `/jobs`, `/use`); a production command typed with a leading slash fails as an unknown meta-command. Suggestions must carry `-p <project>` and `-e <episode>` so they work pasted into any terminal, not only a shell session with a selection. `qualifyCommand()` in `src/session/status.ts` does this for anything derived from `collectProjectStatus`. (b) **`WORKSHOP.html` is a live document.** `refreshTreatment()` (`src/mini-drama/treatment.ts`) re-renders it from on-disk state — stage, counts, next command, and per-shot panel/clip/voiceover/QA-verdict — and every command that produces an artifact calls `updateTreatment()` on its way out. It rewrites only `WORKSHOP.html` and `WORKSHOP.md`, never `workshop.json` (the draft belongs to the workshop and its revision counter). It renders the *live* `script.json` when one exists, so `insert-shot` additions appear. It is wrapped so it cannot throw: a corrupt panel or half-written `qa-report.json` degrades to a blank cell rather than failing a paid render. Thumbnails are WebP data URIs (a `file://` subresource would be blocked by the browser) cached against mtime in `.treatment-thumbs.json`. **When adding a command that writes an artifact, add the `updateTreatment(series, episode)` call too.**

45. **A gate's status reporter must check the same conditions as the gate.** `collectProjectStatus` mirrors the pipeline's file-based state machine, and any drift between the two produces confidently wrong advice. The case that bit: `storyboard-episode` accepts either `script-approved.json` OR `script.status === 'approved'`, but the reporter checked only the file — and `workshop --approve` sets only the status. Every workshop-driven project was therefore told to run `approve-script` on a script it had already shot, forever. When changing a gate condition in `cli.ts`, change `classifyEpisode` in the same commit.

46. **The intelligence model is a per-project setting, and its vision companion never crosses the privacy tier.** Three steps reason rather than render — the workshop, the shot script, and storyboard QA — and the model behind them is chosen at project creation and stored on `series.intelligence` (`{ model, visionModel }`), not on `videoDefaults`, which is for models that make pixels. Precedence at every call site is explicit `--model`, then the project's setting, then `DEFAULT_INTELLIGENCE_MODEL`. The registry is `src/venice/text-models.ts`; `resolveIntelligence()` pairs a text-only choice with the cheapest vision-capable model **in the same privacy tier**, because quietly promoting a `private` project's panels to an `anonymized` model to work around a missing capability would break the promise the operator made when they picked private. Two related invariants: (a) an explicit `--model` on `qa-storyboard` names the panel reader directly and is used verbatim — substituting a "safer" model silently ignores the flag; (b) a QA shot whose vision call *failed* is unchecked, not low-severity, so it is counted separately (`summary.errored`) and suppresses the "no critical issues, run qa-approve" suggestion. Folding those into `FLAG-LOW` alone once let a storyboard where every single call had failed read as clean.

47. **Ask a model for JSON through `client.chatJson()`, never by parsing `post()` yourself.** Reasoning models are now the default, and three things break naive parsing: fences appear inconsistently; some models emit *almost* valid JSON (GLM 5.2 drops a closing brace roughly one attempt in three); and a model with no vision answers an image prompt with an empty string or an opaque 400 rather than a useful error. `chatJson` strips fences, retries once quoting the parse error back to the model, and names the no-vision case explicitly. Related: `describeApiError()` reads all three Venice error shapes — `{error:"..."}`, `{error:{message}}`, and `{issues:[{message}]}` — because reading only `error.message` discarded both the "Did you mean: …" model-not-found hint and the "Image content is not supported by this model" validation message, leaving operators with a bare HTTP status. Reasoning also costs tokens from `max_tokens`, so a budget sized for a plain model can return empty content.

48. **The CLI is self-describing — discover state and order from it, do not guess.** `venice-video agent-guide [--json]` prints the core operating rules (this section in miniature) and ships inside the binary, so it is available even on a bare global install with no `AGENTS.md`. `venice-video pipeline [--json]` prints the ordered stages, their gates, and the command that advances each; it mirrors `classifyEpisode` in `src/session/status.ts` (rule 45 — change both together). `venice-video status -p <project> [--json]` reports where a project stands and the next command. `--json` is supported on `status`, `pipeline`, `agent-guide`, `doctor`, and `queue` (and globally as `venice-video --json <command>`); it prints exactly one JSON object on stdout, and the human text rendering is unchanged. Exit codes are honest — `status` with no project exits non-zero — and ordinary errors are a clean `error:` line, not a stack trace (`VENICE_VIDEO_DEBUG=1` for the stack). The condensed guide is kept in `src/agent/guide.ts` and duplicated as an installable skill at `.agents/skills/venice-agent-guide/`; when a non-negotiable here changes, change those two as well.

49. **Spatial consistency is authored, not inferred — every prompt states placement relative to locked anchors (2026-08-05).** Visual consistency (identity, wardrobe, palette) is handled by the reference stack, but *spatial* consistency — who stands where, which side of frame, facing which way, relative to which landmark — drifts unless it is stated the same way in every generation. The harness now carries geometry as first-class data: (a) **`Location.spatialAnchors`** is the locked geography of a place — 3-5 named landmarks and their fixed relative positions ("bar counter along the back wall; entrance door opposite it; neon window left of the door as seen from the counter"). It is baked into the location reference angles at generation time, injected as "Fixed layout (never rearrange): …" into every panel and video prompt for shots tagged with the location, and is sticky on merge — an existing anchor set is never overwritten by a later script part. (b) **`ShotScript.blocking`** is the shot's authored geometry — 1-2 sentences placing each character/object relative to the named anchors, the frame (screen left/right, foreground/background), and their facing/eyeline. The workshop and script LLM prompts require it for every character shot, with continuity rules: characters keep their screen side and relative positions across consecutive shots unless a movement is written into the action; screen direction and eyelines are preserved (180-degree rule); close-ups still name what is behind/beside the subject. It is injected verbatim (with @ImageN/@ElementN name substitution) into the panel prompt (`BLOCKING: …`), the video prompt (`Blocking: …`), the multi-shot per-beat blocks (both the Seedance native lane and the legacy Kling format), and it seeds the beat's storyboard blocking-plate description. (c) The video prompt's plate clause now forbids mirroring/swapping ("each character stays on the same side of the scene… do not mirror, swap, or rearrange who stands where"), and plateless location shots get a geography-hold clause anchored to the location's first `@ImageN` slot. (d) **QA reads geometry**: `qa-storyboard` evaluates a fourth SPATIAL CONTINUITY dimension against the shot's stated blocking and the location's landmarks, and attaches the nearest prior panel from the same location so side-swaps, mirrored geography, and moved landmarks are caught against real coverage — a spatial flip that breaks the scene is FLAG-CRITICAL. (e) `workshop-episode` warns when character shots are missing `blocking` or locations are missing `spatialAnchors`; `insert-shot` inherits the anchor shot's location and blocking (same-scene splices keep the established geography) and takes `--location` / `--blocking` overrides; `add-location` takes `--spatial-anchors`. The failure mode this kills: characters teleporting across the room, swapping frame sides between coverage, and set geography silently mirroring between shots that read as the same scene (see anti-patterns 20 and 26).

50. **Montage-first generation is the default on this branch (Seedance 2.5, 2026-08-07).** Seedance 2.5 (`seedance-2-5-reference-to-video`, quote/queue only — not on GET /models) renders every integer 4-30s in one pass, 480p/720p, aspect 21:9/16:9/4:3/1:1/3:4/9:16, with up to **30** image references (release-note ceiling 30 img / 10 video / 10 audio, 50 total — enforced harness-side, the quote endpoint does not police it) plus `audio_url`, `reference_audio_urls`, and `reference_video_urls`. The planner (`buildGenerationPlan`) therefore groups each SCENE — a maximal run of consecutive shots sharing a `location` tag (`groupShotsIntoScenes` in `src/mini-drama/montage.ts`) — into ONE `montage` generation unit up to 30s, prompted with the **timestamped SEQUENCE grammar** from the vault's "Make a full trailer with Seedance 2.5" pack (`buildMontagePrompt` in `prompt-builder.ts`): a SHOT header declaring "an N-second fast-cut montage, cut it yourself in the edit", @Image identity declarations + role clauses from the SAME reference slot plan as every other lane, a CAMERA line with hard-cut enforcement, per-beat `[0:03-0:05] …` blocks (action, blocking, dialogue, diegetic sound), the geography-hold clause, then ONE style token ending in "Face stable throughout, no deformation. Diegetic sound only, no music, no on-screen text." and a SHORT negative. The four vault rules (no music / face-stability line / @Image discipline / short negatives) are hard-coded. Beat timestamps live on `GenerationUnit.montageBeats` — the SAME list the post-render cutter (`cutMontageIntoShots`) slices on, scaled to the actual rendered duration, so the prompt and the edit can never disagree. Every beat is cut to (a) the canonical `scene-001/shot-NNN.mp4` the assembler/QA/subtitles already read, and (b) `episode-N/media-library/scene-NN/shot-NNN.mp4` alongside the uncut master and a `manifest.json` (per-cut timestamps, shot type, description) for hand editing / the Venice Video Creator. **The `autoEdit` toggle decides what happens next:** `videoDefaults.autoEdit: true` (or `generate-videos --auto-edit`) chains straight into `assemble-episode`; the default `false` (or `--no-auto-edit`) stops at the media library. Inserts, title cards, and `mustStaySingle` shots fall through as classic singles; exact-lip-sync projects keep their dedicated lane. Opt out of montage planning entirely with `videoDefaults.montageMode: false` or `generate-videos --no-montage` (restores the 2.0-era per-shot / 15s multi-shot planner, which remains untouched). Montage duration preflight validates the UNIT total against the 2.5 ladder, not the per-beat windows. Smoke tests: `scripts/smoke-montage-plan.ts`, `scripts/smoke-montage-cut.ts`. **The render route is chosen up front at project creation** — `venice-video new` (and `new-series`) asks "montage (default, recommended — one single-pass generation per scene, auto-cut into a media library for later editing) vs standard (special-purpose per-shot planning: non-groupable scripts, per-shot render control, non-Seedance families; more prone to consistency drift)", or pass `--route montage|standard`. Montage is the default for everyone; standard is the escape hatch, not the beginner path. The answer sets `videoDefaults.montageMode` (montage→true, standard→false); omitting it keeps the montage-first default. See `RENDER_ROUTE_CHOICES` in `src/mini-drama/choices.ts`.

51. **Seedance 2.5 is the default video model across every lane (2026-08-07).** The seedance/auto family defaults — `DEFAULT_ACTION_MODEL`, `DEFAULT_ATMOSPHERE_MODEL`, `DEFAULT_CHARACTER_CONSISTENCY_MODEL`, `DEFAULT_MULTISHOT_MODEL`, `resolveVideoFamilyDefaults('seedance'|'auto')`, and the in-family `resolveLipSyncModel('seedance'|'auto')` — all resolve to `seedance-2-5-reference-to-video` (was `seedance-2-0-enhanced-reference-to-video`). This makes the whole harness uniform with the montage lane (rule 50, `DEFAULT_MONTAGE_MODEL`), which was already 2.5. Nothing hardcodes 2.0 ids in the routing path — the prompt builder and planner branch on capability sets (`MODELS_USING_IMAGE_TAGS`, `MODELS_SUPPORTING_REFERENCE_IMAGES`, `MODELS_SUPPORTING_REFERENCE_AUDIO`, `resolveMultiShotModel`, `resolveMontageMode`), and Seedance 2.5 R2V is in every one of them, plus `MODELS_SUPPORTING_AUDIO_INPUT` (its spec has `audio_input: true`; the coverage test enforces the set membership). What 2.5 buys as the default: single-pass durations up to 30s (every integer 4-30s), up to **30** reference images (vs 9), aspect 21:9/16:9/4:3/1:1/3:4/9:16, plus `audio_url` / `reference_audio_urls` / `reference_video_urls`. The one trade-off: 2.5 tops out at **720p** where 2.0 R2V Enhanced reached 1080p — but the mini-drama generator already pins `720p` for every `seedance` model, so no request regresses and none can 400 on a 1080p body. The 3+/7+ character Kling fallback effectively stops firing at 2.5's 30-ref budget (kept for extreme counts / scene-image needs). **To go back to 1080p on a project**, set `videoDefaults.characterConsistencyModel` (and/or `actionModel`/`atmosphereModel`) to `seedance-2-0-enhanced-reference-to-video` — it stays registry-known. **Prompt-writing for 2.5** is covered by the installed `.agents/skills/sd25-pe/` skill (Seedance 2.5 Prompt Optimizer + a harness-bridge section): compile the creative content with it, then let the harness own identity/refs, duration, resolution, and the no-music suffix (see the skill's "Reconciliations"). When this default changes again, update `src/series/types.ts`, regenerate `capabilities.json` (`npm run manifest`), and update the routing table above + the `venice-video-model-routing` skill.

## Learned Anti-Patterns (Production Issues Log)

Issues discovered during production and their fixes. The agent should internalize these to avoid repeating them.

### 1. Multi-Shot Grouping Bug: Wrong Character Overlap Check
**Symptom:** Shots cutting between different characters (e.g., Chad-only → Vivienne-only) were grouped into multi-shot units, which at the time used `kling-o3-pro-image-to-video` — a model with NO `elements` or `reference_image_urls` support. Characters lost all identity anchoring.
**Root cause:** `hasOverlappingCharacters()` checked each shot's characters against the union pool instead of requiring pairwise overlap between consecutive shots.
**Fix:** Rewrote to require every consecutive pair of shots to share at least one character. Shots with disjoint characters now always render as singles with R2V. (2026-08-05: the referenceless-model half of this trap was removed at the root — multi-shot units now default to Seedance R2V Enhanced with the full reference slot plan, see rule 18. The pairwise-overlap check remains because grouping disjoint characters is still wrong on any lane.)
**File:** `src/mini-drama/generation-planner.ts`

### 2. Character Reference Style Inconsistency Across Angles
**Symptom:** Front-facing reference was cartoon/stylized but profile and full-body drifted to photorealistic.
**Root cause:** (a) Aesthetic description was at the END of the prompt — the model committed to a rendering style before seeing the style instructions. (b) `cfg_scale: 7` gave the model too much latitude. (c) No anti-realism terms in negative prompt.
**Fix:** (a) Front-loaded `STYLE:` prefix and added `STYLE REMINDER:` suffix in `buildCharacterReferencePrompt`. (b) Bumped `cfg_scale` to 10. (c) Added `photorealistic, photograph, photo` to negative prompt.
**Files:** `src/mini-drama/prompt-builder.ts`, `src/mini-drama/cli.ts`
**Fallback:** When base generation still drifts, use a two-pass approach: generate base image, then style-match via multi-edit against a good reference shot.

### 3. Atmosphere Model Duration Validation
**Symptom:** `veo3.1-fast-image-to-video` returned 400 error for `duration: "3s"` — it only accepts 4s/6s/8s. Seedance 2.0 (now the default) accepts 4s/5s/8s/10s/12s/15s — not all integers.
**Root cause:** Script had 3s establishing/insert shots. No validation against model's allowed durations.
**Fix:** Added auto-snap in `queueVideo()` that checks the model's duration spec and snaps to nearest valid value with a warning.
**File:** `src/venice/video.ts`

### 4. Talk Show Format: All Character Shots Must Be R2V Singles
**Symptom:** Character appearance was inconsistent between cuts in talk show format.
**Root cause:** The generation planner was optimizing for temporal continuity (multi-shot grouping) when the format actually needs identity consistency (R2V singles with reference anchoring).
**Fix:** For formats with frequent speaker cuts (talk shows, interviews, panels), set `mustStaySingle: true` on all shots or ensure no cross-character grouping occurs. Every character shot uses the default R2V model (`seedance-2-0-reference-to-video` for 1-2 characters, auto-fallback to `kling-o3-standard-reference-to-video` for 3+) with reference images for identity anchoring.

### 5. R2V Model Defaults to 9:16 (Vertical) Without Explicit Aspect Ratio
**Symptom:** Shot 10 video generated as 716x1284 (portrait) despite the panel being 16:9 landscape.
**Root cause:** `buildModelParams()` in `models.ts` defaulted R2V models to `'9:16'` when no `aspectRatio` was passed. The video generation pipeline didn't always propagate the series' aspect ratio.
**Fix:** Changed the R2V fallback default from `'9:16'` to `'16:9'` in `buildModelParams()`. Added a warning in `queueVideo()` when no explicit aspect ratio is provided for R2V models. Always pass `aspectRatio` explicitly in generation scripts.
**File:** `src/venice/models.ts`, `src/venice/video.ts`

### 6. Multi-Edit Crops Foreheads on 16:9 Close-Up Panels
**Symptom:** After multi-editing a close-up face shot, the forehead (with a logo/sigil) was completely cropped off.
**Root cause:** Venice multi-edit always returns 1024x1024. Restoring 16:9 aspect ratio crops ~25% from top and bottom. Close-up face shots lose foreheads and chins.
**Fix:** For close-up shots that need forehead detail (logos, sigils, headwear), generate the panel from scratch with `nano-banana-pro` instead of multi-editing an existing panel. Multi-edit is safe for medium/wide shots where the crop margins don't hit critical content. Added a warning in `panel-fixer.ts`.
**File:** `src/mini-drama/panel-fixer.ts`

### 7. Lighting Inconsistency Between Consecutive Shots in Same Location
**Symptom:** Shot 3 (circuit close-up in sietch) was extremely dark while shot 2 (SeehRov at workbench in same sietch) had warm amber lighting. Jarring cut.
**Root cause:** Each panel was generated independently with no reference to the preceding shot's lighting. The same environment description produced wildly different interpretations.
**Fix:** For consecutive shots in the same location, style-match the later panel against the earlier one using multi-edit. In the panel generation prompt, explicitly describe the lighting conditions from the preceding shot. Add the preceding shot's panel as a style reference in the multi-edit pass.
**Rule:** When scripting shots, if two consecutive shots share the same environment, the second shot's prompt must explicitly reference the lighting established in the first.

### 8. Establishing Shots Missing Silhouetted Characters
**Symptom:** Shot 11 (SeehRov silhouetted in doorway) had `characters: []` in the script because he's a distant silhouette, not a face-detail character. The panel generator treated it as an empty scene with "no people" in the negative prompt.
**Root cause:** The binary `characters` array was either "full R2V character" or "empty scene with no people." No middle ground for silhouetted/distant figures.
**Fix:** Added `silhouetteCharacters` field to `ShotScript`. Characters listed here appear in panel prompts (described by wardrobe for silhouette identification) but don't trigger R2V routing or "no people" negative prompts. The prompt builder includes them as "distant silhouetted figure" descriptions.
**Files:** `src/series/types.ts`, `src/mini-drama/prompt-builder.ts`

### 9. Logo/Sigil Mismatch: "Triple-V" vs Actual Venice AI Logo
**Symptom:** Prompts described "Venice triple-V sigil" or "VVV" but the actual Venice AI logo is a crossed-keys design (two ornate skeleton keys crossed in an X with a chevron/book shape at top). Models generated random V-shaped symbols instead.
**Root cause:** The character and series descriptions used shorthand "triple-V" which doesn't describe the actual logo geometry.
**Fix:** Always use the full logo description: "the Venice AI crossed-keys logo — two ornate skeleton keys crossed in an X formation with a chevron/open-book shape at the top where they cross." Describe logos in text prompts only — do not pass logo PNG files as multi-edit references.
**Rule:** Never use "VVV" or "triple-V" in prompts to describe the Venice AI logo. Always describe the crossed-keys geometry.

### 10. Hardcoded R2V Aspect Ratio `9:16` in Mini-Drama Pipeline
**Symptom:** R2V character shots rendered as vertical/portrait despite the series being set to 16:9 landscape.
**Root cause:** `renderVideoFile` in `video-generator.ts` hardcoded `body.aspect_ratio = '9:16'` for all R2V models. This bypassed the corrected default in `models.ts` / `video.ts` because the mini-drama pipeline builds its own request body without calling `queueVideo()` or `buildModelParams()`.
**Fix:** Changed to `body.aspect_ratio = options.aspectRatio ?? '16:9'` and threaded `series.storyboardAspectRatio` through from the render call sites.
**Rule:** Never hardcode aspect ratios in model-specific branches. Always derive from the series `storyboardAspectRatio` setting. After video generation, run `validate-video-outputs` to verify all shots match the expected orientation.
**Files:** `src/mini-drama/video-generator.ts`

### 11. Logo PNG as Multi-Edit Reference Causes Visual Overlay
**Symptom:** Passing `VVV_Token_White.png` (white logo on transparent background) as a multi-edit reference image caused the model to render the logo file as a massive white overlay composited onto the scene, instead of using it as a design reference.
**Root cause:** Multi-edit models interpret reference images literally when they contain large transparent/white areas. The model sees the white shape and composits it rather than extracting the design pattern.
**Fix:** Removed logo PNG from multi-edit reference slots. Describe logo designs in the text prompt only.
**Rule:** Never pass mostly-transparent or mostly-white PNG files as multi-edit references. Describe logos, symbols, and marks in text prompts. Reserve multi-edit reference slots exclusively for character face/body references and scene environment references.

### 12. Close-Up Character Panels: Inverted Pipeline for Better Face Match
**Symptom:** Generating a scene panel from scratch and then multi-editing the face to match a character reference produced a different-looking person — the base generation's face was too dominant for multi-edit to override.
**Root cause:** For tight close-ups, the generated face occupies most of the frame. Multi-edit adjustments are not strong enough to fully replace facial identity at that scale.
**Fix:** Use an "inverted" approach: start from the character's reference image (e.g., `profile.png`) as the base image and multi-edit the background/environment onto it. This guarantees the face IS the reference.
**Rule:** For close-up character shots, prefer the inverted pipeline: start from the character reference image and edit the background, rather than generating a scene and editing the face.

### 13. Seedance 2.0 Blocks Face-Bearing Non-Seedream Images
**Symptom:** Seedance 2.0 video calls 4xx'd when character portraits or character-bearing panels were generated with `nano-banana-pro`, `flux-2-pro`, or any other family. Initially thought to be a blanket ban on all non-seedream images.
**Root cause:** Seedance's gate specifically rejects input images that contain a recognizable human face when they weren't produced by `seedream-v5-lite` / `seedream-v5-lite-edit`. Images without human faces (establishing shots, atmosphere plates, scene refs, object inserts, silhouettes) are accepted from any family.
**Fix:**
- Added `hasFace` tracking to image provenance sidecars.
- Relaxed the pre-flight gate to only flag images where `hasFace !== false` and the generator is non-seedream.
- Split image-model defaults by context: `seedream-v5-lite` for face-bearing work (character refs, character panels, multi-edit character fixes), `nano-banana-pro` for faceless work (atmosphere, establishing, style match). The mini-drama CLI and storyboard assembler pick per-shot based on `shot.characters.length`.
- Added `imageDefaults` and `seedanceCompatibility` to `VideoModelDefaults` so faceless-side defaults remain overridable.
- Added provenance sidecars (`shot-NNN.provenance.json`) via `src/venice/provenance.ts`, written by the storyboard assembler, panel-fixer, reference-manager, and mini-drama panel generator.
- Added a pre-flight gate (`src/venice/seedance-preflight.ts`) that runs before every Seedance call and — if any face-bearing images are incompatible — prompts the user, reroutes the shot to Kling O3 R2V / Veo 3.1, or launders the images through `seedream-v5-lite-edit`.
**Rule:** The Seedance face rule applies only to images with human faces. Always generate character-bearing panels and references with seedream; you can use `nano-banana-pro` freely for atmosphere/establishing/insert shots. When editing face-bearing panels, use `seedream-v5-lite-edit`. If a project intentionally uses non-seedream face-bearing images, override `videoDefaults` to a non-Seedance family (Kling O3 + Veo).
**⚠ SUPERSEDED (2026-07):** Venice removed the seedream-only face restriction entirely — Seedance 2.0 now accepts face-bearing input images from **any** image family. The pre-flight gate is neutralized (always proceeds), `seedanceCompatibility` is no longer auto-set, and the global image default is `nano-banana-2` for all panels (character and faceless). The provenance sidecars are still written but nothing gates on them. See rule 24. This entry is retained as historical context only.
**Files:** `src/venice/provenance.ts`, `src/venice/seedance-preflight.ts`, `src/series/types.ts`, `src/series/manager.ts`, `src/mini-drama/video-generator.ts`, `src/storyboard/assembler.ts`

### 14. Editing Without Transcripts Wastes Tokens
**Symptom:** Agent asked to "edit this footage" started frame-dumping random PNGs from the timeline to decide where to cut, burning tokens without producing a coherent strategy.
**Root cause:** Frame-dump-first is the wrong substrate for cut decisions. 30 minutes of footage at 24fps = 43,200 frames × ~1,500 tokens = 64M tokens of noise. The LLM cannot hold that context and fabricates its way through the edit.
**Fix:** Always transcribe first via `scripts/transcribe-sources.ts`, read the resulting `takes_packed.md` (~12KB), and only call `scripts/timeline-view.ts` at explicit decision points (comparing retakes, resolving an ambiguous pause, verifying a mouth-close before a cut). Inspired by browser-use/video-use.
**Rule:** The text transcript is the primary editing surface. Pixels are consulted on demand only. See `.agents/skills/video-editing/SKILL.md`.
**Files:** `src/editing/packer.ts`, `scripts/transcribe-sources.ts`, `scripts/timeline-view.ts`

### 15. Skipping "Propose Strategy, Wait For Confirmation" Causes Throwaway Renders
**Symptom:** Agent started rendering an EDL before the user had approved the cut strategy. User then asked for a completely different structure, wasting a 15-minute render.
**Root cause:** The render is cheap to launch and expensive to throw away. Without an explicit pre-render confirmation step, intent is inferred and frequently wrong.
**Fix:** `.agents/commands/edit-footage.md` step 3 and `.agents/skills/video-editing/SKILL.md` design principle 3 both mandate: post a summary (sources, duration estimate, trim rules, transitions) and wait for "yes / revise / cancel" BEFORE running `renderEdl()`.
**Rule:** Never render without confirmation. The render is cheap; the redo is not. Video-use design principle 3 is non-negotiable.
**Files:** `.agents/commands/edit-footage.md`, `.agents/skills/video-editing/SKILL.md`

### 16. Auto-Trimming "..." Dead Air From Kokoro VOs Breaks Intended Pacing
**Symptom:** Filler-word detector was configured to trim all silence gaps ≥ 0.45s. This removed the intentional breath beats rendered by Kokoro for `...` in `VO_TEXT`, producing a rushed, rhythm-less VO.
**Root cause:** `...` in a Kokoro TTS script renders as an intentional ~0.6s breath gap. It's a creative beat, not dead air.
**Fix:** `DEFAULT_FILLER_UNIGRAMS` in `src/editing/silence.ts` explicitly excludes `...` and the filler-word detector never touches gaps that were triggered by `...` in aligned mode. Always require user confirmation before a filler trim lands — `you know` and `i mean` can also be content-bearing for certain speakers.
**Rule:** Never auto-trim silence gaps that originated from a script's `...`. Never land filler-word trims without user confirmation. See `.agents/skills/video-editing/SKILL.md` anti-pattern E2.
**Files:** `src/editing/silence.ts`, `.agents/skills/burn-in-subtitles/SKILL.md` rules 1-2

### 17. Rendering Overlays As Part Of The EDL Pass
**Symptom:** Agent baked lower-thirds and title cards into the EDL render, then had to throw away the render when the user wanted to change the overlay wording.
**Root cause:** Overlays are a post-process, not an edit decision. They belong in a separate compositing pass on top of the delivered cut.
**Fix:** Overlay designs live in `OverlayManifest` (`src/editing/overlays.ts`), are rendered via `scripts/render-overlay.ts` on top of `final-edit.mp4`, and produce `delivered.mp4`. The EDL render never touches overlays.
**Rule:** EDL handles cut decisions. Overlays are applied separately. `overlay-designer` agent only runs AFTER the EDL cut is approved.
**Files:** `src/editing/overlays.ts`, `scripts/render-overlay.ts`, `.agents/agents/overlay-designer.md`

### 18. Not Archiving Prior Renders Before A New Edit
**Symptom:** A "quick fix" re-render overwrote a 15-minute `final-edit.mp4` before the user had a chance to compare against the prior version.
**Root cause:** `renderEdl` or `render-overlay.ts` was called without the archive-first path enabled, or a shell one-liner was used that bypassed the harness renderer.
**Fix:** Both `src/editing/render.ts` and `scripts/render-overlay.ts` archive any existing output to `<stem>-v<N>.<ext>` BEFORE writing the new file. This is on by default; disabling it requires passing `--skip-archive` explicitly. Mirrors workspace rule `.cursor/rules/shot-asset-safety.mdc`.
**Rule:** Never bypass the harness renderer for editing output. Never call `ffmpeg` directly to overwrite a delivery file without archiving first.
**Files:** `src/editing/render.ts`, `scripts/render-overlay.ts`, `.cursor/rules/shot-asset-safety.mdc`

### 19. Dialogue/VO Overlap From Per-Speaker Scheduling On Planned (Not Measured) Durations
**Symptom:** In an assembled episode, the narrator's line for one shot was still playing when the next shot's character line (or the next narrator line) began — voices talked over each other at several cuts. Worst on short establishing shots whose narration ran long.
**Root cause:** Two compounding bugs in the assembler's dialogue placement. (a) The no-overlap guard advanced a cursor only for narrator-vs-narrator (`if (isNarrator) prevNarrEnd = …`), so a long narrator line followed by a *character* line — or any character line — got no overlap protection. (b) Each line was placed at the shot's start derived from the script's planned `duration` field, but the rendered/normalized segment was a different length, so the "start of the next shot" the scheduler assumed didn't match the real timeline. A 7.5s narrator line over a 5.0s rendered segment spilled 2.5s into the next shot.
**Fix:** One global `nextFreeSec` cursor for ALL spoken lines (narrator and character alike); place at `max(shotStart + lead, nextFreeSec + gap)`; advance the cursor after every line. Compute `shotStart` from the MEASURED `ffprobe` duration of each segment, not the script slot. See rule 35 (scheduler) and rule 36 (author VO to fit / hold the frame when it can't).
**Files:** any assembler that mixes dialogue (e.g. `src/mini-drama/assembler.ts` and project `*-assemble*.mjs` scripts); add the overlap assertion to the cut-qa audio check (rule 29).

### 20. Visual Continuity Drift Across Separately-Rendered Shots (Identity, Scale, Palette)
**Symptom:** Across shots rendered as separate generations, a character's size, costume, markings, or the scene's palette/lighting changed shot to shot — e.g. a character that grew mid-story appeared small again in a later shot, or a defeated/absent character reappeared.
**Root cause:** Each shot was generated independently. Even with the same reference set, prompts that didn't restate the invariant traits let the model re-interpret scale/wardrobe/markings; and traits that *changed in-story* (a size change, a costume, a character being removed after an event) were not encoded per-shot, so the model reverted to the reference's default.
**Fix:** Re-anchor every shot to the identical canonical refs and restate fixed traits inline in every prompt, including **relative size** and any in-story state change (track a `sizeState`/`presence` per shot). Prefer Seedance native multi-shot (rule 21) for consecutive beats so identity/scale/lighting hold within one generation. Before assembly, render a contact sheet of each shot's first frame and scan for drift; re-roll offenders. See rule 37.
**Files:** prompt builders (`src/mini-drama/prompt-builder.ts`) and project render scripts; first-frame contact-sheet check belongs in the storyboard/QA step.

### 21. Film-Stock Names In Style Prompts Trigger Seedance Film-Burn Flares
**Symptom:** `seedance-2-0-enhanced-*` renders showed persistent orange film-burn / light-leak flares in frame corners — not just at shot boundaries but through entire shots. (The Salt Book, 5 attempts on one shot.)
**Root cause:** The style block named a film stock ("35mm anamorphic, Kodak Portra 400 pushed"). The stock name is the trigger; `negative_prompt` alone does NOT suppress it.
**Fix:** Remove film-stock names from the style block (keep the *look* words: overexposed, chalky, bone white) AND add positive in-prompt language: "Clean pristine frame from edge to edge — absolutely no film burn, no light leaks, no orange or red flares at any frame edge or corner, no vignetting." Keep the negative_prompt too, but it is secondary.

### 22. Prop-Ref Contamination: The Model Re-Stages The Reference Image's Whole Composition
**Symptom:** A prop reference (charred page lying on the ground with a corpse's roped hand on it, yellow sack behind) kept re-staging its own composition into gens — the page returned to the ground, the corpse's hand landed on it, yellow cloth appeared on the living character's wrist — across 4+ re-rolls, *regardless of prompt text forbidding all of it*. Cropping the ref was not enough (leftover corner objects still leaked).
**Root cause:** Seedance treats the entire reference image as staging truth, not just the object it's bound to. Refs are stronger than negative text.
**Fix:** Every prop ref must be a **clean plate**: the prop alone on neutral ground — no hands, no wardrobe, no scene furniture. Build one with `POST /image/edit` (qwen-edit, "Remove the X completely…", multiple passes if needed) — one $0.0x edit call beats fighting the video model. Also add a ref-role clause in the prompt: "@ImageN defines ONLY what the prop LOOKS like; it does NOT define where the prop is." Same technique for staging refs that contain elements which must not recur (e.g. remove the corpse for a character-alone scene).

### 23. Hand/Limb Ownership In Close-Up Inserts Goes To The Wrong Body
**Symptom:** In a hands-only close-up, the folding action was performed by the nearby corpse's roped, yellow-sleeved hands instead of the detective's.
**Root cause:** In an insert shot the model picks WHOSE hands from scene context; any nearby body competes for the limbs.
**Fix:** (a) Stage the insert away from the other body entirely ("he is STANDING, hands at chest height… nothing else in frame: no ground, no body"). (b) Give each character a wrist-level wardrobe signature and ban the wrong one by name ("grey linen sleeves + white shirt cuffs" vs "mustard-yellow sleeves + rope — must NOT appear in this close-up"). (c) Declare the non-actor fully inert ("hands NEVER touch, hold, or fold anything"). Continuity bible character entries should carry a `wrist_signature` field; gen-qa should check inserts for sleeve/cuff mismatches.

### 24. Dialogue Accent Casting Drifts Per Generation
**Symptom:** One gen rendered Greek-accented English while every neighboring gen was standard American — jarring at cuts.
**Root cause:** Seedance infers accent from setting/character context (Greek island → Greek accent). A weak one-liner ("neutral American accent") did not fix it.
**Fix:** A dedicated VOICE DIRECTION block with (a) explicit nationality ("Both actors are AMERICAN"), (b) a concrete anchor ("flat Midwestern… like classic 1950s Hollywood film-noir actors"), (c) per-character voice register descriptions, and (d) "speaks in a flat American accent" repeated inline in each dialogue shot paragraph. Continuity bible should carry a per-character `voice` field injected into every dialogue gen. QA: whisper-transcribe every dialogue gen (catches wrong words); accent needs a human ear — export a review MP3 per dialogue gen.

### 25. Face-Down Bodies Flip Supine (Or Act) Across Re-Rolls
**Symptom:** A corpse staged face-down flipped face-up in ~50% of gens; in others it moved or its face became visible.
**Root cause:** "face down" alone is too weak an anchor; the model prefers showing faces.
**Fix:** Stack redundant prone language: "FACE DOWN, ON HIS STOMACH, his BACK to the sky, the BACK of his head toward camera… NEVER supine, NEVER rolls over… we never see his eyes, nose, mouth" — in the continuity rules AND inline in every shot paragraph where the body appears. Bind a staging reference frame showing the correct position and mark it "must match this image exactly."

### 26. Seedance Replaces Scripted Hard Cuts With Dissolves
**Symptom:** A multi-shot gen rendered one transition as a slow dissolve/superimposition (a face ghosted over an insert) even though the prompt said "separated by hard cuts."
**Root cause:** One mention of "hard cuts" at the top of a multi-shot prompt is not binding per-transition.
**Fix:** Add to the style block: "ALL transitions between shots are instant HARD CUTS — never dissolves, never cross-fades, never superimpositions, never double-exposures." Keep the "CUT TO:" separators between shot paragraphs.

### 27. Seedance Face-Media Consent 409 And Queue-Attempt Rate Limit
**Symptom:** (a) R2V/i2v requests with human-face references returned 409 `needs_consent`. (b) After ~20 failed queue attempts, the account tripped a 30s 429.
**Fix:** (a) Attach `consents.seedance: { confirmed_terms_and_privacy: true, confirmed_legal_right: true, confirmed_screening_acknowledged: true }` to `/video/queue` for face-bearing requests — surface the policy text once per session for the user to ack, then auto-attach. (b) Back off on repeated 4xx; don't hammer the queue endpoint.

### 28. Spatial Drift Across Shots: Side-Swaps, Teleporting Props, Mirrored Geography
**Symptom:** Two shots that read as the same scene disagree spatially — a character who was screen-left in the master is screen-right in coverage; a prop on the table has moved or vanished; the room's layout is mirrored (door now on the other side); eyelines cross the 180-degree line so speakers appear to look the same way.
**Root cause:** Prompts described the *action* but left placement implicit, so every generation re-inferred the geometry from scratch. Identity references lock what things look like, not where they are; the blocking plate helps, but a plate alone (without matching placement language in the prompt) is a weak anchor the model can reinterpret or mirror.
**Fix:** Author the geometry once and restate it identically everywhere (rule 49): lock each location's landmark layout in `Location.spatialAnchors`, write per-shot `blocking` (position vs named anchors + frame side + depth + facing/eyeline), and let the harness inject both into panel, plate, and video prompts verbatim. Keep screen sides and eyelines constant across a scene's shots unless a movement is scripted. QA panels for spatial continuity against the previous same-location panel (the fourth `qa-storyboard` dimension); treat a side-swap or mirrored geography as FLAG-CRITICAL and re-roll before rendering video.

## Output

Generated project output belongs in:

```text
output/
```

No active generated projects are included in this harness copy.

## Environment

- `VENICE_API_KEY` in `.env` (required)
- `ffmpeg` and `ffprobe` on PATH (for video/audio processing)
- Node.js 20+ with TypeScript (ES modules, Node16 resolution)

## Important

- This is an agent-operated harness first, not a CLI-first app
- It is Venice-specific and consistency-focused by design
- The included mini-drama workflow is a reference implementation, not the only intended use case
- The model registry is synced from the live Venice API -- update it when Venice adds new models
