# /generate-videos

Generate video clips from storyboard panel images using Venice AI's image-to-video models with frame chaining for visual continuity.

## Usage
```
/generate-videos --project <project-dir> --scene <scene-number> [--model <model>]
```

## Arguments
- `--project`: Project output directory (required)
- `--scene`: Scene number to generate videos for (required)
- `--model`: Video model to use (optional, default: `kling-o3-pro-image-to-video`)

## Execution

Run the frame-chaining video generation script from the project root:

```bash
npx tsx scripts/generate-scene-videos.ts <project-dir> <scene-number> [model]
```

**IMPORTANT**: Must be run from the project root directory (`long-form-ai-vidgen/`), not from a subdirectory.

## What This Does

1. Discovers all `shot-NNN.video.json` files in the scene directory
2. Processes shots sequentially with **frame chaining**:
   - **Shot 1**: `image_url` = panel PNG (storyboard image as first frame)
   - **Shot N>1**: `image_url` = last frame extracted from previous video via ffmpeg
   - **Kling O3 Pro only**: `end_image_url` = next shot's panel PNG (composition target)
3. For each shot:
   a. Reads `shot-NNN.video.json` for prompt, duration, and model config
   b. Encodes the appropriate image (panel or last frame) as base64 data URI
   c. Queues video via `POST /api/v1/video/queue`
   d. Polls `POST /api/v1/video/retrieve` every 10s until MP4 is returned
   e. Archives existing MP4 as `shot-NNN-v1.mp4` if present
   f. Saves the resulting MP4 as `shot-NNN.mp4`
   g. Extracts the last frame via ffmpeg for chaining to the next shot
   h. Calls `POST /api/v1/video/complete` for cleanup
4. Reports progress after each shot

## Prerequisites
- Storyboard panels must be generated first (`/storyboard-scene` or `/storyboard-all`)
- `shot-NNN.png` and `shot-NNN.video.json` files must exist in the scene directory
- `VENICE_API_KEY` must be set in `.env`
- `ffmpeg` and `ffprobe` must be on PATH (used for last-frame extraction)

## Frame Chaining

The key innovation over the old batch script (`generate-all-videos.ts`) is frame chaining:

- Each video begins where the previous one visually ended
- The last frame of shot N is extracted via `ffmpeg -ss <duration-0.05>` and used as `image_url` for shot N+1
- With Kling O3 Pro, the NEXT shot's panel is also passed as `end_image_url`, guiding the video toward the target composition
- If frame extraction fails, the script falls back to using the shot's own panel

This creates smooth visual continuity even with hard cuts between shots.

## Available Models

| Model | Durations | `end_image_url` | Render Time | Extra Params |
|-------|-----------|-----------------|-------------|--------------|
| `kling-o3-pro-image-to-video` (default) | 3s/5s/8s/10s/13s/15s | YES | 2-6 min | None (no resolution/aspect_ratio) |
| `vidu-q3-image-to-video` | 3s/5s/8s/10s/12s/14s/16s | No | TBD | `resolution: "1080p"` |
| `veo3.1-fast-image-to-video` (legacy) | 8s only | No | ~90s | `resolution: "720p"` |

## Video JSON Format

The script reads `shot-NNN.video.json` with a `video` block (NOT the legacy `veo` block):

```json
{
  "panelId": "S1-P3",
  "sceneNumber": 1,
  "shotNumber": 3,
  "video": {
    "model": "kling-o3-pro-image-to-video",
    "prompt": "A slow dolly shot...",
    "duration": "5s",
    "audio": true
  },
  "metadata": {
    "transition": "CUT",
    "cameraMovement": "dolly-in, slowly"
  }
}
```

If old-format files with a `veo` block exist, rename them to `.video.json.bak` and regenerate with correct format.

## Variant Preservation Policy

**NEVER delete existing MP4 files.** When regenerating:
- Existing `shot-NNN.mp4` is renamed to `shot-NNN-v1.mp4` (or next version)
- New file takes the `shot-NNN.mp4` name

## Output
- `shot-NNN.mp4` files in `<project>/scene-NNN/`
- `lastframe-NNN.png` extracted frames used for chaining
- Previous versions archived as `shot-NNN-v1.mp4`, etc.

## Examples
```
/generate-videos --project output/erik-voorhees-manifesto --scene 1
/generate-videos --project output/erik-voorhees-manifesto --scene 2 --model vidu-q3-image-to-video
```
