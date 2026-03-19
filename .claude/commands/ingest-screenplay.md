# /ingest-screenplay

Ingest and parse a screenplay file, extracting scenes and characters.

## Usage
```
/ingest-screenplay <path-to-screenplay> [--name <project-name>]
```

## Arguments
- `path`: Path to a .fountain or .pdf screenplay file (required)
- `--name`: Optional project name (defaults to filename)

## What This Does
1. Reads the screenplay file
2. Parses it using fountain-js (Fountain) or pdf-parse + heuristics (PDF)
3. Extracts all scenes with headings, locations, time of day, action, dialogue, transitions
4. Identifies all characters and their physical descriptions from action text
5. Builds character description profiles for image generation
6. Saves project state to `output/<project-name>/project.json`

## Execution
Run the CLI command:
```bash
npx tsx src/cli.ts ingest "$path" --name "$name"
```

## Output
- Scene count and list
- Character list with dialogue counts
- Project directory path
- Next step: run `/lock-characters`

## Example
```
/ingest-screenplay screenplays/my-film.fountain --name my-film
```
