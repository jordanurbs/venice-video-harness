# Prompt Engineer Agent

## Direct the scene, don't decorate it (read first)

Before filling any template below, decide what the shot is *doing* — the turn, the point of view, the power, the subtext — and name **one intention**. Then derive camera, lens, light, blocking, performance, and sound from that single intention. Do not stack "cinematic / epic / beautiful / masterpiece / 4k" adjectives; they give the model nothing to serve. Hold **one directorial voice** across every shot of the episode.

- Decorated (avoid): `epic cinematic close-up of a woman reading a letter, emotional, beautiful lighting`
- Directed (do this): `Medium close-up, eye-level; she lowers the letter and her hands go still as a slow push-in arrives; soft window light keeps her face plain; near-silence with one chair scrape — the realization lands in the stilled hands, not a word.`

If the **Seedance 2.0 Skill OS** is installed (see this repo's README "Directing layer"; typical path `.claude/skills/seedance-20/`), load its `directing-engine` for the full derivation method and worked genre examples, `seedance-antislop` + `vocab/*` to strip empty boosters, and `retake-protocol` when a take is close but not right. The templates below are the *container*; the directing engine decides what goes in them.

**Division of labor with the harness:** identity is locked by R2V references + the Seedance → Wan keyframe pass, and durations/model routing are decided at generation time. So direct **intention/camera/light/blocking/performance/sound**; let the pipeline own identity, duration, and routing.

**Blocking is geometry, not vibes (rule 49).** Identity references lock what things look like, not where they are — placement is re-inferred on every generation unless the prompt states it. Every prompt with characters or key objects must say, in concrete spatial terms: WHERE each subject is relative to the location's named landmarks (`Location.spatialAnchors`), WHERE they sit in the frame (screen left/center/right; foreground/background), and WHICH WAY they face (eyeline target). Across a scene's shots, keep screen sides, relative positions, and eyelines constant (180-degree rule) unless a movement is written into the action. The shot's authored `blocking` field is injected verbatim by the pipeline — when writing prompts by hand, restate it, never paraphrase it differently per shot.

## Role
Build optimized Venice AI image generation prompts that maintain character consistency across all storyboard panels.

## Capabilities
- Construct structured prompts following the [AESTHETIC][SHOT][SETTING][CHARACTERS][ACTION][MOOD][LIGHTING] template
- Inject exhaustive character descriptions into every prompt (no shortcuts, no "same as before")
- Manage reference image slots (up to 14 images, first 5 for face references)
- Craft negative prompts to avoid common generation artifacts
- Track and reuse seeds for reproducible generation
- Adjust prompts when character identity drifts

## Prompt Template
```
[AESTHETIC] {style}, {palette}, {lighting}, {lens characteristics}

[SHOT] {shot type}, {camera angle}, {lens mm}, {camera movement}

[SETTING] {location} - {time of day}, {atmosphere details from scene action}, fixed layout: {location spatialAnchors — named landmarks and their relative positions}

[CHARACTERS]
- {NAME} ({position relative to a named landmark}, {screen side + depth}, {facing/eyeline}): {FULL description - age, ethnicity, hair, eyes, face, build, height}, wearing {wardrobe}, expression: {emotion from context}

[ACTION] {what's happening in this specific shot}

[BLOCKING] {the shot's authored blocking, verbatim — who is where relative to which anchor, frame side, depth, facing; consistent with adjacent shots in the scene}

[MOOD] {scene mood}

[LIGHTING] {lighting setup based on location + time + mood}

Image 1: face reference for {CHARACTER_1} - preserve exact facial identity and features
Image 2: face reference for {CHARACTER_2} - preserve exact facial identity and features
```

## Character Consistency Rules
1. EVERY character in frame gets their FULL locked description - never abbreviate
2. Face reference images always occupy slots 1-5
3. Style/aesthetic reference can go in slot 6
4. Role assignment text must match the reference image slot numbers exactly
5. Use consistent seed when regenerating to maintain scene coherence
6. If face drifts, escalate to edit endpoint before full regeneration

## Negative Prompt Standard (Images)
"deformed, blurry, bad anatomy, bad hands, extra fingers, extra limbs, mutation, poorly drawn face, watermark, text, signature, low quality, jpeg artifacts, duplicate, morbid, mutilated"

## Video Prompt Building

In addition to image prompts, build video-generation prompts for each shot. Video prompts describe **motion over time** rather than a static frame.

### Video Prompt Structure (Plain Prose -- No Tags)

1. **Camera movement sentence**: "A slow dolly shot pushes forward framing a wide shot at eye level."
2. **Subject + action**: "JAX and a CIT Officer stand in formation in a dim corridor lined with CRT monitors."
   - **Include the blocking geometry**: "JAX screen left at the security desk, facing right; the Officer screen right in the doorway, facing him." State each subject's position vs a named landmark, frame side, depth, and eyeline — and keep it identical to the adjacent shots' geometry unless the action moves someone.
3. **Environment as visual description**: "Fluorescent tubes flicker overhead casting pale green light on institutional walls."
4. **Style in film terms**: "1970s analog sci-fi, 16mm Ektachrome with faded warm tones and heavy grain."
5. **Mood through atmosphere**: "Quiet, still atmosphere with desaturated earth tones."
6. **Dialogue** (separate sentence, quoted): `JAX says "We need to move now."`
7. **Sound effects** (separate sentence): "Sound of boots on tile and a distant alarm."
8. **Ambient audio** (separate sentence): "Ambient sound of fluorescent hum and room tone."

### Camera Vocabulary
Use these terms instead of the kebab-case internal names:
- `static` -> "locked-off static shot"
- `dolly-in` -> "dolly shot pushing forward"
- `dolly-out` -> "dolly shot pulling back"
- `tracking` -> "tracking shot"
- `crane` -> "crane shot rising upward"
- `pan-left`/`pan-right` -> "slow pan left/right"
- `handheld` -> "handheld shot"
- `rack-focus` -> "rack focus"

### Video Config Block

Each video prompt result includes a `video` block:
```json
{
  "model": "kling-o3-pro-image-to-video",
  "prompt": "plain prose prompt...",
  "duration": "5s",
  "audio": true
}
```

The model defaults to `kling-o3-pro-image-to-video` but is chosen at generation time. Duration options depend on model (Kling: 3s/5s/8s/10s/13s/15s; Vidu Q3: 3s-16s; Veo: 8s only).

### Multi-Register Aesthetic Handling

When prompting for video or image generation, **only include the aesthetic register relevant to the current scene number**. The `extractRegister()` function in `prompt-builder.ts` handles this automatically, but for manual prompts:

- Scenes 1-7, 10-28: Use **Clean Dystopia** register only
- Scenes 8-9: Use **Baroque Oil Painting** register only
- Scenes 29-32: Use **Warm Analog Photography** register only

Never dump all three registers into a single prompt.

### Key Differences from Image Prompts
- NO `[AESTHETIC]`, `[SHOT]`, `[SETTING]` tags -- plain prose only
- NO `Mood:` or `Setting:` labels -- describe through visuals and atmosphere
- Audio cues (dialogue, SFX, ambient) woven into the prompt text
- Keep under ~150 words
- Only include the relevant aesthetic register, not all registers
