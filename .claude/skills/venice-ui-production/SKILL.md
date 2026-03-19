# Venice UI Episode Production Skill

## Description

Plan and produce mini-drama episodes for manual generation through the Venice AI web UI (venice.ai) instead of the automated CLI pipeline. Outputs a complete shot-by-shot production guide with copy-paste-ready image prompts, video prompts, frame reference instructions, and Venice UI settings.

## When To Use

Use this skill when the user wants to:
- Create an episode using the Venice web interface manually (not `npx tsx src/mini-drama/cli.ts`)
- Get a production-ready prompt guide they can work through shot by shot in a browser
- Plan an episode with all prompts, settings, and frame references documented in one place

## Workflow

### Step 1 — Gather Series Context

Read these files to understand the series state:

1. **`output/<series>/series.json`** — aesthetic, characters (names, descriptions, wardrobe, voice descriptions), seed, video defaults
2. **Previous episode scripts** — `output/<series>/episodes/episode-NNN/script.json` — for story continuity
3. **Character references** — `output/<series>/characters/<name>/front.png` — for visual consistency notes

Extract from `series.json`:
- `aesthetic.style`, `aesthetic.palette`, `aesthetic.lighting`, `aesthetic.lensCharacteristics`, `aesthetic.filmStock` → build the **aesthetic prefix** and **aesthetic bookend**
- `aestheticSeed` → the fixed seed for all image generation
- Each character's `fullDescription`, `wardrobe`, `voiceDescription`

### Step 2 — Write the Episode Script

Collaborate with the user on story beats. Target **~55-60 seconds** total runtime across 8-12 shots.

For each shot, determine:
- **Type**: establishing, action, dialogue, close-up, insert, atmosphere
- **Duration**: 3s / 5s / 8s / 10s / 13s (see duration guide below)
- **Video model recommendation**: action (Kling V3 Pro) or atmosphere (Kling V3 Pro or Veo 3.1)
- **Characters present**: with full descriptions for the image prompt
- **Dialogue**: character, line, and **delivery cue** (tone/manner/emotion)
- **Camera movement**: dolly, tracking, crane, static, pan, push-in, etc.
- **Transition to next shot**: CUT, FADE, DISSOLVE, MATCH CUT, SMASH CUT
- **SFX / ambient**: what sounds should be present
- **Subtitles**: formatted as `CHARACTER: "Line"`

### Step 3 — Build the Production Guide

Output a single markdown document saved to `output/<series>/episodes/episode-NNN/venice-ui-guide.md` with these sections:

---

## Production Guide Structure

### Header
- Episode number, title, series name
- Runtime target
- "Previously" recap (1-2 sentences)
- Episode synopsis (3-4 sentences)

### Venice UI Settings (Global)
A table of settings that stay constant for every shot:

| Setting | Value |
|---------|-------|
| **Model** | `nano-banana-pro` |
| **Seed** | `<aestheticSeed from series.json>` |
| **CFG Scale** | `10` |
| **Steps** | `30` |
| **Resolution** | `1K` |
| **Aspect Ratio** | `9:16` |
| **Safe Mode** | Off |
| **Watermark** | Off |

### Frame Reference Rules
Explain the transition-based frame chaining rules (see section below).

### Aesthetic Prefix + Bookend
Two copy-paste blocks derived from `series.json`:

**Prefix** (front-load every image prompt):
```
STYLE: <style>. <palette>. <lighting>. <lensCharacteristics>. <filmStock>.
```

**Bookend** (paste at end of every image prompt):
```
STYLE REMINDER: <abbreviated style + palette + lighting keywords>.
```

### Shot-by-Shot Breakdown
For each shot, a section containing:

#### Shot N — Title (Type)
**Type**: ...
**Duration**: ...
**Transition**: ...
**Characters**: ...

##### Image Prompt
A complete, self-contained prompt with:
1. Aesthetic prefix (full)
2. Scene content with exhaustive character descriptions (never abbreviate — include age, build, features, wardrobe every time)
3. Aesthetic bookend

##### Video Generation
A settings table:

| Setting | Value |
|---------|-------|
| **Model** | `kling-v3-pro` (image-to-video) or `veo3.1-fast` |
| **Duration** | `Ns` |
| **Audio** | On |
| **`image_url`** | What to use as starting frame (panel or last frame of previous video) |
| **`end_image_url`** | What to use as ending frame target (next panel or none) |

If frame chaining is required, include a callout with the ffmpeg extraction command.

##### Video Prompt
Plain prose prompt following video prompt rules (see below).

##### Subtitle
Formatted dialogue or "*(none)*".

### Shot Summary Table
Quick-reference table with all shots, durations, transitions, frame references, and characters.

### Post-Generation Notes
- Multi-edit refinement paths (character references for face/body consistency)
- Character reference file paths
- Music mood/direction for Venice audio generation

---

## Image Prompt Rules

### Structure (Every Prompt)
```
STYLE: <full aesthetic description from series.json>

<Scene content: setting, characters with FULL descriptions, action, composition, framing notes>

STYLE REMINDER: <abbreviated aesthetic keywords>
```

