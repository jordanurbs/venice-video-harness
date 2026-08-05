Run a visual QA analysis on generated storyboard panels for character and setting consistency.

## Steps

1. Load the series data:
   - Read `output/<series>/series.json` for character descriptions, wardrobe, aesthetic
   - Read `output/<series>/episodes/episode-NNN/script.json` for shot descriptions and which characters appear where

2. Load character reference images:
   - Read each character's `front.png` from `output/<series>/characters/<name>/front.png`
   - These are the ground truth for what each character should look like

3. Load all generated storyboard panels:
   - Read each `shot-NNN.png` from the episode's `scene-001/` directory

4. For each panel, analyze using vision:

   **Character Consistency** (compare against reference images and character description):
   - Hair: color, length, style matches description?
   - Face: recognizable as same character across panels?
   - Body/figure: matches build description? (bust, physique, etc.)
   - Wardrobe: matches character wardrobe description? Colors, style, accessories correct?
   - Skin tone: consistent?

   **Setting Continuity** (compare across sequential panels):
   - Time of day / lighting consistent?
   - Weather consistent? (rain, etc.)
   - Location style consistent?
   - Color palette matches aesthetic?

   **Aesthetic Adherence**:
   - Art style matches locked aesthetic?
   - Color grading consistent?

   **Spatial Continuity** (compare against the shot's `blocking`, the location's `spatialAnchors`, and the nearest prior panel in the same location):
   - Each character/object on the stated frame side, at the stated depth, facing the stated direction?
   - Positions correct relative to the location's named landmarks?
   - Screen sides held from the previous same-location panel (no side-swaps)?
   - Eyelines / screen direction preserved (180-degree rule)?
   - Landmarks (doors, windows, counters, key props) unmoved — no mirroring, vanishing, or rearranging?

5. Rate each panel:
   - **PASS**: Character, setting, and spatial geometry match descriptions
   - **FLAG-CRITICAL**: Character appearance is wrong (wrong hair, wrong outfit, wrong body type) OR a spatial flip that breaks the scene (characters swapped sides, geography mirrored/rearranged vs the previous panel)
   - **FLAG-MODERATE**: Minor drift but recognizable (slightly different shade, small detail off); character on the wrong frame side vs stated blocking; a relocated landmark
   - **FLAG-LOW**: Stylistic variance or small placement deviation within acceptable range

6. Present the QA report to the user:
   - Show each flagged panel inline with the specific issues
   - Compare side-by-side with reference images when character issues found
   - Recommend which panels to regenerate
   - Suggest prompt adjustments for flagged panels

7. If user approves regeneration:
   - Delete the flagged panel PNGs
   - Re-run `storyboard-episode` (it skips existing panels, so only deleted ones regenerate)
   - Or write custom prompts for specific panels that need targeted fixes

## Important
- Always load and show the character reference images alongside flagged panels for visual comparison
- Be specific about what's wrong: "Sera's hair is shoulder-length bob in shot 4 but should be long flowing dark hair per her description"
- Be equally specific about spatial issues: "JAX was screen left at the counter in shot 3 but is screen right in shot 4 with no scripted movement — side-swap, regenerate"
- Focus most on CRITICAL issues (wrong appearance, broken scene geography) -- these break immersion across episodes
- Run this QA automatically after every storyboard-episode generation
