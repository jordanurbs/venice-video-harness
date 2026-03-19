# Character Consistency Skill

## Description
Maintain visual consistency for characters across all storyboard panels using a three-layer approach.

## Layer 1: Exhaustive Text Description
Every character in every shot prompt receives their complete locked description. No abbreviations, no "same as before." The model sees the full description each time.

### Description Format
```
CHARACTER_NAME: [age]-year-old [ethnicity/appearance], [hair description],
[facial features], [eye description], [build/height],
[distinguishing features], wearing [wardrobe]...
```

### Description Fields
- Age range (e.g., "mid-30s", "early 50s")
- Ethnicity/general appearance
- Hair: color, length, style, texture
- Eyes: color, shape, notable features
- Face: shape, notable features (cheekbones, jaw, etc.)
- Build: body type, approximate height
- Distinguishing marks: scars, tattoos, glasses, etc.
- Default wardrobe + scene-specific wardrobe changes

## Layer 2: Reference Image Generation & Seed Anchoring
Venice `nano-banana-pro` does NOT accept reference image payloads via API parameters (no `image_references`, `image_1`, etc.). Passing these causes a 400 error. Instead, character consistency relies on:

- **Seed anchoring**: Each character gets a fixed seed recorded at lock time. The same seed is used for all reference angles and influences generation consistency.
- **Prompt-embedded identity markers**: Include "Image N: face reference for CHARACTER" text in prompts. While no actual image data is sent, this text anchors the model's attention on maintaining the described appearance.
- **Exhaustive re-description**: The full character description (Layer 1) is the primary consistency mechanism. Every prompt repeats the complete physical description.

### Reference Generation
4 angles per character are generated and stored for human review (NOT sent to the API):
1. Front face (primary reference sheet)
2. Three-quarter view
3. Profile view
4. Full body

These reference images serve as:
- Visual documentation for the production team
- Comparison targets when reviewing generated panels for drift
- Input for Layer 3 (edit endpoint correction) when faces need fixing

### Seed Tracking
- Same seed used for all reference angles of a character
- Seed recorded in `character-lock.json` for reproducibility
- Panel seeds are derived from character seed + shot number

## Layer 3: Edit Endpoint Correction
When generated images have good composition but face drift:
1. Use Venice `/images/edit` with mask over face area
2. Prompt: "correct face to match reference - [key features]"
3. If edit fails, regenerate with adjusted seed + reinforced description

## Usage
```typescript
import { ReferenceManager } from './characters/reference-manager.js';
const manager = new ReferenceManager(outputDir);
const lock = await manager.generateReferences(client, description);
const faceBase64 = manager.getBase64Face(lock);
```
