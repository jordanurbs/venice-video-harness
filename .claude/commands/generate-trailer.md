# /generate-trailer

Analyze the screenplay and generate a curated trailer -- selecting the most compelling moments, generating panel images, and creating video clips.

## Usage
```
/generate-trailer --project <project-dir> --duration <1m|3m>
```

## Arguments
- `--project`: Project output directory (required)
- `--duration`: Trailer length -- `1m` for 1-minute teaser (10-15 shots) or `3m` for 3-minute theatrical (25-40 shots). Default: `1m`
- `--model`: Video model to use (optional, default: `kling-o3-pro-image-to-video`). Options: `kling-o3-pro-image-to-video`, `vidu-q3-image-to-video`, `veo3.1-fast-image-to-video`

## What This Does

### Phase 1: Screenplay Analysis
1. Load `project.json` and read all scene data
2. Analyze the dramatic arc: world, inciting incident, protagonist journey, central tension
3. Identify the most visually striking and emotionally resonant moments
4. Follow the trailer-curator agent's methodology (see `.claude/agents/trailer-curator.md`)

### Phase 2: Shot List Curation
1. Select 10-15 shots (1m) or 25-40 shots (3m) from across the screenplay
2. For each shot, determine:
   - Scene source and specific moment
   - Shot composition (type, camera, framing)
   - Duration in the trailer
   - Audio layer (dialogue, SFX, ambient)
   - Whether an existing storyboard panel can be reused
3. Arrange shots into the trailer's pacing structure:
   - **1m**: Atmosphere (slow) -> Intrigue (medium) -> Escalation (fast) -> Title
   - **3m**: Status Quo -> Inciting Incident -> Rising Stakes -> Cliffhanger -> Title
4. Save the shot list as `output/<project>/trailer/trailer-plan.json`
5. Present the shot list to the user for review before generating

### Phase 3: Panel Generation
1. Create `output/<project>/trailer/` directory
2. For shots that reuse existing panels: symlink or copy from `scene-NNN/`
3. For new shots: generate via Venice API using:
   - The project's locked aesthetic profile
   - Full character descriptions from character locks
   - `nano-banana-pro` model, `1K` resolution, `16:9` aspect ratio
4. Save as `shot-T01.png`, `shot-T02.png`, etc.
5. Generate corresponding `shot-TNN.video.json` for each panel

### Phase 4: Video Generation
1. For each trailer panel, generate a video clip using the selected model:

   **Kling O3 Pro (default):**
   - Model: `kling-o3-pro-image-to-video`
   - Duration: choose per shot based on trailer pacing (3s/5s/8s/10s/13s/15s)
   - No `resolution` or `aspect_ratio` (derived from image, causes 400)
   - Audio: `true`
   - Render time: ~360s per shot

   **Vidu Q3:**
   - Model: `vidu-q3-image-to-video`
   - Duration: choose per shot (3s/5s/8s/10s/12s/14s/16s)
   - Resolution: `1080p`
   - Audio: `true`
   - Cost: $0.58 per generation
   - Render time: TBD

   **Veo 3.1 (legacy):**
   - Model: `veo3.1-fast-image-to-video`
   - Duration: `8s` (fixed)
   - Resolution: `720p`
   - Audio: `true`
   - Render time: ~60-90s per shot

2. Use prose prompts (camera first, plain description, under 150 words)
3. Process sequentially (one at a time)
4. Save as `shot-T01.mp4`, `shot-T02.mp4`, etc.

### Phase 5: Assembly
1. Generate an HTML trailer viewer (`trailer-1m.html` or `trailer-3m.html`)
2. The viewer displays all shots in sequence with their planned durations
3. Includes metadata: dialogue, SFX, pacing notes

## Trailer Pacing Guidelines

### 1-Minute Teaser
| Beat | Shots | Duration per shot | Total |
|------|-------|-------------------|-------|
| Atmosphere (slow open) | 2-3 | 5-8s | ~15-20s |
| Intrigue (building) | 4-6 | 3-4s | ~15-20s |
| Escalation (rapid cuts) | 3-5 | 1-2s | ~8-10s |
| Title card | 1 | 3-5s | ~4s |
| **Total** | **10-15** | | **~60s** |

### 3-Minute Theatrical
| Beat | Shots | Duration per shot | Total |
|------|-------|-------------------|-------|
| Status Quo | 6-8 | 4-6s | ~30-40s |
| Inciting Incident | 5-8 | 3-5s | ~20-30s |
| Rising Stakes | 8-12 | 2-4s | ~25-35s |
| Escalation | 5-8 | 1-2s | ~10-15s |
| Final beat + Title | 2-3 | 4-6s | ~10-15s |
| **Total** | **25-40** | | **~180s** |

## Shot Selection Rules

### Include
- World-building establishing shots (empty environments, cityscapes)
- Character introduction moments (protagonist in their element)
- The disruption (the moment everything changes)
- Antagonist presence (power, threat, contrast)
- Key relationship beats (ally introduction, trust moments)
- Visual set-pieces (raids, chases, revelations)
- Emotional close-ups (faces showing transformation)

### Exclude
- Act 3 resolution (never spoil the ending)
- Exposition-heavy dialogue scenes
- Extended action sequences (hint, don't show)
- Happy endings or resolution moments
- More than one shot from any single story beat

## Prerequisites
- Screenplay must be ingested (`/ingest-screenplay`)
- Characters should be locked (`/lock-characters`)
- Aesthetic should be set (`/set-aesthetic`)
- Existing storyboard panels are helpful but not required

## Output Structure
```
output/<project>/trailer/
  trailer-plan.json       -- curated shot list with metadata and pacing
  shot-T01.png            -- panel image (new or copied from storyboard)
  shot-T01.video.json     -- Veo prompt and metadata
  shot-T01.mp4            -- generated video clip
  ...
  trailer-1m.html         -- HTML sequence viewer (1-minute version)
  trailer-3m.html         -- HTML sequence viewer (3-minute version)
```

## Example
```
/generate-trailer --project output/captain-jax --duration 1m
/generate-trailer --project output/captain-jax --duration 3m
```
