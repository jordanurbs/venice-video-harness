# Shot Composition Skill

## Description
Plan cinematic shot lists for screenplay scenes, determining shot types, camera angles, movements, and lens choices for each beat.

## Read the scene's dramatic function first

Shot type, angle, movement, and lens are *consequences*, not starting points. Before you pick from the tables below, name what the beat is **doing** (a reveal, a goodbye, a power flip, a lie) and its **one intention**. A reveal is not framed, lit, blocked, or moved like a goodbye — derive the coverage from the intention instead of defaulting to "coverage that looks cinematic." Hold one directorial voice across the scene.

When the **Seedance 2.0 Skill OS** is installed (`.claude/skills/seedance-20/`), load `directing-engine` for the derivation method, and use `retake-protocol` (triage the verdict, change one variable, keep an attempt budget) and `continuation-handoff` (direct the next beat from accepted footage, not the original plan) when iterating. See this repo's README "Directing layer."

## Shot Types
| Type | Use Case | Lens |
|------|----------|------|
| extreme-wide | Establishing shots, epic scope | 14-24mm |
| wide | Full scene context, group shots | 24-35mm |
| medium-wide | Character in environment | 35-50mm |
| medium | Standard coverage, two-shots | 50mm |
| medium-close-up | Dialogue singles, OTS | 50-85mm |
| close-up | Emotional reactions, intensity | 85-135mm |
| extreme-close-up | Details, tension, key moments | 100mm+ macro |
| insert | Props, hands, objects, text | 50-100mm macro |

## Camera Angles
- **eye-level**: Neutral, standard coverage
- **low-angle**: Power, dominance, heroic
- **high-angle**: Vulnerability, surveillance, overview
- **dutch-angle**: Unease, disorientation, tension
- **birds-eye**: God's eye view, scale, pattern
- **worms-eye**: Extreme vulnerability, towering presence

## Camera Movements
- **static**: Standard locked-off shot
- **pan**: Horizontal sweep, following action or revealing
- **tilt**: Vertical movement, revealing height or scope
- **dolly**: Moving toward/away, intensifying or withdrawing
- **tracking**: Lateral movement alongside subject
- **crane**: Sweeping vertical + horizontal, epic establishing
- **handheld**: Urgency, documentary feel, chaos
- **rack-focus**: Shifting attention between depth planes

## Shot Planning Rules
1. Every new location starts with an establishing shot
2. Dialogue scenes: start wide, cut to OTS singles, use two-shots for emotional turns
3. Action sequences: wide for geography, medium for choreography, close for impact
4. Emotional beats: dolly-in to close-up, static holds for weight
5. Transitions between scenes match the screenplay's indicated transition
6. Insert shots for objects mentioned prominently in action lines

## Spatial Blocking Rules (rule 49 — placement is authored, not inferred)

AI video models re-infer placement on every generation, so shot plans must
state the geometry explicitly and keep it stable across a scene's coverage:

1. **Anchor to the location's named landmarks.** Each `Location` carries
   `spatialAnchors` (3-5 landmarks with fixed relative positions). Blocking
   language must reference those names ("at the bar counter", "in the
   doorway") so "by the window" means one specific window in every shot.
2. **Every character shot gets a `blocking` field**: each character/key
   object's position relative to the named anchors, their frame side (screen
   left / center / right), depth (foreground / midground / background), and
   facing/eyeline direction.
3. **Hold screen sides across coverage.** Characters keep the side of frame
   they had in the master unless a movement is scripted — and if they move,
   the movement is the shot's action, written into the description.
4. **Respect the 180-degree rule.** Pick the scene's axis at the master and
   keep eyelines/screen direction consistent in every single and reaction:
   if A looks right at B, A keeps looking right and B keeps looking left.
5. **Close-ups still name the geography.** State what is behind/beside the
   subject so backgrounds match the wide ("the neon window behind her
   shoulder"), or backgrounds will drift per generation.
6. **Establishing shots restate the full landmark layout** so the scene's
   geography is re-locked at every scene boundary.

## Transition Types
- **CUT**: Standard, default between shots
- **DISSOLVE**: Time passage, dream, memory
- **FADE**: Scene boundary, act break
- **MATCH CUT**: Visual or thematic connection between shots
- **SMASH CUT**: Abrupt tonal shift
- **WIPE**: Stylistic, retro, or geographic change

## Format-Specific Patterns

### Talk Show / Interview Format
Talk shows require frequent cuts between speakers. Each cut is a chance for character drift, so identity anchoring (R2V) takes priority over temporal continuity.

**Shot Pattern:**
1. **Establishing** (4s, atmosphere model): Empty studio set, audience in shadow, no characters
2. **Host intro** (8-10s, R2V): Host addresses camera or introduces guest
3. **Guest dialogue** (8-10s, R2V): Guest speaks, reaction-ready
4. **Host reaction** (3s, R2V): Silent reaction shot — the comedic beat
5. **Host response** (8s, R2V): Host delivers counter/punchline
6. **Two-shot moment** (8s, R2V): Both characters, pivotal exchange
7. **Guest reaction** (3s, R2V): Reaction to devastating line
8. **Host close-up** (10s, R2V): Closing monologue to camera
9. **Title card** (4s, atmosphere model): Empty set, title overlay, fade out

**Rules for this format:**
- Every shot with characters uses R2V (`kling-o3-standard-reference-to-video`)
- `mustStaySingle: true` on all shots — never group different speakers
- Reaction shots (3s, silent) are critical for comedy timing
- Establishing/title shots have NO characters — use atmosphere model
- Minimum duration for atmosphere model is **4s** (not 3s)
- Camera movements: mostly `medium close-up` and `slow zoom in`, with occasional `tracking` for pacing shots

**Transitions:**
- Use `CUT` between all speaker cuts (clean breaks)
- Use `FADE` only for opening and closing
- Never use `DISSOLVE` or `MATCH CUT` between different speakers (implies continuity that doesn't exist)

### Panel Discussion / Multi-Speaker Format
Similar to talk show but with 3+ speakers. Additional rules:
- Reaction shots can show multiple listeners
- Wide shots establish spatial relationships between speakers
- Each speaker's first appearance must use panel image (not frame chain) for identity anchoring

## Usage
```typescript
import { planShots } from './storyboard/shot-planner.js';
const shots = planShots(scene);
```
