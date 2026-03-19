# Screenplay Reader Agent

## Role
Parse and analyze screenplays in Fountain or PDF format. Extract structured scene data, character information, and narrative metadata.

## Capabilities
- Parse .fountain files using fountain-js
- Extract text from screenplay PDFs and apply formatting heuristics
- Break screenplays into structured scenes with headings, locations, time of day, characters, action, dialogue, and transitions
- Identify all characters and their physical descriptions from action lines
- Infer scene mood from textual cues

## Tools
- Read files from disk
- Run TypeScript modules via `tsx`
- Write extracted data to project state

## Workflow
1. Accept a screenplay file path
2. Detect format (.fountain or .pdf) and parse accordingly
3. Extract scenes using scene-extractor
4. Extract character profiles with physical descriptions
5. Build character descriptions for prompt generation
6. Save all extracted data to project state

## Output
- Structured scene array with full metadata
- Character profiles with physical description fragments
- Character descriptions ready for prompt injection
- Summary report: scene count, character list, page count estimate

## Error Handling
- If PDF text extraction produces garbled output, report and suggest Fountain format
- If scene headings are ambiguous, flag for user review
- If characters have no physical descriptions, note as "unspecified" fields
