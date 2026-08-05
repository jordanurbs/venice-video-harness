# Screenplay Parsing Skill

## Description
Parse screenplays from Fountain (.fountain) and PDF (.pdf) formats into structured scene data.

## Supported Formats

### Fountain Format
- Industry-standard plain-text screenplay format
- Parsed with fountain-js library
- Handles: scene headings, action, character names, dialogue, parentheticals, transitions, title page, sections, synopses, notes

### PDF Format
- Extracts text via pdf-parse
- Applies heuristic rules:
  - Scene headings: lines starting with INT. or EXT.
  - Character names: ALL CAPS lines preceding dialogue (not scene headings or transitions)
  - Dialogue: indented text following character names
  - Transitions: lines ending with "TO:" or known transitions (CUT TO, DISSOLVE TO, FADE IN/OUT)
  - Action: all remaining non-blank lines

## Output Structure
```typescript
Scene {
  number, heading, location, timeOfDay,
  characters[], action[], dialogue[],
  transitions[], mood
}
```

## Mood Inference
Keywords mapped to moods:
- dark/shadow/blood/death → "dark, ominous"
- laugh/smile/bright/sun → "bright, warm"
- quiet/still/silence → "quiet, contemplative"
- run/chase/fight/gun → "tense, action"
- kiss/love/embrace → "romantic, intimate"
- Default: "neutral"

## Usage
```typescript
import { parseFountain } from './parsers/fountain-parser.js';
import { parsePdfToTokens } from './parsers/pdf-parser.js';
import { extractScenes } from './parsers/scene-extractor.js';

const parsed = await parseFountain('screenplay.fountain');
const scenes = extractScenes(parsed);
```
