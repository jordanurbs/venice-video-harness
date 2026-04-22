# Venice Video Harness

This workspace is an agent-first, Venice-optimized harness for **consistency-first video creation at any length and format**.

It is meant to be operated through natural language in an IDE like Cursor or VS Code with an agent such as Claude Code. The user should not be asked to run terminal commands manually. The agent reads the rules, selects the right playbooks, and executes code as needed.

## What This Harness Does

1. Helps an agent plan and execute consistency-first Venice video workflows
2. Supports recurring characters, locked visual systems, and reference-driven generation
3. Provides reusable orchestration through `CLAUDE.md`, `.claude/commands/`, `.claude/agents/`, and `.claude/skills/`
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
- Orchestration rules in `CLAUDE.md`
- Workflow playbooks in `.claude/commands/`
- Reusable Venice knowledge in `.claude/skills/`
- Underlying TypeScript and script execution in `src/` and `scripts/`

The CLI and scripts are the execution layer underneath the harness, not the primary user interface.

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
- `seedance-2-0-image-to-video` (default atmosphere + action model, 4-15s, 720p, native stereo audio, #1 ranked)
- `veo3.1-fast-image-to-video` (4-8s, up to 4K, audio)
- `veo3-fast-image-to-video` (8s, audio)
- `pixverse-v5.6-image-to-video` (5-8s, up to 1080p, audio)

**Character Consistency (Reference-to-Video):**
- `seedance-2-0-reference-to-video` (default R2V, 4-15s, `reference_image_urls` up to 4, `@Image` tags, native audio, #1 ranked)
- `kling-o3-standard-reference-to-video` (fallback for 3+ characters, 3-15s, `elements`, `reference_image_urls`, `scene_image_urls`)
- `kling-o3-pro-reference-to-video` (3-15s, full reference support)

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
| `reference_image_urls` (flat ref array) | Seedance 2.0 R2V, Kling O3 R2V, Vidu Q3 |
| `scene_image_urls` (environment refs) | Kling O3 R2V (standard + pro) |
| `end_image_url` (frame targeting) | All Kling image-to-video, PixVerse Transition |
| `audio_url` (background audio input) | Wan 2.6, Wan 2.5 Preview |
| `@Image` tags (flat ref prompt syntax) | Seedance 2.0 R2V, Grok Imagine R2V |
| Native stereo audio with lip-sync | Seedance 2.0 (8+ languages) |
| 4K output | Veo 3.1, LTX 2.0 |
| 30s duration | Longcat |
| 20s duration | LTX 2.0 Fast, LTX 2.0 v2.3 Fast |
| 15s duration | Seedance 2.0, Kling O3/V3, Wan 2.6 |

### Image Generation Models

`nano-banana-pro` (default for storyboard), `nano-banana-2`, `flux-2-pro`, `flux-2-max`, `gpt-image-1-5`, `grok-imagine`, `hunyuan-image-v3`, `qwen-image-2`, `qwen-image-2-pro`, `recraft-v4`, `recraft-v4-pro`, `seedream-v4`, `seedream-v5-lite`, `chroma`, `hidream`, and more.

### Multi-Edit Models (10 models)

`qwen-edit`, `qwen-image-2-edit`, `qwen-image-2-pro-edit`, `flux-2-max-edit`, `gpt-image-1-5-edit`, `grok-imagine-edit`, `nano-banana-2-edit`, `nano-banana-pro-edit`, `seedream-v4-edit`, `seedream-v5-lite-edit`

### TTS Models

- **Kokoro** (`tts-kokoro`): 50+ voices across English, Chinese, Japanese, Korean, Spanish, French, Hindi, Italian, Portuguese
- **Qwen3** (`tts-qwen3-0-6b`, `tts-qwen3-1-7b`): Style-prompted voices (Vivian, Serena, Dylan, Eric, Ryan, Aiden, etc.) with emotion/delivery control
- **ElevenLabs** (`elevenlabs-tts-v3`, `elevenlabs-tts-multilingual-v2`): Premium TTS

### Music / SFX Models

- **Music**: `elevenlabs-music`, `minimax-music-v2`, `ace-step-15`, `stable-audio-25`
- **SFX**: `elevenlabs-sound-effects-v2`, `mmaudio-v2-text-to-audio`

## Default Venice Routing

**Core principle: Seedance R2V by default, Kling O3 R2V fallback for 3+ character scenes, Seedance i2v for establishing shots.**

Almost all shots should use a reference-to-video model for identity anchoring. Seedance 2.0 R2V (#1 ranked) is the new default, using flat `reference_image_urls` with `@Image` prompt tags. For shots with 3+ characters, the system automatically falls back to Kling O3 R2V which provides structured `elements` for better per-character identity separation. Empty establishing/mood shots use Seedance i2v for its superior cinematic quality and physics.

Preferred defaults (overridable per-project via `series.json` → `videoDefaults`):

| Role | Default Model | When Used |
|------|--------------|-----------|
| Character shots (1-2 characters) | `seedance-2-0-reference-to-video` | Default R2V — `reference_image_urls` with `@Image` tags, up to 15s, native stereo audio |
| Character shots (3+ characters) | `kling-o3-standard-reference-to-video` | Auto-fallback — structured `elements` + `reference_image_urls` for multi-character identity |
| Establishing / mood / action (no chars) | `seedance-2-0-image-to-video` | Epic cinematic quality, physics-aware, up to 15s, native audio |
| Image Generation (face-bearing) | `seedream-v5-lite` | **Required** when the image contains a human face and the video target is Seedance 2.0 |
| Image Generation (faceless) | `nano-banana-pro` | Atmosphere / establishing / scene refs — any family is fine, nano-banana-pro gives best quality |
| Multi-Edit (character fix) | `seedream-v5-lite-edit` | Required when editing a face-bearing panel that will feed Seedance |
| Multi-Edit (style-match, no face) | `nano-banana-pro-edit` | Refining non-character panels — any family works |
| TTS | `tts-kokoro` | 50+ voices, fast, consistent |
| Music | `elevenlabs-music` | High quality music generation |
| SFX | `elevenlabs-sound-effects-v2` | Best sound effect quality |

### Image / Video Family Pairing

Seedance 2.0 only blocks **face-bearing** input images that weren't produced by `seedream-v5-lite` or edited by `seedream-v5-lite-edit`. Faceless images (establishing shots, atmosphere plates, object inserts, scene refs, silhouettes) pass through any family without a problem.

The harness therefore picks the image model per-shot based on whether the shot contains characters:

- Character panels / references → `seedream-v5-lite` (and `seedream-v5-lite-edit` for fixes) — required for Seedance
- Atmosphere / establishing panels → `nano-banana-pro` (the series' configurable `videoDefaults.imageDefaults.generationModel`) — gives better quality for non-character scenes

If the video target isn't Seedance at all (e.g. Kling / Veo), face-bearing shots don't need seedream either — override `videoDefaults` and you can use `nano-banana-pro` across the board.

### Seedance Pre-flight Gate

Before every Seedance call, the harness reads the provenance sidecars next to each input image and skips any marked `hasFace: false`. Face-bearing images (or images with unknown face status) are validated against the seedream compatibility set. If any face-bearing images were produced by a non-seedream family, behavior is controlled by `series.videoDefaults.seedanceCompatibility`:

- `prompt` (default in interactive shells): print the offending files and ask the user to choose `fallback` or `launder`
- `fallback` (default in non-TTY / CI): reroute this specific shot to the Kling O3 R2V / Veo 3.1 fallback so the original Seedance-incompatible assets still work
- `launder`: re-render each incompatible image through `seedream-v5-lite-edit` with a neutral "preserve image" prompt before retrying the Seedance call (archives the pre-launder original next to each file)

The provenance sidecar format is `shot-NNN.provenance.json` next to each PNG:

```json
{
  "generationModel": "seedream-v5-lite",
  "editModels": ["seedream-v5-lite-edit"],
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

- `.claude/skills/video-editing/SKILL.md` — full philosophy, EDL format, anti-patterns
- `.claude/commands/edit-footage.md` — end-to-end playbook
- `.claude/agents/cut-qa.md` — post-render quality gate
- `.claude/agents/overlay-designer.md` — branded motion-graphics planner
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
10. **Always validate durations against model specs.** Seedance 2.0 accepts 4s/5s/8s/10s/12s/15s — not all integers. The video queue function auto-snaps invalid durations to the nearest valid value.
11. **Front-load style in all prompts.** Aesthetic/style descriptions must appear at the START of prompts, not buried at the end. This prevents style drift across angles and shots.
12. **Use cfg_scale 10 for character references and storyboard panels.** Lower values (e.g., 7) allow the model too much freedom, causing style inconsistency between angles.
13. **Always pass `aspectRatio: '16:9'` (or the series ratio) explicitly to R2V video generation.** The R2V model requires `aspect_ratio` and will default to 16:9 if omitted, but always be explicit to prevent orientation bugs.
14. **Never multi-edit close-up face shots on 16:9 panels.** The 1024x1024→16:9 crop removes ~25% from top/bottom, losing foreheads and chins. Generate close-up panels from scratch with `nano-banana-pro` instead, then use multi-edit only for medium/wide shots.
15. **Match lighting across consecutive shots in the same location.** When generating panels for sequential shots in the same environment, style-match later shots against earlier ones. Explicitly describe the established lighting in each subsequent prompt.
16. **Use `silhouetteCharacters` for distant/silhouetted figures.** Characters visible only as silhouettes (e.g., figure in doorway) go in `silhouetteCharacters`, not `characters`. This ensures they appear in panels without triggering R2V routing or "no people" negative prompts.
17. **Describe the Venice AI logo as crossed-keys, never as "triple-V" or "VVV".** The actual logo is two ornate skeleton keys crossed in an X with a chevron/book at top. Use the full geometric description in prompts, or multi-edit with the logo PNG as reference.
18. **Use Kling 3.0 native multi-shot for sequences within a single generation.** Structure: define subjects with `@Element` refs up front, label shots as `Shot N (Xs):`, use `[Character, voice description]: "dialogue"` format, and separate shots with `Immediately, cut to:`. This produces a single video with multiple shots — no concatenation needed. Max 6 shots, 15s total. See [Kling 3.0 Prompting Guide](https://blog.fal.ai/kling-3-0-prompting-guide/).
19. **Seedance 2.0 R2V uses `@Image` tags, not `@Element` tags.** When the resolved model is Seedance R2V, replace character names with `@Image1`, `@Image2` in prompts. Do NOT use `@Element` tags — Seedance does not support structured elements. The prompt builder handles this automatically via `useImageTags`.
20. **Keep Seedance prompts under 60 words for best results.** Seedance responds to precision, not volume. Use the 5-part structure: Subject, Action (present tense, one verb), Camera (shot size + movement), Style (lighting, color), Constraints (what to exclude). See [Seedance prompting guide](https://venice.ai/blog/seedance-sota-video-generation-live-on-venice).
21. **Use "lens switch" for Seedance multi-shot sequences.** Seedance 2.0 supports native multi-shot via "lens switch" in prompts to signal cuts, maintaining character/environment continuity across transitions within a single generation.
22. **Seedance excels at physics-aware prompting.** Describe forces, not just actions — "tires smoke as car drifts 90 degrees" rather than "car turns." Friction, weight, material interactions, and contact physics produce better results with Seedance's physics-aware training.
23. **3+ character shots auto-fallback to Kling O3 R2V.** When the default R2V model is Seedance (flat refs, max 4 images), shots with 3+ characters automatically fall back to Kling O3 R2V which supports structured `elements` for better per-character identity separation.
24. **Seedance only blocks face-bearing images from non-seedream families.** Character portraits, character panels, and any image that depicts a recognizable human face must come from `seedream-v5-lite` or `seedream-v5-lite-edit` when the video target is Seedance 2.0. Faceless images (atmosphere plates, establishing shots, object inserts, silhouettes, scene refs) are accepted from any family. The provenance sidecar records `hasFace: true|false` and the pre-flight gate skips faceless images automatically. When editing existing face-bearing assets, pass them through `seedream-v5-lite-edit` first, or switch the video target to a non-Seedance family (Kling O3 R2V + Veo 3.1). See `src/venice/seedance-preflight.ts` and `src/venice/provenance.ts`.
25. **Always ask before burning in subtitles.** Before assembling the final video on any project that includes a VO track, ask the user "Burn in subtitles? (yes / no)" — burn-in is a permanent baked-into-pixels decision and is not always wanted. If yes, follow `.claude/skills/burn-in-subtitles/SKILL.md`: never hand-estimate caption timings, always derive them from `ffmpeg silencedetect` on the rendered VO via `.claude/skills/burn-in-subtitles/scripts/derive-captions.ts`, and use single `...` ellipses only in TTS VO_TEXT (doubled `......` cause Kokoro/ElevenLabs to silently truncate the audio).
26. **Never use doubled ellipses in TTS VO scripts.** Kokoro and ElevenLabs handle single `...` reliably as breath gaps. Doubled `......` cause silent truncation — the audio file ends mid-script with no error, and you only catch it when downstream captions reference dropped text. Use commas + single `...` for combined rhythm, or break across multiple TTS calls and concat with ffmpeg `apad`.
27. **Editing pipeline is text-first.** When the task is to cut / trim / re-order existing media (not synthesize new shots), always transcribe sources first via `scripts/transcribe-sources.ts` and reason over `takes_packed.md`. Call `scripts/timeline-view.ts` ONLY at explicit decision points — never frame-dump to browse the footage. See `.claude/skills/video-editing/SKILL.md`.
28. **Never render an EDL without user confirmation of the cut strategy.** Post a summary (sources, duration, trim rules, transitions) and wait for "yes" before calling `renderEdl()`. The render is cheap; a throwaway 15-minute render because intent was guessed is not. Mirrors video-use design principle 3.
29. **Always run cut-qa after every assembly / edit render.** The `cut-qa` agent runs 6 programmatic checks (aspect, visual jump, VO truncation, lighting, audio pop, subtitle overlap) at cut boundaries. Max 3 fix iterations before surfacing to the user. Applies to BOTH the generation-pipeline assembler and the editing-pipeline render.
30. **Overlays are a post-process, never baked into the EDL render.** Lower-thirds, title cards, chapter markers, and logo-bugs live in an `OverlayManifest` rendered via `scripts/render-overlay.ts` on top of `final-edit.mp4`. Changing overlay wording must not require re-rendering the cut.
31. **Never auto-trim silence gaps that originated from `...` in a TTS script.** Those are intentional breath beats rendered by Kokoro / ElevenLabs, not dead air. The filler-word detector (`src/editing/silence.ts`) excludes them. User confirmation is required for every filler-word trim before it lands in an EDL.

## Learned Anti-Patterns (Production Issues Log)

Issues discovered during production and their fixes. The agent should internalize these to avoid repeating them.

### 1. Multi-Shot Grouping Bug: Wrong Character Overlap Check
**Symptom:** Shots cutting between different characters (e.g., Chad-only → Vivienne-only) were grouped into Kling multi-shot units, which use `kling-o3-pro-image-to-video` — a model with NO `elements` or `reference_image_urls` support. Characters lost all identity anchoring.
**Root cause:** `hasOverlappingCharacters()` checked each shot's characters against the union pool instead of requiring pairwise overlap between consecutive shots.
**Fix:** Rewrote to require every consecutive pair of shots to share at least one character. Shots with disjoint characters now always render as singles with R2V.
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
**Files:** `src/venice/provenance.ts`, `src/venice/seedance-preflight.ts`, `src/series/types.ts`, `src/series/manager.ts`, `src/mini-drama/video-generator.ts`, `src/storyboard/assembler.ts`

### 14. Editing Without Transcripts Wastes Tokens
**Symptom:** Agent asked to "edit this footage" started frame-dumping random PNGs from the timeline to decide where to cut, burning tokens without producing a coherent strategy.
**Root cause:** Frame-dump-first is the wrong substrate for cut decisions. 30 minutes of footage at 24fps = 43,200 frames × ~1,500 tokens = 64M tokens of noise. The LLM cannot hold that context and fabricates its way through the edit.
**Fix:** Always transcribe first via `scripts/transcribe-sources.ts`, read the resulting `takes_packed.md` (~12KB), and only call `scripts/timeline-view.ts` at explicit decision points (comparing retakes, resolving an ambiguous pause, verifying a mouth-close before a cut). Inspired by browser-use/video-use.
**Rule:** The text transcript is the primary editing surface. Pixels are consulted on demand only. See `.claude/skills/video-editing/SKILL.md`.
**Files:** `src/editing/packer.ts`, `scripts/transcribe-sources.ts`, `scripts/timeline-view.ts`

### 15. Skipping "Propose Strategy, Wait For Confirmation" Causes Throwaway Renders
**Symptom:** Agent started rendering an EDL before the user had approved the cut strategy. User then asked for a completely different structure, wasting a 15-minute render.
**Root cause:** The render is cheap to launch and expensive to throw away. Without an explicit pre-render confirmation step, intent is inferred and frequently wrong.
**Fix:** `.claude/commands/edit-footage.md` step 3 and `.claude/skills/video-editing/SKILL.md` design principle 3 both mandate: post a summary (sources, duration estimate, trim rules, transitions) and wait for "yes / revise / cancel" BEFORE running `renderEdl()`.
**Rule:** Never render without confirmation. The render is cheap; the redo is not. Video-use design principle 3 is non-negotiable.
**Files:** `.claude/commands/edit-footage.md`, `.claude/skills/video-editing/SKILL.md`

### 16. Auto-Trimming "..." Dead Air From Kokoro VOs Breaks Intended Pacing
**Symptom:** Filler-word detector was configured to trim all silence gaps ≥ 0.45s. This removed the intentional breath beats rendered by Kokoro for `...` in `VO_TEXT`, producing a rushed, rhythm-less VO.
**Root cause:** `...` in a Kokoro TTS script renders as an intentional ~0.6s breath gap. It's a creative beat, not dead air.
**Fix:** `DEFAULT_FILLER_UNIGRAMS` in `src/editing/silence.ts` explicitly excludes `...` and the filler-word detector never touches gaps that were triggered by `...` in aligned mode. Always require user confirmation before a filler trim lands — `you know` and `i mean` can also be content-bearing for certain speakers.
**Rule:** Never auto-trim silence gaps that originated from a script's `...`. Never land filler-word trims without user confirmation. See `.claude/skills/video-editing/SKILL.md` anti-pattern E2.
**Files:** `src/editing/silence.ts`, `.claude/skills/burn-in-subtitles/SKILL.md` rules 1-2

### 17. Rendering Overlays As Part Of The EDL Pass
**Symptom:** Agent baked lower-thirds and title cards into the EDL render, then had to throw away the render when the user wanted to change the overlay wording.
**Root cause:** Overlays are a post-process, not an edit decision. They belong in a separate compositing pass on top of the delivered cut.
**Fix:** Overlay designs live in `OverlayManifest` (`src/editing/overlays.ts`), are rendered via `scripts/render-overlay.ts` on top of `final-edit.mp4`, and produce `delivered.mp4`. The EDL render never touches overlays.
**Rule:** EDL handles cut decisions. Overlays are applied separately. `overlay-designer` agent only runs AFTER the EDL cut is approved.
**Files:** `src/editing/overlays.ts`, `scripts/render-overlay.ts`, `.claude/agents/overlay-designer.md`

### 18. Not Archiving Prior Renders Before A New Edit
**Symptom:** A "quick fix" re-render overwrote a 15-minute `final-edit.mp4` before the user had a chance to compare against the prior version.
**Root cause:** `renderEdl` or `render-overlay.ts` was called without the archive-first path enabled, or a shell one-liner was used that bypassed the harness renderer.
**Fix:** Both `src/editing/render.ts` and `scripts/render-overlay.ts` archive any existing output to `<stem>-v<N>.<ext>` BEFORE writing the new file. This is on by default; disabling it requires passing `--skip-archive` explicitly. Mirrors workspace rule `.cursor/rules/shot-asset-safety.mdc`.
**Rule:** Never bypass the harness renderer for editing output. Never call `ffmpeg` directly to overwrite a delivery file without archiving first.
**Files:** `src/editing/render.ts`, `scripts/render-overlay.ts`, `.cursor/rules/shot-asset-safety.mdc`

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