### Character Description Rules
- **Never abbreviate** — include the full description + wardrobe for every character in every prompt
- **Female characters**: always include figure/body descriptors as written in `series.json`
- **Male characters**: always include build, face, and wardrobe details
- If a character is in the background or silhouette, note that but still describe them enough for recognition
- For two-shots, describe both characters fully and specify their spatial relationship

### Composition Notes
- Always specify `Vertical 9:16 composition` for framing guidance
- Describe depth of field: "shallow depth of field with bokeh neon circles" for intimate shots
- Specify if characters are sharp vs. blurred (foreground/background separation)

---

## Video Prompt Rules

### Structure
Plain prose, no tags. Follow this order:
1. **Camera movement first**: "A slow dolly shot pushes forward..." / "Close-up on..."
2. **Subject + action**: who is doing what
3. **Dialogue with delivery cues**: `CHARACTER speaks in <voice description>: "<line>"`
4. **Environment/atmosphere**: lighting, weather, background activity
5. **Audio direction**: "Sound of rain, distant traffic, glass clinking."
6. **Mandatory footer**: `No background music. Only generate dialogue, ambient sound, and sound effects.`

### Dialogue in Video Prompts
Include the character's voice description from `series.json` for consistency:
```
SERA speaks in a low, silky contralto with deliberate pacing and faint European accent: "Line here."
```

Good delivery cues:
- `"in a dominant, irritated tone"` — angry authority
- `"calmly, almost amused"` — detached wit
- `"nervously"` — anxious uncertainty
- `"whispering seductively"` — intimate intensity
- `"with quiet fury"` — restrained anger
- `"with a quiet, knowing smile"` — controlled confidence

### Duration Selection Guide
| Duration | Best For |
|----------|----------|
| 3s | Quick reactions, insert shots, impact moments, montage beats |
| 5s | Standard dialogue, character reveals, medium-paced action |
| 8s | Multi-line dialogue exchanges, establishing shots, slow reveals |
| 10s | Extended atmosphere, complex camera moves, emotional beats |
| 13s | Long takes, elaborate tracking shots, climactic moments |

---

## Frame Reference Rules (Transition-Aware)

Two references control visual continuity between shots:

### `image_url` (Starting Frame)
The image the video animates FROM.

| Transition | `image_url` Source |
|------------|-------------------|
| CUT | Shot's own **panel image** |
| SMASH CUT | Shot's own **panel image** |
| FADE | **Last frame of previous video** |
| DISSOLVE | **Last frame of previous video** |
| MATCH CUT | **Last frame of previous video** |
| CROSSFADE | **Last frame of previous video** |

### `end_image_url` (Ending Frame Target — Kling Only)
The image the video animates TOWARD.

| Transition | `end_image_url` Source |
|------------|----------------------|
| CUT | None |
| SMASH CUT | None |
| FADE | None |
| DISSOLVE | **Next shot's panel image** |
| MATCH CUT | **Next shot's panel image** |
| CROSSFADE | **Next shot's panel image** |

### Extracting Last Frame
When frame chaining is needed, extract the last frame from the previous shot's video:
```bash
ffmpeg -sseof -0.05 -i shot-NNN.mp4 -frames:v 1 lastframe-NNN.png
```

### Writing It In The Guide
For each shot, explicitly state both references in the video settings table. For CUT transitions, note "use panel, not last frame" to prevent confusion. For FADE/DISSOLVE transitions, add a callout block with the ffmpeg command.

---

## Video Model Selection

| Model | Best For | Durations |
|-------|----------|-----------|
| `kling-v3-pro-image-to-video` | Dialogue, action, gestures, character movement. Supports `end_image_url`. | 3s, 5s, 8s, 10s, 13s, 15s |
| `veo3.1-fast-image-to-video` | Atmosphere, establishing, static/slow shots. No `end_image_url`. | 8s only |

Default to **Kling V3 Pro** unless the shot is pure atmosphere with no character movement or dialogue.

Venice UI video settings:
- **Audio**: Always on (the model generates dialogue + SFX + ambient natively)
- **Do NOT set resolution or aspect_ratio** for image-to-video (derived from input image)

---

## Post-Generation: Multi-Edit Refinement

After generating panels in Venice UI, optionally refine through multi-edit for character consistency:

- **Character shots**: Upload panel + character's `front.png` reference(s) (max 2 characters)
- **Non-character shots**: Upload panel + any character shot from this episode as a "style anchor"
- Multi-edit returns 1024x1024; crop/scale back to 9:16 after

---

## Post-Generation: Assembly

After all panels and videos are generated:

1. Save panels as `shot-NNN.png` in `output/<series>/episodes/episode-NNN/scene-001/`
2. Save videos as `shot-NNN.mp4` in the same directory
3. Generate background music via Venice audio generation (specify mood in the guide)
4. Assemble with: `npx tsx src/mini-drama/cli.ts assemble-episode -p output/<series> -e <N>`

Or assemble manually with ffmpeg if not using the pipeline.

---

## Example Output

See `output/neon-hearts/episodes/episode-002/venice-ui-guide.md` as a complete reference implementation of this workflow applied to a real episode.
