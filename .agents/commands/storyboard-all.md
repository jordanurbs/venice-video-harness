# /storyboard-all

Generate the complete storyboard for all scenes in the screenplay.

## Usage
```
/storyboard-all --project <project-dir> [--skip-completed]
```

## Arguments
- `--project`: Project output directory (required)
- `--skip-completed`: Skip scenes already generated (optional)

## What This Does
1. Loads project state with all scenes, character locks, and aesthetic
2. Iterates through all scenes (or remaining scenes if --skip-completed)
3. For each scene:
   - Plans shots (establishing, coverage, dialogue, inserts)
   - Builds prompts with full character descriptions and face references
   - Generates images via Venice API
   - Saves panels with metadata
4. Compiles complete storyboard with all scenes
5. Renders full interactive HTML viewer

## Prerequisites
- Screenplay ingested (`/ingest-screenplay`)
- Characters locked (`/lock-characters`)
- Aesthetic set (`/set-aesthetic`)
- Recommended: validate first scene with `/storyboard-scene 1` before batch

## Execution
```bash
npx tsx src/cli.ts generate-all --project "$project_dir" --skip-completed
```

## Output
- All scene images saved to `<project>/scene-NNN/shot-NNN.png`
- Video prompt JSONs saved to `<project>/scene-NNN/shot-NNN.video.json`
- Complete HTML storyboard: `<project>/storyboard-full.html`
- Per-scene progress updates
- Final summary with total panel count

## Next Step: Video Generation
After panel images are generated, use `/generate-videos --project <dir> --scene <N>` to animate them into 8-second video clips via Venice Veo 3.1. Process one scene at a time.

## Notes
- This can make many API calls. A 30-scene screenplay with ~5 shots each = ~150 image generations.
- Use --skip-completed to resume after interruption.
- Each scene is saved incrementally so progress is preserved.

## Example
```
/storyboard-all --project output/my-film
/storyboard-all --project output/my-film --skip-completed
```
