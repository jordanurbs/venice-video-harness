---
name: venice-video-model-routing
description: This skill should be used when generating images or videos via Venice AI, selecting models, attaching reference images, choosing frame sources, or adapting prompts for character consistency. Includes executable Python scripts for image generation, video generation, image editing, and upscaling. Covers R2V-first model routing (characters present → R2V, no characters → action/atmosphere), elements vs reference_image_urls, frame chaining vs panel start, two-pass image pipeline routing, and prompt adaptation per model. Applicable to any project generating multi-shot video content via the Venice AI API.
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

## 1. Video Model Routing: Seedance R2V by Default

**Core principle: Seedance R2V by default, Kling O3 R2V fallback for 3+ character scenes, Seedance i2v for establishing shots.**

Almost all shots should use a reference-to-video model for identity anchoring. Seedance 2.0 R2V (#1 ranked on Artificial Analysis) is the default, using flat `reference_image_urls` with `@Image` prompt tags. For shots with 3+ characters, the system falls back to Kling O3 R2V which provides structured `elements` for better per-character identity separation. Empty establishing/mood shots use Seedance i2v for superior cinematic quality and physics.

| Role | Default Model | When Used | Capabilities |
|------|--------------|-----------|--------------|
| **Character shots (1-2 chars)** | `seedance-2-0-reference-to-video` | Default R2V — flat `reference_image_urls` with `@Image` tags | Up to 4 ref images, 4-15s, native stereo audio, `aspect_ratio` |
| **Character shots (3+ chars)** | `kling-o3-standard-reference-to-video` | Auto-fallback — structured `elements` for multi-character identity | `elements`, `reference_image_urls`, `scene_image_urls`; 3-15s |
| **Establishing / mood / action** | `seedance-2-0-image-to-video` | No characters — epic cinematic quality, physics-aware | 4-15s, `resolution: '720p'`, `aspect_ratio`, native audio |

Recommended constants:

```
ACTION_MODEL              = 'seedance-2-0-image-to-video'
ATMOSPHERE_MODEL          = 'seedance-2-0-image-to-video'
CHARACTER_CONSISTENCY_MODEL = 'seedance-2-0-reference-to-video'
KLING_R2V_MODEL           = 'kling-o3-standard-reference-to-video'  (fallback for 3+ chars)
MULTISHOT_MODEL           = 'kling-o3-pro-image-to-video'

# Image defaults MUST be paired with Seedance — no other family is accepted
IMAGE_GENERATION_MODEL    = 'seedream-v5-lite'
MULTI_EDIT_MODEL          = 'seedream-v5-lite-edit'
```

### Seedance Provenance Requirement

Seedance 2.0 **blocks** any request whose input images (`image_url`, `end_image_url`, `reference_image_urls`, `scene_image_urls`, `elements[].frontal_image_url`) were not produced by `seedream-v5-lite` or `seedream-v5-lite-edit`. When picking an image generation or multi-edit model for a Seedance pipeline, the only valid choices are these two. The harness writes a provenance sidecar (`<image>.provenance.json`) on every generation and records edits on top. Before each Seedance call, `ensureSeedanceCompatibility()` (`src/venice/seedance-preflight.ts`) verifies every input image and — if any are incompatible — either prompts the user, reroutes the shot to Kling O3 R2V / Veo 3.1, or launders the offending images through `seedream-v5-lite-edit`. Mode is controlled by `series.videoDefaults.seedanceCompatibility` (`prompt` | `fallback` | `launder`).

## 2. Video Model Routing Decision

Three-path routing based on character count:

| Priority | Condition | Result | Reason |
|----------|-----------|--------|--------|
| 1 | Establishing/mood shot with no characters | Seedance i2v | No characters to anchor — best cinematic quality + physics |
| 2 | 1-2 characters | Seedance R2V | Identity anchoring via flat `reference_image_urls` — #1 ranked quality |
| 3 | 3+ characters | Kling O3 R2V | Structured `elements` handle more identities (up to 7 elements vs 4 flat refs) |

When Seedance R2V is selected, `reference_image_urls` and `@Image` prompt tags are auto-enabled. When Kling O3 R2V is selected (3+ char fallback), `elements` and `@Element` tags are auto-enabled.

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

- **Supported by:** `seedance-2-0-reference-to-video`, `kling-o3-standard-reference-to-video`, `kling-o3-pro-reference-to-video`, `vidu-q3-image-to-video`
- **Structure:** Flat array of up to 4 reference images
- **Prompt integration:** For Seedance/Grok Imagine R2V, use `@Image1`, `@Image2` tags. For Kling R2V, standard character names or `@Element` tokens (when elements are also active). For Vidu, standard character names.
- **Typical reference images:** Front-facing + three-quarter per character, capped at 4 total
- **When to use:** Consistency model selected AND model supports reference images. For Seedance R2V, this is the primary identity mechanism (no elements). For Kling R2V, used alongside `elements` or as a standalone fallback.

### `image_urls` (Scene/Environment Anchoring)

- **Supported by:** `kling-o3-standard-reference-to-video`, `kling-o3-pro-reference-to-video`
- **Structure:** Array of up to 4 scene/environment reference images
- **Prompt integration:** Referenced as `@Image1`, `@Image2` in prompt text (indices offset when `@Image` tags are also used for character refs)
- **When to use:** Environment/style reference paths are explicitly provided AND model supports scene images
- **Note:** Seedance R2V does NOT support separate scene images. Scene context is handled through prompting only.

### Capability Matrix

| Parameter | Seedance 2.0 R2V | Seedance 2.0 i2v | Kling O3 R2V | Kling V3 Pro | Vidu Q3 | Sora 2 | Wan 2.6 | LTX 2.0 | Veo 3.1 | Longcat | PixVerse |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `elements` | No | No | Yes | **NO** | No | No | No | No | No | No | No |
| `reference_image_urls` | **Yes** | No | Yes | **NO** | Yes | No | No | No | No | No | No |
| `scene_image_urls` | No | No | Yes | No | No | No | No | No | No | No | No |
| `end_image_url` | No | No | Yes | Yes | No | No | No | No | No | No | Transition |
| `audio_url` | No | No | No | No | No | No | Yes | No | No | No | No |
| `@Image` prompt tags | **Yes** | No | No | No | No | No | No | No | No | No | No |
| `aspect_ratio` | Yes | Yes | Yes | No | - | Yes | T2V only | Yes | T2V only | T2V only | Yes |
| `resolution` | Yes | Yes | No | No | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Max duration | **15s** | **15s** | 15s | 15s | 16s | 12s | 15s | 20s | 8s | **30s** | 8s |
| Audio | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No | Yes |
| Native lip-sync | **8+ langs** | **8+ langs** | No | No | No | No | No | No | No | No | No |

Always gate reference attachments through the capability matrix. Sending unsupported params to models that reject them returns 400 errors. The model registry in `src/venice/models.ts` has full typed specs for every model.

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

### Image-Tag R2V Models (Seedance 2.0 R2V — default)

- Replace character names in descriptions with `@Image1`, `@Image2` tokens via regex
- Dialogue speaker uses image ref: `[@Image1, voice description, delivery]: "dialogue line"`
- Attach `reference_image_urls` at the API layer (up to 4 flat images, front + three-quarter per character)
- Keep prompts concise (under 60 words). Use the 5-part structure: Subject, Action, Camera, Style, Constraints.
- Use physics-aware language: describe forces and materials, not just actions
- For multi-shot within a single generation, use "lens switch" between scene descriptions
- Append compact aesthetic + audio exclusion suffix
- **Important:** Seedance does NOT support `elements`, `scene_image_urls`, or `end_image_url`

### Elements-Capable Models (Kling O3 R2V — 3+ character fallback)

- Replace character names in descriptions with `@Element1`, `@Element2` tokens via regex
- Dialogue speaker uses element ref: `@Element1 (voice: low contralto...) says nervously: "..."`
- Scene image refs added as `Scene style references: @Image1, @Image2.`
- Append full aesthetic string + audio exclusion suffix (e.g., `No background music. Only generate dialogue, ambient sound, and sound effects.`)

### Reference-Image Models Without Tags (Vidu Q3)

- Use standard character names in prompt text (no element or image tokens)
- Attach `reference_image_urls` at the API layer (up to 4 flat images)
- Dialogue uses character name directly with voice description

### Text-Only Models (Kling V3 Pro, Veo 3.1)

- Inject full character descriptions including voice descriptions inline in the prompt
- No reference images attached (silently skipped)
- Structure: camera term first, then description, then dialogue with delivery cues
- Veo requires `resolution: '720p'`; Kling does NOT accept `resolution`/`aspect_ratio` (derived from input image)

### Native Multi-Shot (Kling 3.0, up to 6 shots, 15s max)

Kling 3.0 supports native multi-shot generation — a single prompt produces a single video with multiple distinct shots and automatic cuts between them. This works with the R2V model (`kling-o3-standard-reference-to-video`) which supports `elements` for identity anchoring across all shots.

**Prompt structure (per [Kling 3.0 Prompting Guide](https://blog.fal.ai/kling-3-0-prompting-guide/)):**
1. **Define subjects up front** with `@Element` refs and traits — Kling locks these across all shots
2. **State shot count and continuity instruction**: `"N-shot continuous sequence. Lock face, wardrobe, and environment across all shots."`
3. **Label each shot** as `Shot N (Xs):` with cinematic camera direction
4. **Dialogue format**: `[@Element1, voice description, delivery]: "dialogue line"` — bind dialogue to character actions
5. **Temporal separators**: `Immediately, cut to:` between shots for hard cuts
6. **Compact aesthetic** at the end — keep under 2500 chars total

**Example (2-shot dialogue with cut):**
```
@Element1 is SeehRov Kire: early 40s, lean, sandy-brown hair, pale blue-grey eyes.
Wearing ochre-sand linen overcoat, leather chest harness.

2-shot continuous sequence. Lock face, wardrobe across both shots.

Shot 1 (7s): Wide shot at a stone entrance.
@Element1 stands in the threshold facing the desert.
[@Element1, low measured baritone, quietly intense]: "I wrote the code that created a deity."
Sound of desert wind.

Immediately, cut to:

Shot 2 (6s): Extreme close-up on @Element1's face.
Golden amber sunlight from the side.
[@Element1, low measured baritone, voice hardening]: "Now I push the commit that destroys one."
```

**Key advantages over concatenated singles:**
- **Consistent identity** across the cut (same generation maintains character appearance)
- **Native audio continuity** (ambient sound and dialogue flow naturally)
- **Single API call** instead of multiple queue/poll cycles

**Grouping criteria:** Any consecutive shots with overlapping characters, no establishing/insert shots, total duration ≤ 15s. The planner greedily selects the largest valid window (up to 6).

### Environment Adaptation (All Models)

When a shot is set in a bright daytime environment while the project's default aesthetic is dark/moody:

1. **Image prompts:** Strip dark/rain-related terms from the aesthetic string; add anti-rain negative prompts
2. **Video prompts:** Append `Bright daytime scene, natural light, no rain.`
3. **Multi-edit (character fix):** Add `BRIGHT DAYTIME scene. Do NOT darken, no rain` instruction
4. **Multi-edit (style match):** Add `Keep bright warm lighting. Do NOT add rain, dark skies`

This prevents the project's default aesthetic from contaminating scenes with different lighting conditions.

## 7. Format-Specific Routing: Talk Shows, Interviews, Panels

For formats with **frequent speaker cuts** (talk shows, interviews, debate panels, podcasts), temporal continuity between shots matters less than character identity. Apply these overrides:

### All Character Shots Must Be R2V Singles

- **Never group shots with different speakers into multi-shot units.** The Kling multi-shot model (`kling-o3-pro-image-to-video`) does NOT support `elements` or `reference_image_urls` — characters lose all identity anchoring.
- **Set `mustStaySingle: true`** on all shots in talk show scripts, or ensure the generation planner only groups shots that share the same characters.
- **Every character shot uses R2V** — `seedance-2-0-reference-to-video` for 1-2 character shots (flat `reference_image_urls` with `@Image` tags), auto-fallback to `kling-o3-standard-reference-to-video` for 3+ characters (structured `elements`).

### Multi-Shot Grouping Rules for These Formats

The `hasOverlappingCharacters` check requires **pairwise character overlap** between consecutive shots. Shots that cut between different speakers (host → guest, speaker A → speaker B) have zero overlap and must be separate.

Valid multi-shot grouping examples:
- Shot A (Host) → Shot B (Host) → OK, same character
- Shot A (Host + Guest) → Shot B (Host) → OK, host overlaps

Invalid grouping (now prevented):
- Shot A (Host only) → Shot B (Guest only) → BLOCKED, no overlap
- Shot A (Guest A) → Shot B (Guest B) → BLOCKED, no overlap

### Duration Validation

Seedance 2.0 (now the default for both atmosphere and character shots) accepts **4s, 5s, 8s, 10s, 12s, or 15s** — not all integers. Veo 3.1 (legacy) only accepts 4s/6s/8s. The video queue function auto-snaps invalid durations to the nearest valid value. When scripting shots, use 4s minimum instead of 3s.

## 8. Anti-Patterns and Learned Routing Failures

### API Errors

- **Sending `elements` to Seedance R2V:** Seedance does NOT support structured `elements`. Only `reference_image_urls` (flat array, up to 4). The harness gates this via `supportsElements: false` in the model spec.
- **Sending `scene_image_urls` to Seedance R2V:** Not supported. Scene context must be described in the prompt text only.
- **Using `@Element` tags in Seedance prompts:** Seedance uses `@Image1`, `@Image2` tags for reference images. The `useImageTags` flag in `ModelResolution` controls which tag system the prompt builder uses.
- **Sending `elements`/`reference_image_urls` to Kling V3 Pro or Kling O3 Pro (non-R2V):** Returns 400. Only R2V models support these params.
- **Sending `resolution`/`aspect_ratio` to Kling image-to-video models:** Returns 400. These are derived from the input image automatically.
- **Omitting `aspect_ratio` from R2V models:** Both Seedance R2V and Kling O3 R2V require `aspect_ratio`. If omitted, it defaults to `16:9` in code. Always pass `aspect_ratio` explicitly.
- **Sending `image_references`/`image_1` to `nano-banana-pro`:** Returns 400. The generation model does not accept reference payloads at all.
- **Sending invalid durations:** Seedance 2.0 accepts 4s/5s/8s/10s/12s/15s. Veo 3.1 accepts 4s/6s/8s. Duration auto-snap corrects this.
- **Reference images below 300x300:** R2V models reject `reference_image_urls` and `elements` images smaller than 300x300 pixels. Never downscale character references below this threshold.
- **Sending non-seedream images to Seedance 2.0:** Seedance blocks any request whose input images were produced by a different family (nano-banana, flux, recraft, etc). The pre-flight gate catches this; the only accepted generators are `seedream-v5-lite` / `seedream-v5-lite-edit`. Either keep the image-generation family paired with Seedance, switch the video target to Kling O3 / Veo, or let the gate launder the images.

### Visual Contamination

- **Frame chaining from dark scene to bright scene:** The dark tone from the last frame bleeds into the bright scene. Use the panel image instead of chaining when the environment changes.
- **Multi-edit with dark character references re-darkening bright panels:** Character reference images shot in dark environments cause the edit model to match the overall tone, not just the face. Use environment adaptation instructions to preserve brightness.
- **Project aesthetic contaminating daytime scenes:** A dark/rainy default aesthetic bleeds into bright interiors unless explicitly stripped via environment adaptation.

### Identity Failures

- **Grouping different-character shots into multi-shot units:** The Kling multi-shot model has no reference image support. Characters rendered in a multi-shot unit with no `elements` lose identity completely. Always verify pairwise character overlap before grouping.
- **Frame chaining when new character enters:** The video model invents the new character's appearance from nothing. Always use the panel image (which was refined against character references) as the start frame when a new character appears.
- **Multi-edit with more than 2 character references:** The multi-edit endpoint accepts max 3 images total (base + 2 refs). Exceeding this drops references silently.
- **Sequential action in image descriptions:** Causes comic-panel layouts instead of single frames. Separate the single-frame panel description from the full video action description.
- **Vague body orientation:** Produces twisted poses. Always specify full-body direction explicitly (e.g., "seen entirely from behind", "facing camera directly").

### Style Consistency Failures

- **Aesthetic description buried at end of prompt:** The model commits to a rendering style before reaching the style instructions, causing inconsistency between angles/shots. Always front-load style with a `STYLE:` prefix and add a `STYLE REMINDER:` suffix.
- **Low cfg_scale for character references:** Using `cfg_scale: 7` gives the model too much freedom, causing style drift between angles (e.g., front is cartoon, profile is photorealistic). Use `cfg_scale: 10` for all character references and storyboard panels.
- **No anti-realism terms in negative prompt:** Without explicit `photorealistic, photograph, photo` in the negative prompt, stylized/illustration aesthetics drift toward realism on some angles.
- **Lighting mismatch between consecutive shots in same location:** Each panel generated independently can produce wildly different lighting for the same environment. Style-match later panels against earlier ones using multi-edit, or explicitly describe the established lighting.

### Multi-Edit Pitfalls

- **Multi-editing 16:9 close-ups destroys foreheads:** Multi-edit returns 1024x1024. Cropping to 16:9 removes ~25% from top and bottom. Close-up face shots lose foreheads and chins. For close-ups needing forehead detail (logos, headwear), generate from scratch with `nano-banana-pro` instead.
- **Establishing shots with silhouetted figures treated as empty:** Shots with `characters: []` trigger "no people" negative prompts, preventing silhouettes from appearing. Use `silhouetteCharacters` in the shot script for distant/back-turned figures that don't need R2V.
- **Logo/sigil descriptions misinterpreted:** Shorthand like "triple-V" or "VVV" produces random V-shapes. Always describe the actual geometric design (e.g., "two ornate skeleton keys crossed in an X with a chevron/book at top") or use the logo image file as a multi-edit reference.

## Troubleshooting

**"VENICE_API_KEY not set"** -- Set the environment variable or add it to your project's `.env` file.

**"Model not found"** -- Run `--list-models` to see available models. Use `--no-validate` for new/beta models not yet in the model list.

**Video stuck/timeout** -- Videos can take 1-5 minutes depending on model and duration. Use `--timeout 600` for longer videos.

**"requests" module not found** -- Install it: `pip3 install requests`
