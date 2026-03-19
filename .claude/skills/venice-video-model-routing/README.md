# Venice Video Model Routing for Character Consistency

A Claude Code agent skill that combines Venice AI media generation tools with intelligent model routing for character consistency. Includes executable Python scripts for image generation, video generation, image editing, and upscaling, plus decision trees for choosing the right model, reference images, frame sources, and prompt format for every shot.

Based on the [venice-ai-media](https://github.com/openclaw/skills/tree/main/skills/nhannah/venice-ai-media) skill by [@nhannah](https://github.com/nhannah) for generation execution, extended with production-tested model routing logic for multi-shot character consistency.

## What This Skill Does

**Generation layer** (bundled scripts):
- Generate images via `nano-banana-pro`, `flux-2-max`, and other Venice image models
- Generate videos from images via Kling, Veo, WAN, and Sora models
- Edit images with AI (face correction, style changes, inpainting)
- Upscale images 1-4x with optional AI enhancement

**Routing layer** (decision trees):
- Select the right video model tier (action, atmosphere, or character-consistency)
- Attach the right reference images (`elements`, `reference_image_urls`, `image_urls`)
- Choose the right starting frame (panel image vs previous video's last frame)
- Adapt prompts per model (element tokens, inline descriptions, voice cues)
- Refine panels via two-pass pipeline (generate then multi-edit)

## Prerequisites

- **Python 3.10+**
- **Venice API key** -- get one free at [venice.ai/settings/api](https://venice.ai/settings/api)

```bash
export VENICE_API_KEY="vn_your_key_here"
```

## Quick Start

```bash
# Generate an image
python3 scripts/venice-image.py --prompt "a cyberpunk street at night" --model nano-banana-pro

# Generate a video from an image
python3 scripts/venice-video.py --image panel.png --prompt "slow dolly forward" --model kling-v3-pro-image-to-video --duration 5s --audio

# Edit an image
python3 scripts/venice-edit.py panel.png --prompt "make the woman's hair darker"

# Upscale an image
python3 scripts/venice-upscale.py panel.png --scale 2 --enhance

# List available models
python3 scripts/venice-image.py --list-models
python3 scripts/venice-video.py --list-models
```

## Key Decision Trees

### Video Model Upgrade (Action/Atmosphere -> Character Consistency)

```
Explicit useElements/useReferenceImages?      -> consistency model
No characters in shot?                        -> base model (no upgrade)
Shot type is close-up or reaction?            -> consistency model
continuityPriority === 'identity'?            -> consistency model
New character entering scene?                 -> consistency model
Otherwise                                     -> base model
```

### Frame Source Strategy

```
Panel image (identity priority):
  - First shot, scene boundary, new character, close-up/reaction
  - Transitions: CUT, SMASH CUT

Previous last frame (continuity priority):
  - Same characters continue
  - Transitions: DISSOLVE, MATCH CUT, MORPH, WIPE, CROSSFADE, FADE
```

### Model Capability Matrix

| Parameter | Kling O3 R2V | Kling V3 Pro | Vidu Q3 | Veo 3.1 |
|-----------|:---:|:---:|:---:|:---:|
| `elements` | Yes | NO (400) | No | No |
| `reference_image_urls` | Yes | NO (400) | Yes | No |
| `image_urls` | Yes | No | No | No |
| `end_image_url` | Yes | Yes | No | No |

## Installation

Clone into your project's skills directory:

```bash
git clone https://github.com/jordanurbs/venice-video-model-routing.git your-project/.claude/skills/venice-video-model-routing/
```

Or copy manually:

```bash
cp -r venice-video-model-routing/ your-project/.claude/skills/venice-video-model-routing/
```

## Skill Structure

```
venice-video-model-routing/
  SKILL.md                        # Main skill with routing + generation docs
  scripts/
    venice_common.py              # Shared utilities (API key, HTTP, model listing)
    venice-image.py               # Image generation
    venice-video.py               # Video generation (queue/poll/download)
    venice-edit.py                # Image editing
    venice-upscale.py             # Image upscaling
  references/
    decision-trees.md             # ASCII flowcharts for routing decisions
  README.md
```

## Venice AI Models Covered

### Video Generation
- `kling-v3-pro-image-to-video` -- action tier (movement, dialogue, fights)
- `veo3.1-fast-image-to-video` -- atmosphere tier (establishing shots, inserts)
- `kling-o3-standard-reference-to-video` -- character consistency tier (identity-critical shots, default)
- `kling-o3-pro-reference-to-video` -- character consistency tier (higher quality, slower)
- `kling-o3-pro-image-to-video` -- multi-shot units
- `vidu-q3-image-to-video` -- 1080p output with reference image support
- `wan-2.6-image-to-video` -- configurable audio, various durations
- `sora-2-image-to-video` -- high quality, requires aspect ratio

### Image Generation
- `nano-banana-pro` -- recommended for storyboard panels (supports seed, cfg_scale, steps)
- `flux-2-max` -- general purpose default
- `gpt-image-*` -- GPT-based image models

### Image Editing (Multi-Edit)
- `nano-banana-pro-edit` (default), `nano-banana-2-edit`, `gpt-image-1-5-edit`, `grok-imagine-edit`, `qwen-edit`, `flux-2-max-edit`, `seedream-v4-edit`, `seedream-v5-lite-edit`

## Pricing

| Feature | Cost |
|---------|------|
| Image generation | ~$0.01-0.03 per image |
| Image upscale | ~$0.02-0.04 |
| Image edit | ~$0.04 |
| Video (WAN) | ~$0.10-0.50 |
| Video (Kling) | ~$0.20-1.00 |
| Video (Sora) | ~$0.50-2.00 |

Use `python3 scripts/venice-video.py --quote` to check pricing before generation.

## Credits

Generation scripts adapted from [venice-ai-media](https://github.com/openclaw/skills/tree/main/skills/nhannah/venice-ai-media) by [@nhannah](https://github.com/nhannah).

## License

MIT
