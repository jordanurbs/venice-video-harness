# Venice Video Harness

A standalone, Venice-optimized CLI for **consistency-first video creation** at any length.

Install it, enter a Venice API key, and create films directly from the terminal. No coding agent, IDE extension, or MCP host is required. The same repository also includes optional orchestration material for agent-driven workflows.

Use it for:

- **Character-consistent video projects** (any genre, any length)
- **Visual-style-locked series or campaigns**
- **Storyboard-to-video workflows**
- **Short-form and long-form narrative content** (mini-dramas, documentaries, explainers)
- **Branded cinematic sequences, trailers, and teasers**
- **Recurring-character social series**
- **Any multi-shot Venice workflow where continuity matters**
- **Text-first editing of existing footage** — transcribe sources with local whisper.cpp, read the 12KB pack, propose a cut, render with 30ms audio fades, then self-eval at every cut boundary. Inspired by [browser-use/video-use](https://github.com/browser-use/video-use).

## What This Is

Most Venice integrations are thin wrappers around API calls. This package is the higher-level production layer:

- **Standalone `venice-video` CLI** with setup, diagnostics, project creation, generation, QA, assembly, and export commands
- **Direct Venice API client** with retries, rate limiting, deprecation warnings, and async media polling
- **Persistent project state** for characters, locations, episodes, references, recipes, and provenance
- **Comprehensive model registry** covering Venice video, image, audio, and music models
- **Optional agent orchestration** in `AGENTS.md` and `.claude/` for users who want natural-language operation

## Supported Venice Models (April 2026)

### Video Models

Live catalog as of **2026-05-20** (synced against `GET /api/v1/models?type=video` — 103 entries). Families the harness routes to today; private / `-video-to-video` / `-extend-video` variants exist in the live catalog but aren't surfaced here.

| Family | Image-to-Video | Text-to-Video | Max Duration | Audio | Special Features |
|--------|---------------|---------------|-------------|-------|-----------------|
| **Seedance 2.0** | i2v, R2V | t2v | 15s | Yes (stereo, lip-sync 8+ langs) | **#1 ranked.** R2V: flat `reference_image_urls`, `@Image` tags. Default routing target. |
| **Seedance 2.0 Fast** | i2v, R2V | t2v | 15s | Yes | Cheaper / faster Seedance 2.0 variant. Same 4-15s ladder, same provenance gate. |
| **Seedance 1.5 Pro** | i2v | t2v | 12s | Yes | Older Seedance line; kept for parity. |
| **HappyHorse 1.1** | i2v, R2V (up to 9 refs) | t2v | 15s | Yes (joint single-pass, 7-lang phoneme lip-sync) | **#1 blind-preference T2V + I2V** (Alibaba 15B). 3-15s, 720p/1080p, nine aspect ratios. Best for talking characters + multilingual localization; SFW/commercial-leaning. The `happyhorse` video-family now routes here. |
| **HappyHorse 1.0** | i2v, R2V | t2v | 15s | Yes | Prior line, kept for back-compat. Livelier hand-camera realism / cinematic grain vs Seedance. |
| **MiniMax H3** | i2v, R2V (up to 9 refs) | t2v | 15s (**5s floor**) | Yes (native stereo, not toggleable) | Open-weight omni-modal model — one net covers T2V/I2V/reference. **2K is the only resolution** (no draft tier) at ~1/3 the per-second cost of other families; 24fps, 2500-char prompts. The `minimax-h3` video-family routes here. Sub-5s durations are a hard 400. |
| **Wan 2.7** | i2v, R2V, V2V, Spicy | t2v | 15s | Wan i2v has no audio; lip-syncs via `audio_url` input | **Lip-sync flagship.** Only Venice model with proper `audio_url`-driven mouth motion. R2V exposes per-element `audio_url` for multi-speaker. Spicy = uncensored i2v variant. |
| **Wan 2.6** | Standard, Flash, R2V | Standard | 15s | Yes (i2v/t2v); R2V capped at 10s | Now has R2V variant with `audio_url` input. 1080p. |
| **Wan 2.5 Preview** | i2v | t2v | 10s | Yes | `audio_url` input. |
| **Wan 2.2 A14B** | — | t2v | 5s | No | Legacy text-to-video. |
| **Wan 2.1 Pro** | i2v | — | 6s | No | Legacy. |
| **Runway Gen-4.5** | Gen-4.5, Turbo, Aleph | Gen-4.5 Text | 10s | No (silent) | Strong motion physics; 7 aspect ratios. No R2V, no audio, no end-image. |
| **Sora 2** | Standard, Pro | Standard, Pro | Standard 12s / **Pro 20s** | Yes | Pro now reaches 20s + `true_1080p` resolution. |
| **Veo 3.1** | Fast, Full | Fast, Full | 8s | Yes | Up to 4K resolution. |
| **Veo 3** | Fast, Full | Fast, Full | 8s | Yes | |
| **Kling O3** | Pro, Standard, 4K + R2V variants | Pro, Standard, 4K | 15s | Yes | R2V: `elements`, `reference_image_urls`, `scene_image_urls`. 4K variants for delivery-grade output. |
| **Kling V3** | Pro, Standard, **4K R2V** | Pro, Standard, **4K** | 15s | Yes | 4K variants added 2026-05+. `end_image_url` on R2V. |
| **Kling 2.6 Pro** | i2v | t2v | 10s | Yes | `end_image_url`. |
| **Kling 2.5 Turbo Pro** | i2v | t2v | 10s | No | `end_image_url`. |
| **PixVerse C1** | i2v, R2V, Transition | t2v | **15s** | Yes | Replaces v5.6: same four resolutions but 15s ladder + new R2V variant. |
| **PixVerse v5.6** | Standard, Transition | Standard | 8s | Yes | Legacy; prefer C1 for new projects. |
| **Grok Imagine** | i2v, **R2V**, V2V | t2v | i2v/V2V/t2v 15s · R2V 5/8/10s | i2v/t2v: yes · R2V: no | R2V added 2026-05+ (no longer needs Kling fallback). 7 aspect ratios. |
| **LTX Video 2.0** | Fast, Full, v2.3, 19B + V2V/extend | Fast, Full, v2.3, 19B | 20s (Fast/v2.3) · 10s (Full) · 18s (19B) | Yes | Up to 4K, longest durations. |
| **Longcat** | Standard, Distilled | Standard, Distilled | **30s** | No | Longest single-shot for non-talking-head work. |
| **Vidu Q3** | i2v | t2v | 16s | Yes | `reference_image_urls`. |
| **OVI** | i2v | — | 5s | Yes | |

> **Seedance face rule (removed 2026-07):** Seedance 2.0 used to reject face-bearing input images that weren't produced by `seedream-v5-lite` / `seedream-v5-lite-edit`. Venice removed that restriction — any image family now works for face-bearing inputs, so the harness uses `nano-banana-2` for all panels. See [Image / Video Family Pairing](#image--video-family-pairing) below.

### Image Models (28 entries, 2026-05-20 sync)

`nano-banana-pro`, `nano-banana-2`, `gpt-image-2` (high-quality alternative to `nano-banana-pro`), `gpt-image-1-5`, `flux-2-pro`, `flux-2-max`, `grok-imagine-image`, `grok-imagine-image-quality`, `hunyuan-image-v3`, `imagineart-1.5-pro`, `qwen-image-2`, `qwen-image-2-pro`, `recraft-v4`, `recraft-v4-pro`, `seedream-v4`, `seedream-v5-lite`, `chroma`, `hidream`, `venice-sd35`, `lustify-sdxl`, `lustify-v7`, `lustify-v8`, `wai-Illustrious`, `z-image-turbo`, `ernie-image`, `ernie-image-turbo`, `wan-2-7-text-to-image`, `wan-2-7-pro-text-to-image`, `bria-bg-remover`

New since the last sync: `grok-imagine-image`, `grok-imagine-image-quality`, `lustify-v8`, `ernie-image`, `ernie-image-turbo`, `wan-2-7-text-to-image`, `wan-2-7-pro-text-to-image`. Sunset: bare `qwen-image` (use `qwen-image-2`).

### Multi-Edit Models

`qwen-edit`, `qwen-image-2-edit`, `qwen-image-2-pro-edit`, `flux-2-max-edit`, `gpt-image-2-edit` (high-quality alternative to `nano-banana-pro-edit`), `gpt-image-1-5-edit`, `grok-imagine-edit`, `nano-banana-2-edit`, `nano-banana-pro-edit`, `seedream-v4-edit`, `seedream-v5-lite-edit`

### Audio / Music Models

- **TTS**: `tts-kokoro` (50+ voices), `tts-qwen3-0-6b`, `tts-qwen3-1-7b` (style-prompted voices)
- **Music**: `elevenlabs-music`, `minimax-music-v2`, `minimax-music-v25`, `minimax-music-v26`, `lyria-3-pro`, `ace-step-15`, `stable-audio-25`
- **Expressive speech / prompt-driven audio**: `seed-audio-1-0` (BytePlus Seed Audio 1.0 — 25 named voices, speed 0.5–2, up to a 2048-char prompt; premium prompt-directed narration/VO via the async audio queue). Use `generate-audio --prompt … [--voice … --speed …]`.
- **SFX**: `elevenlabs-sound-effects-v2`, `mmaudio-v2-text-to-audio`
- **TTS (ElevenLabs)**: `elevenlabs-tts-v3`, `elevenlabs-tts-multilingual-v2`

## What Makes It Venice-Optimized

- Image prompts tuned for Venice image generation models
- Two-pass panel generation with Venice multi-edit refinement
- **Model-routing logic** for action, atmosphere, and character-consistency tiers
- Support for reference-aware video generation (`elements`, `reference_image_urls`, `scene_image_urls`)
- Environment-aware prompt adaptation (daytime vs night scenes)
- Venice-native audio generation paths for TTS, SFX, and music
- **Video quote endpoint** for cost estimation before generation
- Model-aware parameter building (auto-skips unsupported params per model)
- **Parallel editing pipeline** — transcribe existing footage locally, read a 12KB pack, render with 30ms audio fades, self-eval at every cut boundary

## Project Structure

```
AGENTS.md                        Agent orchestration hub
.claude/
  commands/                      19 workflow playbooks (see below)
  agents/                        6 specialized agent roles (see below)
  skills/                        6 Venice and workflow knowledge packs (see below)
.cursor/rules/                   IDE-level safety rules
src/
  venice/                        Venice API client layer
    client.ts                    HTTP transport, retries, rate limiting
    models.ts                    Complete model registry (50+ models)
    video.ts                     Video queue/retrieve/quote/complete
    generate.ts                  Image generation
    multi-edit.ts                Multi-image layered editing
    edit.ts                      Upscale, background remove
    audio.ts                     TTS, music, SFX, queued audio
    voices.ts                    Voice catalog (Kokoro + Qwen3)
    types.ts                     Full API type definitions
  series/                        Project state and character management
    manager.ts                   Create/load/save series
    types.ts                     Character, ShotScript, SeriesState types
  mini-drama/                    Reference narrative video implementation
    cli.ts                       Commander CLI (25+ commands)
    prompt-builder.ts            Image + video prompt construction
    video-generator.ts           Video rendering with frame chaining
    generation-planner.ts        Single vs multi-shot planning
    panel-fixer.ts               Multi-edit character correction
    subtitle-generator.ts        SRT from script
    assembler.ts                 Video assembly + audio mix
  editing/                       Parallel editing pipeline (inspired by browser-use/video-use)
    types.ts                     WordTiming, Take, TakesPack, Edl, EditSession
    packer.ts                    Collapse word streams -> takes_packed.md
    aligner.ts                   Ground-truth script alignment for generated VO
    providers/whisper-cpp.ts     Local transcription provider
    edl.ts                       EDL authoring + ffmpeg rendering
    silence.ts                   silencedetect wrapper + filler-word detection
    render.ts                    EDL -> final-edit.mp4 with 30ms audio fades
    self-eval.ts                 Drive cut-qa agent, max 3 iterations
    overlays.ts                  Overlay manifest types
  storyboard/                    Legacy screenplay storyboard pipeline
  characters/                    Character extraction and references
  parsers/                       Fountain + PDF screenplay parsing
  assembly/                      Remotion scaffold and manifest
scripts/                         Utility scripts (.ts tracked, .mjs gitignored)
templates/                       HTML storyboard viewer template
output/                          Generated projects (gitignored)
```

## Getting Started

### Requirements

- Node.js 20+
- `ffmpeg` and `ffprobe` on your PATH
- A Venice API key
- **Optional (editing pipeline):** `whisper-cpp` on PATH for local transcription

### Standalone install

The CLI works directly against the Venice API. Cursor, Claude Code, OpenCode,
MCP, and other agent harnesses are optional integrations, not runtime requirements.

```bash
npm install -g venice-video-harness --foreground-scripts
venice-video setup
venice-video doctor
venice-video new
```

The `--foreground-scripts` flag makes the package's PATH diagnostic visible;
modern npm otherwise suppresses successful post-install output. After installation,
verify that your shell can find the executable:

```bash
command -v venice-video
venice-video --version
```

If npm reports a successful install but `venice-video` is not found, npm's global
`bin` directory is not on your shell `PATH`. The install output prints the exact
directory and an `export PATH=...` command when it detects this condition. You can
also inspect the directory manually:

```bash
NPM_BIN="$(npm prefix -g)/bin"
echo "$NPM_BIN"
export PATH="$NPM_BIN:$PATH"
```

Add that `export` line to `~/.zshrc`, `~/.bashrc`, or the startup file for your
shell, then open a new terminal. Node version managers can create this mismatch
when the active `npm` installs globally somewhere different from the active
Node shim.

`venice-video setup` prompts for the API key without echoing it, validates it,
and stores it in the OS-appropriate user configuration directory with owner-only
permissions. It also records a default project workspace. Environment variables
still take precedence for CI or ephemeral use:

```bash
export VENICE_API_KEY=your_key
export VENICE_VIDEO_WORKSPACE=~/VeniceVideos
```

After `new`, the CLI hands the project to one guided control center:

```bash
venice-video workshop -p ~/VeniceVideos/my-film
# Noninteractive: --outcome "Leave viewers exhilarated, then unsettled by the signal"
```

The workshop develops the complete project—not only a shot list:

- audience outcome, audience, runtime, constraints, and optional dragged reference files/directories
- logline, synopsis, themes, acts/movements, and story beats
- visual aesthetic, palette, lighting, lens language, and texture
- characters, wardrobe, voices, and continuity anchors
- locations and environmental continuity
- dialogue/audio approach and exact-lip-sync decisions
- production-ready shot script, risks, and open questions

It writes a formatted `WORKSHOP.html` for browser review, `WORKSHOP.md` as a
portable text version, and `workshop.json` as the structured source. In an
interactive terminal, the HTML opens automatically in your default browser. Iterate without losing project context:

```bash
venice-video workshop -p ~/VeniceVideos/my-film --feedback "Make the middle more tense"
venice-video workshop -p ~/VeniceVideos/my-film --status
venice-video workshop -p ~/VeniceVideos/my-film --approve
```

Approval materializes the accepted aesthetic, cast, locations, and script into
the existing production pipeline.

The workshop also asks for the final delivery target. Choose **4K master** to
keep generation/drafts economical and upscale only the approved assembled cut:

```bash
venice-video finish -p ~/VeniceVideos/my-film
# Prints input, output, and cost estimate first; then:
venice-video finish -p ~/VeniceVideos/my-film --yes
```

The finishing command finds the assembled master, chunks large videos into
upload-safe segments, upscales them through `topaz-video-upscale`, resumes
already-finished chunks after interruption, concatenates without another video
encode, and remuxes the original audio. The 4K master lands in `masters/` while
the original assembled master is preserved. Current rough estimate: about
$0.12 per input second; the CLI always shows the estimate before spending.

For a standalone file outside a project:

```bash
venice-video upscale --input final-cut.mp4 --factor 4
venice-video upscale --input final-cut.mp4 --factor 4 --yes
```

Individual commands such as
`explore-aesthetic`, `add-character`, and `storyboard-episode` remain available
for advanced manual control, but they are no longer the default onboarding path.

The `new` wizard starts with these production types:

1. **Film** — a film of any length; there is no short-duration assumption
2. Series
3. Product video
4. Music video
5. Screenplay

Film projects use `new-script` and `workshop-script` terminology. Internally,
legacy JSON keys and directories still use `episode` for compatibility, but the
CLI and scriptwriter prompt call the work a Film and Part. Film scripts do not
inherit the series workflow's 60-second duration, one-location structure, or
next-episode cliffhanger.

A non-interactive Film can also be created explicitly:

```bash
venice-video new \
  --type film \
  --name "Long Horizon" \
  --concept "A feature-length journey across a flooded world" \
  --genre adventure \
  --audio-strategy native \
  --video-family auto
```

Useful standalone commands:

```bash
venice-video config show
venice-video config set-workspace ~/VeniceVideos
venice-video config unset-api-key
venice-video list-series
venice-video --help
```

For server environments, prefer `VENICE_API_KEY` instead of writing a user
configuration file. Credential precedence is environment variable, then stored
user configuration, then the repository `.env` compatibility path.

The setup command stores the key in a user-only configuration file, not the OS
keychain. On macOS and Linux the file mode is `0600`. Use an environment variable
or an external secrets manager where file-based storage is not appropriate.

### Repository development

```bash
npm install
npm run build
npm test
npm run test:legacy
npm run dev -- <command>
```

The repository still includes agent orchestration in `AGENTS.md` and `.claude/`.
Those layers can operate the same execution engine, but the installed
`venice-video` command does not depend on them.

### Programmatic Usage

```typescript
import { VeniceClient, generateVideo, quoteVideo, listVideoModels } from 'venice-video-harness';

const client = new VeniceClient();

// Get a cost estimate
const quote = await quoteVideo(client, {
  model: 'kling-v3-pro-image-to-video',
  duration: '8s',
  audio: true,
});
console.log(`Estimated cost: $${quote.quote}`);

// Generate a video
const result = await generateVideo(client, {
  model: 'kling-v3-pro-image-to-video',
  prompt: 'A slow dolly shot pushes forward...',
  duration: '8s',
  imageUrl: 'data:image/png;base64,...',
  audio: true,
  outputPath: 'output/shot-001.mp4',
});

// Query model capabilities
const longModels = listVideoModels({ minDurationSec: 20 });
const refModels = listVideoModels({ supportsElements: true });
```

## Video Model Routing

The harness defaults are opinionated because consistency is the point:

**Seedance 2.0 R2V Enhanced for ALL lanes (reference-first, 2026-07-30). Kling O3 R2V fallback only when characters overflow the 9-reference budget.**

Every shot renders in **pure reference mode** — no start image — from an ordered `@ImageN` reference stack of up to 9 images: one primary angle per character, the scene beat's composed **storyboard blocking plate** (where the characters stand in the location relative to each other), multiple location angles (wide/medium/detail), and second character angles. Overflow drops second character angles first, then extra location angles; blocking plates are protected. Voice-donor clips ride alongside as `reference_audio_urls` (`@AudioN`) so each character's voice stays right take to take.

| Role | Default Model | When Used |
|------|--------------|-----------|
| **Character shots (up to ~6 characters)** | `seedance-2-0-enhanced-reference-to-video` | Default R2V — up to 9 `reference_image_urls` with `@Image` tags (chars + blocking plate + location angles), 1080p, up to 15s, native stereo audio |
| **Character shots (budget overflow)** | `kling-o3-standard-reference-to-video` | Auto-fallback — structured `elements` for multi-character identity |
| **Establishing / mood / action** | `seedance-2-0-enhanced-reference-to-video` | Anchors to location reference angles via `@Image` tags |

These defaults are overridable per-project via `series.json` → `videoDefaults`. To target a non-Seedance family (e.g. for accounts that lack Seedance access, or projects that need a different look), set `videoDefaults` to `kling-o3-standard-reference-to-video` (character consistency) and `veo3.1-fast-image-to-video` (atmosphere). Image models default to `nano-banana-2` / `nano-banana-2-edit` for all panels regardless of video family.

### Picking a family at project creation

`venice-video new` asks which family to use, and `venice-video new-series` asks too when it's run on a terminal without `--video-family`. Both write the answer to `series.json` → `videoDefaults.videoFamilyPreference` and swap the action / atmosphere / character-consistency models to match. The wizard orders the families as Automatic, Seedance, MiniMax H3, HappyHorse, Grok Imagine, then Kling O3.

### Choosing dialogue audio

- **Native dialogue** keeps the shot on the selected video family. Seedance and HappyHorse attach each character's short voice-donor clip through `reference_audio_urls`, then generate the authored line in-frame with that voice identity.
- **Exact lip-sync** renders the exact line with Venice speech, creates a Seedance identity keyframe, and drives Wan 2.7 mouth movement from that speech file through `audio_url`.
- **Narrator voice-over** keeps spoken narration out of the video prompt and mixes Venice speech over the picture in post.

A voice-donor reference preserves timbre, accent, and pacing; it is not the exact dialogue recording. Wan 2.7 is used only when the project explicitly selects exact lip-sync.

| Family | Picks | Trade-off |
|--------|-------|-----------|
| `seedance` | Seedance 2.0 Enhanced R2V for all three lanes | The default. Strongest identity anchoring, 720p drafts, 4-15s. |
| `minimax-h3` | H3 i2v (action/atmosphere) + H3 R2V (identity) | 2K with native stereo audio at ~1/3 the per-second cost. But 2K is the only resolution, so there's no cheap draft pass, and the 5s floor means 3-4s beats have to be re-scripted. |
| `happyhorse` | HappyHorse 1.1 i2v + R2V | Best lip-sync (7 languages, phoneme-level), 3-15s, 720p/1080p. |
| `grok-imagine` | Grok Imagine i2v + R2V | Atmosphere-forward look; R2V durations stepped at 5s/8s/10s. |
| `kling-o3` | Kling O3 Standard i2v + R2V | Stylized and illustrated aesthetics; `elements` + `scene_image_urls`. |
| `auto` | Whatever the harness currently defaults to | Tracks the default as it moves; Seedance Enhanced today. |

Non-interactive callers (the MCP, CI) pass `--video-family` explicitly; when it's omitted without a TTY the harness defaults stay in place.

## Image / Video Family Pairing

**Venice removed the Seedance seedream-only face restriction (2026-07).** Seedance 2.0 previously rejected face-bearing input images that weren't produced by `seedream-v5-lite` / `seedream-v5-lite-edit`; it now accepts face-bearing images from **any** image family. The harness therefore uses a single high-quality default for every panel — character-bearing or faceless, generation or multi-edit:

| Image Role | Default | Why |
|------------|---------|-----|
| Character reference sheets | `nano-banana-2` | Any family works — no seedream requirement |
| Character-bearing panels | `nano-banana-2` | Any family works — no seedream requirement |
| Character fix via multi-edit | `nano-banana-2-edit` | Any family works |
| Atmosphere / establishing panels | `nano-banana-2` (configurable) | `gpt-image-2` / `nano-banana-pro` are high-quality alternatives |
| Style-match multi-edit (no characters) | `nano-banana-2-edit` (configurable) | `gpt-image-2-edit` is a high-quality alternative |

Defaults are configurable per-project under `series.json`:

```json
{
  "videoDefaults": {
    "actionModel": "seedance-2-0-enhanced-reference-to-video",
    "atmosphereModel": "seedance-2-0-enhanced-reference-to-video",
    "characterConsistencyModel": "seedance-2-0-enhanced-reference-to-video",
    "imageDefaults": {
      "generationModel": "nano-banana-2",
      "editModel": "nano-banana-2-edit"
    }
  }
}
```

### Seedance Pre-flight Gate (neutralized)

The former provenance-driven pre-flight gate is a **no-op** as of 2026-07. Because Seedance accepts any image family, there is nothing to validate, reroute, or launder before a Seedance call — `ensureSeedanceCompatibility()` always proceeds and `videoDefaults.seedanceCompatibility` is no longer auto-set (an explicit value is read but does nothing meaningful). Provenance sidecars (`shot-NNN.provenance.json`) are still written as metadata for other tooling but nothing gates on them. (The separate Seedance face **consent** attestation, HTTP 409 `needs_consent`, is unrelated and still handled at queue time.)

The sidecar shape:

```json
{
  "generationModel": "nano-banana-2",
  "editModels": ["nano-banana-2-edit"],
  "hasFace": true,
  "createdAt": "...",
  "updatedAt": "..."
}
```

Provenance sidecars are written automatically by the storyboard assembler, panel-fixer, reference-manager, and the mini-drama panel generator. Images without a sidecar (e.g. files from before this change) are treated as "unknown" and will trigger the pre-flight gate. If you know an existing image has no face, hand-edit its sidecar to add `"hasFace": false` and the gate will pass.

If you want to skip the pre-flight entirely, target a non-Seedance video model (e.g. switch `videoDefaults` to Kling O3 + Veo).

## Reference Implementation

The `src/mini-drama/` directory contains a full working implementation for narrative mini-drama production. Use it directly or adapt the patterns for your own format:

- Series/character/episode management
- Script workshopping via LLM
- Two-pass storyboard generation (generate + multi-edit refine)
- Vision-based QA
- Video generation with frame chaining
- Audio post-production with layered ambient beds
- Subtitle burn-in and final assembly

## Editing Pipeline

Parallel to the generation pipeline. The generation side **synthesizes** new shots from prompts; the editing side **cuts** already-existing media (Venice-generated shots or real raw footage). They share ffmpeg and the burn-in-subtitles skill but are otherwise independent.

Inspired by [browser-use/video-use](https://github.com/browser-use/video-use), the pipeline is text-first: the LLM reads a compact `takes_packed.md` (~12KB per 40 min of audio) rather than frame-dumping video. Composite PNGs are only consulted at explicit decision points — comparing retakes, disambiguating a pause, verifying post-render QA.

### When to reach for editing vs generation

| Task | Pipeline | Entry |
|------|----------|-------|
| Synthesize new shots from prompts | Generation | `/produce-episode`, `/generate-episode-videos` |
| Re-cut a generated episode for pacing | Editing | `/edit-footage` |
| Trim filler words from a VO take | Editing | `/edit-footage` |
| Edit raw user-supplied footage | Editing | `/edit-footage` |
| Rescue a truncated TTS VO (rule 26) | Editing | `/edit-footage` |
| Add branded lower-thirds / title cards | Editing | `overlay-designer` agent |
| Post-assembly QA on any rendered video | Editing | `cut-qa` agent |

### The five steps

1. **Transcribe** via local whisper.cpp → per-source `*.words.json` + `takes_packed.md`
2. **Read pack** — LLM forms a cut strategy from text alone
3. **Confirm** — propose strategy to user, wait for "yes / revise / cancel"
4. **Render EDL** — JSON cut list → ffmpeg concat with 30ms audio fades (archive-first)
5. **Self-eval** — `cut-qa` agent runs 6 programmatic checks at every cut boundary; max 3 fix iterations

### Required tooling

- `whisper-cpp` on PATH (`brew install whisper-cpp`)
- A whisper.cpp model, e.g.:
  ```bash
  mkdir -p ~/.cache/whisper.cpp
  curl -L -o ~/.cache/whisper.cpp/ggml-base.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  ```
- `sharp` npm dep (bundled) for the `timeline-view` composite
- `ffmpeg` + `ffprobe` (already required by the generation pipeline)

### cut-qa checks

Runs automatically after every assembly or edit render. Each check produces zero or more `CutQaFinding` entries:

| Check | Kind | Typical severity |
|-------|------|------------------|
| Aspect regression vs `series.storyboardAspectRatio` | `aspect-regression` | `fail` |
| Frame-hash jump across a cut | `visual-jump` | `warn` (or `fail` if inside a word) |
| VO truncation vs ground-truth script | `vo-truncation` | `fail` |
| Mean-luma delta across a cut in the same location | `lighting-discontinuity` | `warn` |
| Audio peak > -6 dBFS within cut boundary | `audio-pop` | `fail` |
| Caption overlap with in-frame text | `subtitle-overlap` | `warn` |

Hard cap at 3 fix iterations before surfacing to the user with the persisting findings and the fixes that were attempted.

### Overlay pipeline

Branded motion graphics (lower-thirds, title cards, chapter markers, logo bugs) are a post-process on top of the delivered cut — never baked into the EDL render. The `overlay-designer` agent plans the overlays, spawns Remotion / ffmpeg workers in parallel, and composites via `scripts/render-overlay.ts`.

Venice-logo safety rules (AGENTS.md rule 17, anti-pattern #11) are enforced at manifest validation time — manifests that contain "VVV" / "triple-V" or pass mostly-transparent PNGs are rejected before rendering.

### Editing pipeline commands

```bash
# Transcribe a folder of sources into a pack + per-source words.json
npx tsx scripts/transcribe-sources.ts \
  --dir output/<project>/shots \
  --out output/<project>/edit/takes_packed.md \
  --model base.en

# Align against a ground-truth TTS script (detects VO truncation)
npx tsx scripts/transcribe-sources.ts \
  --dir output/<project>/audio \
  --out output/<project>/edit/takes_packed.md \
  --aligned-from scripts/<project>/config.ts

# Inspect a specific time range as a composite PNG
npx tsx scripts/timeline-view.ts \
  --video output/<project>/final.mp4 \
  --start 12.3 --end 16.1 \
  --words output/<project>/edit/final.words.json \
  --out /tmp/tl.png

# Composite overlays onto a delivered cut
npx tsx scripts/render-overlay.ts \
  --manifest output/<project>/overlays/manifest.json
```

See [`.claude/skills/video-editing/SKILL.md`](.claude/skills/video-editing/SKILL.md) for the full philosophy, EDL format, and editing-specific anti-patterns.

## Timeline Export (NLE round-trip)

After an episode is rendered, the harness can export the assembled timeline as an XML file that imports into your editor of choice. Every video segment, dialogue clip, SFX clip, and music cue lands on its own track so you can fine-tune cuts, audio balance, and color in the NLE instead of editing the assembler's ffmpeg filter graph.

```bash
# Final Cut Pro X (FCPXML 1.10) — the original  path
mini-drama export-timeline -p output/<project> -e 1 --format fcpxml

# Adobe Premiere Pro (Final Cut Pro 7 XML / xmeml v5)
mini-drama export-timeline -p output/<project> -e 1 --format premiere

# DaVinci Resolve (Resolve-tuned FCPXML 1.10)
mini-drama export-timeline -p output/<project> -e 1 --format davinci
```

Output filename mirrors the format:

| Format | File | Import path |
|--------|------|-------------|
| `fcpxml`   | `episode-NNN.fcpxml`         | FCP X → File → Import → XML… |
| `premiere` | `episode-NNN.premiere.xml`   | Premiere → File → Import… |
| `davinci`  | `episode-NNN.resolve.fcpxml` | Resolve → File → Import → Timeline… |

Lane layout (same across formats):

- Primary video track — every rendered shot in spine order, segment audio muted (-96 dB)
- Lane −1 (dialogue) — one clip per shot from `audio/dialogue-shot-NNN.mp3`
- Lane −2 (SFX) — one clip per `audio/sfx/*.mp3` matched to its shot
- Lane −3 (music) — `audio/music.mp3` spanning the full sequence

The `export-fcpxml` command from  is kept as a thin alias of `export-timeline --format fcpxml` for back-compat.

**NLE XML implementations vary by editor version.** If your editor refuses the import, or any clip lands on the wrong track or wrong timecode, please [open a GitHub Issue](https://github.com/jordanurbs/venice-video-harness/issues/new) with:

- editor name + exact version
- the format you exported (`fcpxml` / `premiere` / `davinci`)
- the generated XML file attached (or relevant snippet)
- what FCP X / Premiere / Resolve reported

Bug reports are how we'll catch the gaps — the test fixture confirms structure, but it can't substitute for real NLE import paths.

## Commands, Agents, and Skills

### Workflow Commands (`.claude/commands/`)

| Command | Purpose |
|---------|---------|
| `new-series` | Create a new series with locked aesthetics |
| `add-character` | Add a character with reference images |
| `lock-character` | Lock a character's voice (add `--voice-reference <file>` to import a voice-donor clip) |
| `lock-characters` | Batch voice locking |
| `generate-voice-reference` | Generate/import a character voice-donor clip (`reference_audio_urls` / @AudioN, Seedance & HappyHorse R2V) |
| `add-location` | Add a location with generated reference images (wide / medium / detail) |
| `generate-location-references` | Regenerate a location's reference images |
| `set-aesthetic` | Set or derive series aesthetic |
| `explore-aesthetic` | Generate aesthetic comparison samples |
| `workshop-episode` | Collaborative episode scripting |
| `storyboard-episode` | Storyboard one episode |
| `storyboard-scene` | Storyboard a single scene |
| `storyboard-all` | Storyboard all scenes |
| `fix-panel` | Fix a panel with multi-edit |
| `qa-storyboard` | Visual QA on panels |
| `generate-episode-videos` | Generate episode videos from panels |
| `generate-videos` | General video generation |
| `assemble-episode` | Final assembly with audio and subtitles |
| `produce-episode` | Full pipeline in one command |
| `audition-voices` | TTS voice auditions |
| `generate-trailer` | Full trailer pipeline |
| `ingest-screenplay` | Ingest Fountain/PDF screenplay |
| `edit-footage` | Text-first editing pipeline for existing media (cuts, trims, re-orders) |

### Specialized Agents (`.claude/agents/`)

| Agent | Role |
|-------|------|
| `art-director` | Aesthetic decisions, palette, lighting, composition |
| `prompt-engineer` | Venice image prompts, character consistency |
| `screenplay-reader` | Fountain/PDF parsing and scene extraction |
| `storyboard-assembler` | HTML storyboard viewer assembly |
| `storyboard-qa` | Panel QA for continuity and character checks |
| `trailer-curator` | Trailer shot selection and anti-spoiler rules |
| `cut-qa` | Post-render quality gate — 6 checks at every cut boundary, max 3 fix iterations |
| `overlay-designer` | Plans branded motion graphics; spawns Remotion / ffmpeg overlay workers in parallel |
| `remotion-overlay` | Renders one animated overlay as transparent ProRes / WebM |
| `ffmpeg-overlay` | Emits drawtext specs for static overlays |

### Production Skills (`.claude/skills/`)

| Skill | Purpose |
|-------|---------|
| `venice-api` | Venice REST API usage and defaults |
| `venice-video-model-routing` | R2V-first model routing, decision trees, scripts |
| `character-consistency` | Multi-shot character consistency guidance |
| `shot-composition` | Shot composition and camera guidance |
| `screenplay-parsing` | Screenplay parsing workflows |
| `venice-ui-production` | Manual Venice web UI prompt guides |
| `video-editing` | Text-first editing philosophy, EDL format, cut-qa loop (inspired by browser-use/video-use) |

### Directing layer (optional): Seedance 2.0 Skill OS

The harness is the *production crew* — it locks identity, routes models, QA's panels, mixes audio, and assembles. It does not, by itself, make a shot feel **directed**. The [**Seedance 2.0 Skill OS**](https://github.com/emily2040/seedance-2.0) supplies that missing brain: pure directing/prompting knowledge (no execution code) built on one principle — **direct the scene, don't decorate it.** Read the beat's dramatic function, name one intention, and derive camera, light, blocking, performance, and sound from it instead of stacking "cinematic" adjectives; hold one directorial voice across the whole story. Venice ships **Seedance 2.0 (+ Fast)** as a video model family, so the directing knowledge applies almost verbatim.

This principle is already baked into the harness where it matters:

- The **workshop system prompt** (`src/mini-drama/cli.ts`) carries a "DIRECT THE SCENE, DON'T DECORATE IT" block, so both the CLI and the `venice-video-mcp` `episode.workshop` produce directed scripts.
- `.claude/agents/prompt-engineer.md`, `.claude/skills/shot-composition/SKILL.md`, and `.claude/commands/workshop-episode.md` open with the same directing preface for Claude-Code-in-repo sessions.
- The `buildVideoPrompt` builders document the principle so future prompt logic stays directed.

Install Seedance OS to unlock its full `directing-engine`, genre library, `retake-protocol`, `continuation-handoff`, `seedance-copyright`, `seedance-antislop`, and multilingual `vocab/*`:

```bash
# Clone the repo (its root is shaped as the seedance-20 skill) into the skills dir:
git clone https://github.com/emily2040/seedance-2.0 .claude/skills/seedance-20
```

**Division of labor to respect:** the harness owns identity (R2V refs + Seedance → Wan keyframe pass), durations (the pre-flight gate + 15s default), and model routing. So use Seedance OS for **intention/camera/light/blocking/performance/sound** only — do not hand-write identity locks, `[Image1]` reference tags, or surface-specific durations into prompts. Skip Seedance OS's `api-status.md` / `surface-prompt-profiles.md` / `api-workflow.md` / `model-name-map.md` (those describe non-Venice surfaces). The `venice-video-mcp` repo's `venice-mcp-directing` skill is the matching bridge for MCP-driven work.

## Production Anti-Patterns

The harness documents 13 production anti-patterns learned from real shoots in `AGENTS.md`. These cover:

- Multi-shot grouping bugs (wrong character overlap checks)
- Character reference style drift across angles
- Duration validation failures per model
- R2V aspect ratio defaults causing portrait-mode bugs
- Multi-edit cropping foreheads on close-up panels
- Lighting inconsistency between consecutive shots
- Logo/sigil prompt mismatches
- Seedance 2.0's former seedream-only face-image restriction (removed by Venice 2026-07; gate now neutralized)
- And more

See `AGENTS.md` > "Learned Anti-Patterns" for the full list with root causes and fixes.

## API Coverage

| Venice Endpoint | Status | Module |
|----------------|--------|--------|
| `POST /image/generate` | Full | `generate.ts` |
| `POST /image/multi-edit` | Full | `multi-edit.ts` |
| `POST /image/upscale` | Full | `edit.ts` |
| `POST /image/background-remove` | Full | `edit.ts` |
| `POST /video/queue` | Full | `video.ts` |
| `POST /video/retrieve` | Full | `video.ts` |
| `POST /video/quote` | Full | `video.ts` |
| `POST /video/complete` | Full | `video.ts` |
| `POST /audio/speech` | Full | `audio.ts` |
| `POST /audio/queue` | Full | `audio.ts` |
| `POST /audio/retrieve` | Full | `audio.ts` |
| `POST /audio/complete` | Full | `audio.ts` |
| `POST /chat/completions` | Partial | `client.ts` (vision) |
| `POST /images/edit` | Deprecated | `edit.ts` |

## Credits and Acknowledgments

The editing pipeline (text-first transcripts, on-demand timeline composites, EDL + self-eval loop, parallel overlay sub-agents) is directly inspired by [**browser-use/video-use**](https://github.com/browser-use/video-use) — a 100% open source agentic video editor for Claude Code. Their core insight — *"the LLM never watches the video, it reads it"* via word-level transcripts plus on-demand filmstrip+waveform composites — is what makes agent-driven editing actually work instead of drowning in frame-dump tokens.

Key patterns borrowed and adapted for this harness:

- The `takes_packed.md` format and compact per-take phrase blocks
- The timeline-view composite (filmstrip + waveform + word labels + silence-gap markers)
- 30ms audio fades at every cut boundary to prevent pops
- Self-evaluating QA loop at cut boundaries, max 3 fix iterations
- Session persistence (`project.md` → our `session.json`) for cross-session memory
- Parallel sub-agent spawning for overlay / animation rendering
- The "ask → confirm strategy → execute → self-eval → persist" design principle

Differences in this port:

- Uses local **whisper.cpp** instead of ElevenLabs Scribe (no new API keys required; loses diarization out of the box — we inject speaker labels from the shot script for generated content instead)
- Ground-truth script alignment mode via LCS matching, with automatic VO-truncation detection (rule 26 rescue)
- Integrated with Venice's generation pipeline: shared provenance sidecars, shared ffmpeg primitives, shared burn-in-subtitles skill
- TypeScript (Node) rather than Python, to stay consistent with the rest of the harness

Go give [browser-use/video-use](https://github.com/browser-use/video-use) a star. It's a clean, opinionated reference for text-first video editing and it's the right shape for this kind of tool.

## License

MIT
