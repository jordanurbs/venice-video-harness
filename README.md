# Venice Video Harness

Agent-first, Venice-optimized tooling for **consistency-first video creation** at any length.

This harness is built for creators who want an IDE agent (Claude Code, Cursor, etc.) to operate a reusable Venice production system for:

- **Character-consistent video projects** (any genre, any length)
- **Visual-style-locked series or campaigns**
- **Storyboard-to-video workflows**
- **Short-form and long-form narrative content** (mini-dramas, documentaries, explainers)
- **Branded cinematic sequences, trailers, and teasers**
- **Recurring-character social series**
- **Any multi-shot Venice workflow where continuity matters**
- **Text-first editing of existing footage** — transcribe sources with local whisper.cpp, read the 12KB pack, propose a cut, render with 30ms audio fades, then self-eval at every cut boundary. Inspired by [browser-use/video-use](https://github.com/browser-use/video-use).

## What This Is

Most Venice integrations are thin wrappers around API calls. This harness is the higher-level layer:

- **Orchestration rules** in `CLAUDE.md`
- **Reusable playbooks** in `.claude/commands/`
- **Specialized agents** in `.claude/agents/`
- **Venice production skills** in `.claude/skills/`
- **TypeScript execution layer** in `src/`
- **Comprehensive model registry** covering 50+ Venice video, image, audio, and music models

## Supported Venice Models (April 2026)

### Video Models

| Family | Image-to-Video | Text-to-Video | Max Duration | Audio | Special Features |
|--------|---------------|---------------|-------------|-------|-----------------|
| **Seedance 2.0** | i2v, R2V | t2v | 15s | Yes (stereo, lip-sync 8+ langs) | **#1 ranked.** R2V: flat `reference_image_urls`, `@Image` tags. Superior physics and cinematic quality. |
| **Kling V3** | Pro, Standard | Pro, Standard | 15s | Yes | `end_image_url` for frame targeting |
| **Kling O3** | Pro, Standard, Pro R2V, Standard R2V | Pro, Standard | 15s | Yes | R2V: `elements`, `reference_image_urls`, `scene_image_urls` |
| **Kling 2.6** | Pro | Pro | 10s | Yes | `end_image_url` |
| **Kling 2.5 Turbo** | Pro | Pro | 10s | No | `end_image_url` |
| **Veo 3.1** | Fast, Full | Fast, Full | 8s | Yes | Up to 4K resolution |
| **Veo 3** | Fast, Full | Fast, Full | 8s | Yes | |
| **Sora 2** | Standard, Pro | Standard, Pro | 12s | Yes | Up to 1080p |
| **Wan 2.6** | Standard, Flash | Standard | 15s | Yes | 1080p, `audio_url` input |
| **Wan 2.5 Preview** | Yes | Yes | 10s | Yes | `audio_url` input |
| **Wan 2.2 A14B** | — | Yes | 5s | No | Legacy text-to-video |
| **Wan 2.1 Pro** | Yes | — | 6s | No | Legacy |
| **LTX Video 2.0** | Fast, Full, v2.3, 19B | Fast, Full, v2.3, 19B | 20s | Yes | Up to 4K, longest durations |
| **Longcat** | Standard, Distilled | Standard, Distilled | **30s** | No | Longest single-shot duration |
| **Vidu Q3** | Yes | Yes | 16s | Yes | `reference_image_urls` |
| **PixVerse v5.6** | Standard, Transition | Standard | 8s | Yes | Transition: `end_image_url` |
| **Grok Imagine** | Yes | Yes | 15s | Yes | Wide aspect ratio support |
| **OVI** | Yes | — | 5s | Yes | |

> **Seedance face rule:** Seedance 2.0 blocks **face-bearing** input images that weren't produced by `seedream-v5-lite` or `seedream-v5-lite-edit`. Faceless images (atmosphere, establishing, scene refs, object inserts, silhouettes) pass through any family. The harness picks image models per-shot automatically — see [Image / Video Family Pairing](#image--video-family-pairing) below.

### Image Models (22 generation + 1 background-remove)

`nano-banana-pro`, `nano-banana-2`, `gpt-image-2` (high-quality alternative to `nano-banana-pro`), `gpt-image-1-5`, `flux-2-pro`, `flux-2-max`, `grok-imagine`, `hunyuan-image-v3`, `imagineart-1.5-pro`, `qwen-image`, `qwen-image-2`, `qwen-image-2-pro`, `recraft-v4`, `recraft-v4-pro`, `seedream-v4`, `seedream-v5-lite`, `chroma`, `hidream`, `venice-sd35`, `lustify-sdxl`, `lustify-v7`, `wai-Illustrious`, `z-image-turbo`, `bria-bg-remover`

### Multi-Edit Models

`qwen-edit`, `qwen-image-2-edit`, `qwen-image-2-pro-edit`, `flux-2-max-edit`, `gpt-image-2-edit` (high-quality alternative to `nano-banana-pro-edit`), `gpt-image-1-5-edit`, `grok-imagine-edit`, `nano-banana-2-edit`, `nano-banana-pro-edit`, `seedream-v4-edit`, `seedream-v5-lite-edit`

### Audio / Music Models

- **TTS**: `tts-kokoro` (50+ voices), `tts-qwen3-0-6b`, `tts-qwen3-1-7b` (style-prompted voices)
- **Music**: `elevenlabs-music`, `minimax-music-v2`, `ace-step-15`, `stable-audio-25`
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
CLAUDE.md                        Agent orchestration hub
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
- A `VENICE_API_KEY` (get one at [venice.ai](https://venice.ai))
- **Optional (editing pipeline):** `whisper-cpp` on PATH for local transcription. Install with `brew install whisper-cpp`, then download a model:
  ```bash
  mkdir -p ~/.cache/whisper.cpp
  curl -L -o ~/.cache/whisper.cpp/ggml-base.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  ```
  Or set `WHISPER_CPP_MODELS_DIR` to a directory that contains the `ggml-*.bin` files.

### Setup

```bash
cp .env.example .env
# Add your VENICE_API_KEY to .env
npm install
npm run build
```

### CLI and npm Scripts

The primary interface is agent chat (see below), but the harness also exposes CLIs:

```bash
# Development (no build required)
npm run dev -- <command>          # Run mini-drama CLI via tsx
npm run dev:legacy -- <command>   # Run legacy storyboard CLI via tsx

# Production (after npm run build)
npm start -- <command>            # Run mini-drama CLI from dist/
npx venice-video <command>        # Same as above (bin alias)
npx storyboard <command>          # Legacy storyboard pipeline

# Maintenance
npm run build                     # Compile TypeScript
npm run clean                     # Remove dist/
```

### In Agent Chat

Open the project in Cursor or VS Code. The agent reads `CLAUDE.md` and the playbooks to operate the harness.

Good first messages:

- "Set up this Venice video harness for first use"
- "Create a new character-consistent video series"
- "Generate a 30-second branded video sequence"
- "Build a multi-episode narrative with locked characters"
- "Create a product launch trailer with consistent visual style"

### Programmatic Usage

```typescript
import { VeniceClient } from './src/venice/client.js';
import { generateVideo, quoteVideo } from './src/venice/video.js';
import { listVideoModels, getVideoModel } from './src/venice/models.js';

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

**Seedance R2V by default. Kling O3 R2V fallback for 3+ character scenes. Seedance i2v for establishing shots.**

Seedance 2.0 (#1 ranked on [Artificial Analysis Video Arena](https://artificialanalysis.ai/)) is the default for both character shots and establishing/atmosphere shots. It uses flat `reference_image_urls` with `@Image` prompt tags for identity anchoring. For scenes with 3+ characters, the system automatically falls back to Kling O3 R2V, which provides structured `elements` for better per-character identity separation.

| Role | Default Model | When Used |
|------|--------------|-----------|
| **Character shots (1-2 characters)** | `seedance-2-0-reference-to-video` | Default R2V — flat `reference_image_urls` with `@Image` tags, up to 15s, native stereo audio |
| **Character shots (3+ characters)** | `kling-o3-standard-reference-to-video` | Auto-fallback — structured `elements` for multi-character identity |
| **Establishing / mood / action** | `seedance-2-0-image-to-video` | No characters — epic cinematic quality, physics-aware, up to 15s |

These defaults are overridable per-project via `series.json` → `videoDefaults`. To target a non-Seedance family (e.g. for accounts that lack Seedance access, or projects that need a different look), set `videoDefaults` to `kling-o3-standard-reference-to-video` (character consistency) and `veo3.1-fast-image-to-video` (atmosphere), and flip `videoDefaults.imageDefaults` back to `nano-banana-pro` / `nano-banana-pro-edit`.

## Image / Video Family Pairing

Seedance 2.0 blocks **face-bearing** input images that weren't produced by `seedream-v5-lite` or `seedream-v5-lite-edit`. Faceless images (atmosphere, establishing, scene refs, object inserts, silhouettes) pass through any family. The harness therefore picks the image model per-shot based on whether the shot contains characters:

| Image Role | Default | Why |
|------------|---------|-----|
| Character reference sheets | `seedream-v5-lite` | Always face-bearing; required for Seedance |
| Character-bearing panels | `seedream-v5-lite` | Face-bearing; required for Seedance |
| Character fix via multi-edit | `seedream-v5-lite-edit` | Touches faces; required for Seedance |
| Atmosphere / establishing panels | `nano-banana-pro` (configurable) | Faceless — better quality from nano-banana. `gpt-image-2` is a high-quality alternative |
| Style-match multi-edit (no characters) | `nano-banana-pro-edit` (configurable) | Faceless — any family works. `gpt-image-2-edit` is a high-quality alternative |

The faceless-side defaults are configurable per-project under `series.json`:

```json
{
  "videoDefaults": {
    "actionModel": "seedance-2-0-image-to-video",
    "atmosphereModel": "seedance-2-0-image-to-video",
    "characterConsistencyModel": "seedance-2-0-reference-to-video",
    "imageDefaults": {
      "generationModel": "nano-banana-pro",
      "editModel": "nano-banana-pro-edit"
    },
    "seedanceCompatibility": "prompt"
  }
}
```

The face-bearing side (`seedream-v5-lite` / `seedream-v5-lite-edit`) is hardcoded because it's the only family Seedance accepts for face inputs. If your project targets a non-Seedance video family (e.g. Kling / Veo), you can additionally switch face-bearing work to `nano-banana-pro` — the face rule only applies when the video target is Seedance.

### Seedance Pre-flight Gate

Even when defaults are correct, users occasionally bring existing assets (panels from a previous project, hand-crafted references, etc.). Before every Seedance call the harness runs a pre-flight gate that:

1. Reads the provenance sidecar (`shot-NNN.provenance.json`) next to each input image
2. Skips any image marked `hasFace: false` (Seedance accepts those from any family)
3. Confirms each remaining image's generation / most-recent-edit model is in the Seedance-compatible set
4. If any face-bearing images are incompatible, behaves according to `seedanceCompatibility`:
   - **`prompt`** (default in interactive shells) — list the offending files and ask the user to choose `fallback` or `launder`
   - **`fallback`** (default in non-TTY / CI) — reroute this shot to `kling-o3-standard-reference-to-video` (R2V) or `veo3.1-fast-image-to-video` (i2v); other shots in the run continue to use Seedance if they're compatible
   - **`launder`** — re-render each incompatible image through `seedream-v5-lite-edit` with a neutral "preserve image" prompt so it acquires compatible provenance, archive the pre-launder original, then proceed with Seedance

The sidecar shape:

```json
{
  "generationModel": "seedream-v5-lite",
  "editModels": ["seedream-v5-lite-edit"],
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

Venice-logo safety rules (CLAUDE.md rule 17, anti-pattern #11) are enforced at manifest validation time — manifests that contain "VVV" / "triple-V" or pass mostly-transparent PNGs are rejected before rendering.

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

## Commands, Agents, and Skills

### Workflow Commands (`.claude/commands/`)

| Command | Purpose |
|---------|---------|
| `new-series` | Create a new series with locked aesthetics |
| `add-character` | Add a character with reference images |
| `lock-character` | Lock a character's voice |
| `lock-characters` | Batch voice locking |
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

## Production Anti-Patterns

The harness documents 13 production anti-patterns learned from real shoots in `CLAUDE.md`. These cover:

- Multi-shot grouping bugs (wrong character overlap checks)
- Character reference style drift across angles
- Duration validation failures per model
- R2V aspect ratio defaults causing portrait-mode bugs
- Multi-edit cropping foreheads on close-up panels
- Lighting inconsistency between consecutive shots
- Logo/sigil prompt mismatches
- Seedance 2.0 blocking face-bearing non-seedream images (face-rule + provenance gate)
- And more

See `CLAUDE.md` > "Learned Anti-Patterns" for the full list with root causes and fixes.

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
