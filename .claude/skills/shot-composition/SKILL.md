# Shot Composition Skill

## Description
Plan cinematic shot lists for screenplay scenes, determining shot types, camera angles, movements, and lens choices for each beat.

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

## Transition Types
- **CUT**: Standard, default between shots
- **DISSOLVE**: Time passage, dream, memory
- **FADE**: Scene boundary, act break
- **MATCH CUT**: Visual or thematic connection between shots
- **SMASH CUT**: Abrupt tonal shift
- **WIPE**: Stylistic, retro, or geographic change

## Usage
```typescript
import { planShots } from './storyboard/shot-planner.js';
const shots = planShots(scene);
```
