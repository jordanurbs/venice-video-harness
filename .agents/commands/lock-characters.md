# /lock-characters

Generate reference images for characters to maintain visual consistency across the storyboard.

## Usage
```
/lock-characters --project <project-dir> [--character <name>]
```

## Arguments
- `--project`: Project output directory (required)
- `--character`: Lock a specific character only (optional, defaults to all)

## What This Does
1. Loads the project state with extracted character descriptions
2. For each character (or specified character):
   - Generates 4 reference images: front face, 3/4 view, profile, full body
   - Uses the character's exhaustive description as the prompt
   - Tracks the generation seed for reproducibility
3. Saves reference images as PNG files in `<project>/characters/<name>/`
4. Marks characters as "locked" in project state

## Character Consistency Strategy
- **Layer 1**: Exhaustive text description injected into every prompt
- **Layer 2**: Reference images (base64) passed to Venice Nano Banana Pro multi-ref
- **Layer 3**: Edit endpoint correction if face drifts

## Execution
```bash
npx tsx src/cli.ts lock-characters --project "$project_dir" --character "$name"
```

## Output
- Reference images saved to disk
- Character lock status in project state
- Next step: run `/set-aesthetic`

## Example
```
/lock-characters --project output/my-film
/lock-characters --project output/my-film --character "SARAH"
```
