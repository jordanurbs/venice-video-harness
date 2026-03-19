---
name: venice-video-model-routing
description: This skill should be used when generating images or videos via Venice AI, selecting models, attaching reference images, choosing frame sources, or adapting prompts for character consistency. Includes executable Python scripts for image generation, video generation, image editing, and upscaling. Covers decision trees for model upgrades (action/atmosphere to character-consistency tier), elements vs reference_image_urls vs image_urls, frame chaining vs panel start, two-pass image pipeline routing, and prompt adaptation per model. Applicable to any project generating multi-shot video content via the Venice AI API.
metadata:
  requires:
    bins: ["python3"]
    env: ["VENICE_API_KEY"]
---

# Venice Video Model Routing For Character Consistency

Route Venice AI models, reference image strategies, frame sources, and prompt formats to maximize character consistency across image panels and video clips. Includes bundled Python scripts for executing image generation, video generation, image editing, and upscaling via the Venice AI API.

## Prerequisites and Setup

### Requirements

- **Python 3.10+** (`brew install python` or system Python)
- **Venice API key** (free tier available at [venice.ai](https://venice.ai))

### Get Your API Key

1. Create an account at [venice.ai](https://venice.ai)
2. Go to [venice.ai/settings/api](https://venice.ai/settings/api)
3. Click "Create API Key"
4. Copy the key (starts with `vn_...`)

### Configure the Key

**Option A: Environment variable**

```bash
export VENICE_API_KEY="vn_your_key_here"
```

**Option B: `.env` file** in your project root:

```
VENICE_API_KEY=vn_your_key_here
```

### Verify Setup

```bash
python3 {baseDir}/scripts/venice-image.py --list-models
python3 {baseDir}/scripts/venice-video.py --list-models
```

## Generation Scripts

Four Python scripts handle Venice API execution. Use these to generate media, then apply the routing decisions in Sections 1-7 to choose models and parameters.

### Image Generation

```bash
# Generate a storyboard panel
python3 {baseDir}/scripts/venice-image.py \
  --prompt "STYLE: Korean manhwa... [scene content] ...STYLE REMINDER: manhwa, cel-shaded" \
  --model nano-banana-pro \
  --resolution 1K --aspect-ratio 9:16 \
  --cfg-scale 10 --seed 88442211 \
  --steps 30 --hide-watermark

# Generate character references (square)
python3 {baseDir}/scripts/venice-image.py \
  --prompt "Front-facing reference sheet..." \
  --model nano-banana-pro \
  --resolution 1K --aspect-ratio 1:1

# List available image models
python3 {baseDir}/scripts/venice-image.py --list-models

# Generate multiple variants
python3 {baseDir}/scripts/venice-image.py --prompt "..." --count 4
```

Key flags: `--model`, `--prompt`, `--resolution` (1K/2K), `--aspect-ratio` (9:16, 16:9, 1:1), `--cfg-scale` (0-20, default 7.5), `--seed`, `--steps`, `--negative-prompt`, `--style-preset`, `--hide-watermark`, `--count`, `--out-dir`

### Video Generation

```bash
# Generate video from panel (basic -- text-only model)
python3 {baseDir}/scripts/venice-video.py \
  --image shot-001.png \
  --prompt "A slow dolly shot pushes forward..." \
  --model kling-v3-pro-image-to-video \
  --duration 5s \
  --audio

# Get price quote before generating
python3 {baseDir}/scripts/venice-video.py --quote \
  --model kling-o3-standard-reference-to-video --duration 8s --aspect-ratio 9:16

# List available video models with durations
python3 {baseDir}/scripts/venice-video.py --list-models
```

Key flags: `--image` (source panel), `--prompt`, `--model`, `--duration` (3s-16s, model-dependent), `--resolution` (480p/720p/1080p), `--aspect-ratio`, `--audio`/`--no-audio`, `--quote`, `--timeout`, `--poll-interval`, `--out-dir`

**Limitation:** The bundled video script handles basic image-to-video generation. For advanced routing features (`elements`, `reference_image_urls`, `image_urls`, `end_image_url`), construct the API call directly using the Venice REST API. See the capability matrix in Section 3 for which models support which parameters.

### Image Editing (Multi-Edit / Refinement)

```bash
# Fix character appearance in a panel
python3 {baseDir}/scripts/venice-edit.py shot-001.png \
  --prompt "Make the woman match the reference: tall, hourglass figure, dark hair..."

# Edit from URL
python3 {baseDir}/scripts/venice-edit.py --url "https://..." \
  --prompt "change the sky to sunset"
```

Key flags: `image` (positional, local path), `--url` (remote image), `--prompt` (edit instruction), `--output`, `--out-dir`

### Image Upscaling

```bash
# 2x upscale
python3 {baseDir}/scripts/venice-upscale.py shot-001.png --scale 2

# 4x upscale with AI enhancement
python3 {baseDir}/scripts/venice-upscale.py shot-001.png --scale 4 --enhance

# Upscale with detail sharpening
python3 {baseDir}/scripts/venice-upscale.py shot-001.png --enhance --enhance-prompt "sharpen details"
```

Key flags: `image` (positional), `--url`, `--scale` (1-4), `--enhance`, `--enhance-prompt`, `--enhance-creativity` (0.0-1.0), `--replication` (0.0-1.0), `--output`, `--out-dir`

### Pricing Overview

| Feature | Cost |
|---------|------|
| Image generation | ~$0.01-0.03 per image |
| Image upscale | ~$0.02-0.04 |
| Image edit | ~$0.04 |
| Video (WAN) | ~$0.10-0.50 depending on duration |
| Video (Kling) | ~$0.20-1.00 depending on duration |
| Video (Sora) | ~$0.50-2.00 depending on duration |

Use `--quote` with the video script to check pricing before generation.

---

## 1. Three-Tier Video Model Architecture

Venice AI video generation routes through three model tiers based on the shot's role:

| Tier | Default Model | Role | Capabilities |
|------|--------------|------|--------------|
| **Action** | `kling-v3-pro-image-to-video` | Movement, dialogue, fights, gestures | `end_image_url` targeting; durations 3-15s; NO `elements`/`reference_image_urls` |
| **Atmosphere** | `veo3.1-fast-image-to-video` | Establishing shots, inserts, static mood | 8s only; requires `resolution: '720p'`; NO `elements`/`reference_image_urls` |
| **Character Consistency** | `kling-o3-standard-reference-to-video` | Identity-critical shots requiring visual anchoring | `elements`, `reference_image_urls`, `image_urls`; durations 3-15s; $0.112/s (no audio), $0.140/s (with audio) |

Each shot is tagged with a base role (`"action"` or `"atmosphere"`). The upgrade decision tree (Section 2) determines when to swap from the base tier to the character-consistency tier.

Recommended constants:

```
ACTION_MODEL              = 'kling-v3-pro-image-to-video'
ATMOSPHERE_MODEL          = 'veo3.1-fast-image-to-video'
CHARACTER_CONSISTENCY_MODEL = 'kling-o3-standard-reference-to-video'
MULTISHOT_MODEL           = 'kling-o3-pro-image-to-video'
```

## 2. Video Model Upgrade Decision Tree

Evaluate shot characteristics in priority order to determine whether to upgrade from the base model to the character-consistency model. The first matching rule wins:

| Priority | Condition | Result | Reason |
|----------|-----------|--------|--------|
| 1 | Explicit `useElements` or `useReferenceImages` flag | Consistency model | Explicit opt-in for reference anchoring |
| 2 | No characters in shot | Base model (no upgrade) | No characters to anchor |
| 3 | Shot type is `close-up` or `reaction` | Consistency model | Identity-sensitive framing -- face is the whole point |
| 4 | `continuityPriority === 'identity'` | Consistency model | Shot explicitly requests identity preservation |
| 5 | Any character in shot not present in previous shot | Consistency model | New character needs reference anchoring |
| 6 | None of the above | Base model | Default prompt-first generation |

When the consistency model is selected, auto-enable `elements` and `reference_image_urls` if the model supports them (check against the capability matrix in Section 3). No manual flags needed per shot.

See `references/decision-trees.md` for structured ASCII flowcharts.

## 3. Reference Image Attachment Matrix

Three reference mechanisms exist for video generation, each supported by different models:

### `elements` (Structured Per-Character)

- **Supported by:** `kling-o3-standard-reference-to-video`, `kling-o3-pro-reference-to-video`
- **Structure:** Array of up to 4 element definitions, each with `frontal_image_url` and up to 3 `reference_image_urls` (side, 45°, back angles)
- **Optional:** `video_url` for motion/voice reference
- **Prompt integration:** Replace character names with `@Element1`, `@Element2` tokens in both description and dialogue
- **Typical reference images:**
  - `frontalImageUrl` = character front-facing reference
  - `referenceImageUrls` = three-quarter, profile, and back angle references (up to 3)
- **When to use:** Consistency model selected AND model supports elements

### `reference_image_urls` (Flat General)

- **Supported by:** `kling-o3-standard-reference-to-video`, `kling-o3-pro-reference-to-video`, `vidu-q3-image-to-video`
- **Structure:** Flat array of up to 4 reference images
- **Prompt integration:** Standard character names in text (no element tokens needed)
- **Typical reference images:** Front-facing + three-quarter per character, capped at 4 total
- **When to use:** Consistency model selected AND model supports reference images AND `elements` is not already in use

### `image_urls` (Scene/Environment Anchoring)

- **Supported by:** `kling-o3-standard-reference-to-video`, `kling-o3-pro-reference-to-video`
- **Structure:** Array of up to 4 scene/environment reference images
- **Prompt integration:** Referenced as `@Image1`, `@Image2` in prompt text
- **When to use:** Environment/style reference paths are explicitly provided AND model supports scene images

### Capability Matrix

| Parameter | Kling O3 R2V (Standard/Pro) | Kling V3 Pro | Vidu Q3 | Veo 3.1 |
|-----------|:---:|:---:|:---:|:---:|
| `elements` | Yes | **NO** (400) | No | No |
| `reference_image_urls` | Yes | **NO** (400) | Yes | No |
| `image_urls` | Yes | No | No | No |
| `end_image_url` | Yes | Yes | No | No |
| `aspect_ratio` | Yes | No | No | No |

Always gate reference attachments through the capability matrix. Sending unsupported params to models that reject them returns 400 errors.

## 4. Frame Source Strategy (Identity vs Continuity)

When generating sequential video clips, two decisions govern visual continuity:

### Start Frame (`image_url`)

**Use the panel/storyboard image** (prioritizes character identity -- the panel was refined against character references):

- First shot in the sequence (no previous video)
- `continuityPriority === 'identity'` on the shot
- Scene boundary (establishing shot, no character overlap, dramatic composition change)
- New character entering who was not in the previous shot
- Identity-sensitive shot type (`close-up`, `reaction`) unless continuity is explicitly prioritized
- Previous transition is `CUT` or `SMASH CUT`

**Use the previous video's last frame** (prioritizes visual flow -- smooth transition):

- Same characters continue across shots AND
- Previous shot's transition is in the chain set: `DISSOLVE`, `MATCH CUT`, `MORPH`, `WIPE`, `CROSSFADE`, `FADE`

### End Frame (`end_image_url`, Kling only)

**Target next panel** (Kling animates toward this composition):

- Current shot's transition is: `DISSOLVE`, `MATCH CUT`, `MORPH`, `WIPE`, or `CROSSFADE`
- AND next shot exists, has no new characters, and is not a title/insert

**Natural ending** (video ends wherever the animation takes it):

- Transition is `CUT`, `SMASH CUT`, or `FADE`
- OR next shot has new characters (end_image would show wrong appearance)
- OR next shot is a title card or insert

### Transition Quick Reference

```
Start frame chaining:  DISSOLVE, MATCH CUT, MORPH, WIPE, CROSSFADE, FADE
End frame targeting:   DISSOLVE, MATCH CUT, MORPH, WIPE, CROSSFADE (no FADE)
No chaining:           CUT, SMASH CUT
```

## 5. Two-Pass Image Pipeline Routing

Generate consistent storyboard panels using two Venice models in sequence:

### Pass 1: Generate (`nano-banana-pro`)

- **Script:** `python3 {baseDir}/scripts/venice-image.py --model nano-banana-pro ...`
- **Reference images:** None accepted (400 error if `image_references`/`image_1` are sent)
- **Consistency via:** Exhaustive text descriptions (full character + aesthetic bookended in prompt) + fixed seed
- **Recommended params:** `--resolution 1K --aspect-ratio 9:16 --steps 30 --cfg-scale 10 --seed <fixed project seed>`
- **Output:** 768x1376 (9:16) or 1376x768 (16:9)

### Pass 2: Refine via Multi-Edit (`nano-banana-pro-edit`)

- **Script:** `python3 {baseDir}/scripts/venice-edit.py panel.png --prompt "Match character to reference..."`
- **Default model:** `nano-banana-pro-edit` (via multi-edit endpoint)
- **Input:** Base panel + up to 2 character reference images
- **Output:** Always 1024x1024 (1:1) -- restore original aspect ratio via center-crop + scale after

**Two refinement paths based on shot content:**

| Shot Type | Images Sent | Purpose |
|-----------|-------------|---------|
| Character shot (has characters) | Panel + 1-2 character front-facing references | Align face, body, wardrobe to references |
| Non-character shot (establishing, insert, title) | Panel + style anchor (a refined character shot from same project) | Harmonize rendering style across all panels |

**Available multi-edit models:**

`nano-banana-pro-edit` (default), `nano-banana-2-edit`, `gpt-image-1-5-edit`, `grok-imagine-edit`, `qwen-edit`, `flux-2-max-edit`, `seedream-v4-edit`, `seedream-v5-lite-edit`

## 6. Prompt Adaptation Per Model

Construct prompts differently depending on the resolved model's capabilities:

### Elements-Capable Models (Kling O3 R2V)

- Replace character names in descriptions with `@Element1`, `@Element2` tokens via regex
- Dialogue speaker uses element ref: `@Element1 (voice: low contralto...) says nervously: "..."`
- Scene image refs added as `Scene style references: @Image1, @Image2.`
- Append full aesthetic string + audio exclusion suffix (e.g., `No background music. Only generate dialogue, ambient sound, and sound effects.`)

### Reference-Image Models Without Elements (Vidu Q3)

- Use standard character names in prompt text (no element tokens)
- Attach `reference_image_urls` at the API layer (up to 4 flat images)
- Dialogue uses character name directly with voice description

### Text-Only Models (Kling V3 Pro, Veo 3.1)

- Inject full character descriptions including voice descriptions inline in the prompt
- No reference images attached (silently skipped)
- Structure: camera term first, then description, then dialogue with delivery cues
- Veo requires `resolution: '720p'`; Kling does NOT accept `resolution`/`aspect_ratio` (derived from input image)

### Multi-Shot Units (Kling O3 Pro)

- No `elements` or `reference_image_urls` (not supported)
- Use compact character descriptions
- Combine all shots in the unit into a single prompt with segment markers

### Environment Adaptation (All Models)

When a shot is set in a bright daytime environment while the project's default aesthetic is dark/moody:

1. **Image prompts:** Strip dark/rain-related terms from the aesthetic string; add anti-rain negative prompts
2. **Video prompts:** Append `Bright daytime scene, natural light, no rain.`
3. **Multi-edit (character fix):** Add `BRIGHT DAYTIME scene. Do NOT darken, no rain` instruction
4. **Multi-edit (style match):** Add `Keep bright warm lighting. Do NOT add rain, dark skies`

This prevents the project's default aesthetic from contaminating scenes with different lighting conditions.

## 7. Anti-Patterns and Learned Routing Failures

### API Errors

- **Sending `elements`/`reference_image_urls` to Kling V3 Pro:** Returns 400. Always check the capability matrix before attaching reference params.
- **Sending `resolution`/`aspect_ratio` to Kling image-to-video models:** Returns 400. These are derived from the input image automatically.
- **Sending `image_references`/`image_1` to `nano-banana-pro`:** Returns 400. The generation model does not accept reference payloads at all.

### Visual Contamination

- **Frame chaining from dark scene to bright scene:** The dark tone from the last frame bleeds into the bright scene. Use the panel image instead of chaining when the environment changes.
- **Multi-edit with dark character references re-darkening bright panels:** Character reference images shot in dark environments cause the edit model to match the overall tone, not just the face. Use environment adaptation instructions to preserve brightness.
- **Project aesthetic contaminating daytime scenes:** A dark/rainy default aesthetic bleeds into bright interiors unless explicitly stripped via environment adaptation.

### Identity Failures

- **Frame chaining when new character enters:** The video model invents the new character's appearance from nothing. Always use the panel image (which was refined against character references) as the start frame when a new character appears.
- **Multi-edit with more than 2 character references:** The multi-edit endpoint accepts max 3 images total (base + 2 refs). Exceeding this drops references silently.
- **Sequential action in image descriptions:** Causes comic-panel layouts instead of single frames. Separate the single-frame panel description from the full video action description.
- **Vague body orientation:** Produces twisted poses. Always specify full-body direction explicitly (e.g., "seen entirely from behind", "facing camera directly").

## Troubleshooting

**"VENICE_API_KEY not set"** -- Set the environment variable or add it to your project's `.env` file.

**"Model not found"** -- Run `--list-models` to see available models. Use `--no-validate` for new/beta models not yet in the model list.

**Video stuck/timeout** -- Videos can take 1-5 minutes depending on model and duration. Use `--timeout 600` for longer videos.

**"requests" module not found** -- Install it: `pip3 install requests`
