# /storyboard-scene

Generate the storyboard for a single scene. Use this to validate results before batch generating.

## Usage
```
/storyboard-scene <scene-number> --project <project-dir>
```

## Arguments
- `scene-number`: The scene number to generate (required)
- `--project`: Project output directory (required)

## What This Does
1. Loads project state (scenes, character locks, aesthetic)
2. Plans shots for the specified scene (establishing, coverage, dialogue, inserts)
3. Builds Venice prompts for each shot with:
   - Locked aesthetic profile
   - Full character descriptions for every character in frame
   - Character face reference images as base64
   - Scene-specific lighting and mood
4. Generates images via Venice Nano Banana Pro at 1K resolution
5. Assembles panels with metadata annotations
6. Renders an HTML storyboard viewer for this scene

## Prerequisites
- Screenplay must be ingested (`/ingest-screenplay`)
- Characters should be locked (`/lock-characters`)
- Aesthetic should be set (`/set-aesthetic`)

## Execution
```bash
npx tsx src/cli.ts generate-scene --project "$project_dir" --scene "$scene_number"
```

## Output
- Generated images saved to `<project>/scene-NNN/shot-NNN.png`
- Video prompt JSONs saved to `<project>/scene-NNN/shot-NNN.video.json`
- HTML storyboard: `<project>/scene-<N>-storyboard.html`
- Panel count and generation summary

## Next Step: Video Generation
After panel images are generated, use `/generate-videos --project <dir> --scene <N>` to animate them into 8-second video clips via Venice Veo 3.1.

## Example
```
/storyboard-scene 1 --project output/my-film
```
