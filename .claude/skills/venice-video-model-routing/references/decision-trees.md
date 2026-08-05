# Model Routing Decision Trees

Structured flowchart versions of the routing logic for Venice AI video and image model selection. Load this reference when evaluating which model, frame source, or reference strategy to use for a specific shot.

---

## 1. Video Model Selection Decision Tree

Determines the video model for a shot. R2V is the default — atmosphere model is only for empty establishing shots.

```
INPUT: shot, previousShot
       r2vModel = R2V model (kling-o3-standard-reference-to-video)
       atmosphereModel = atmosphere model (veo3.1-fast-image-to-video)

START
  |
  +-- shot.videoModel === 'atmosphere' AND no characters?
  |   YES -> atmosphereModel (empty establishing/mood shot)
  |
  +-- everything else
      -> r2vModel (consistency first)
```

When `r2vModel` is selected:
- Auto-enable `elements` if model supports them
- Auto-enable `reference_image_urls` if model supports them

---

## 2. Start Frame Strategy Decision Tree

Determines `image_url` source: the shot's own panel image vs the last frame of the previous video.

```
INPUT: previousShot, currentShot

START
  |
  +-- no previousShot?
  |   -> PANEL (first shot)
  |
  +-- currentShot.continuityPriority === 'identity'?
  |   -> PANEL (identity takes priority over flow)
  |
  +-- scene boundary? (establishing shot, no character overlap, etc.)
  |   -> PANEL (new scene, no visual continuity needed)
  |
  +-- new characters entering? (any char in current not in previous)
  |   -> PANEL (panel has refined character appearance)
  |
  +-- identity-sensitive type AND continuityPriority !== 'continuity'?
  |   -> PANEL (close-up/reaction needs correct face from panel)
  |
  +-- previousShot.transition in CHAIN_TRANSITIONS?
  |   -> PREVIOUS-LAST-FRAME (smooth visual flow)
  |
  +-- otherwise
      -> PANEL (CUT/SMASH CUT = clean break)

CHAIN_TRANSITIONS = {DISSOLVE, MATCH CUT, MORPH, WIPE, CROSSFADE, FADE}
```

---

## 3. End Frame Strategy Decision Tree

Determines `end_image_url` source: next shot's panel image vs natural ending (Kling models only).

```
INPUT: currentShot, nextShot

START
  |
  +-- no nextShot?
  |   -> NATURAL (nothing to target)
  |
  +-- new characters in nextShot not in currentShot?
  |   -> NATURAL (end_image would show wrong character appearance)
  |
  +-- nextShot is title card or insert?
  |   -> NATURAL (don't animate toward text/insert)
  |
  +-- currentShot.transition in END_FRAME_TRANSITIONS?
  |   -> NEXT-PANEL-TARGET (animate toward next composition)
  |
  +-- otherwise
      -> NATURAL (CUT/SMASH CUT/FADE = let video end naturally)

END_FRAME_TRANSITIONS = {DISSOLVE, MATCH CUT, MORPH, WIPE, CROSSFADE}
(note: FADE is NOT in this set -- fades end naturally, unlike dissolves)
```

---

## 4. Reference Image Attachment Decision Tree

Determines which reference parameters to attach to the video API call.

```
INPUT: shot, modelResolution

START
  |
  +-- shot has no characters?
  |   -> NO REFERENCES (nothing to anchor)
  |
  +-- (elements requested OR auto-enabled)
  |   AND model supports elements?
  |   |
  |   YES -> ELEMENTS
  |   |      frontalImageUrl: front-facing character reference
  |   |      referenceImageUrls: three-quarter + profile angles
  |   |      prompt tokens: @Element1, @Element2, ...
  |   |      max: 4 elements
  |   |
  |   NO --+
  |        |
  +--------+
  +-- (reference images requested OR auto-enabled)
  |   AND model supports reference_image_urls?
  |   |
  |   YES -> REFERENCE_IMAGE_URLS
  |   |      flat array: front + three-quarter per character
  |   |      max: 4 total images
  |   |      no special prompt tokens needed
  |   |
  |   NO --+
  |        |
  +--------+
  +-- model doesn't support any reference mechanism
      -> NO REFERENCES (text descriptions only)
```

Additionally, `image_urls` (scene references) are attached independently when:
- Scene/environment reference paths are provided AND
- Model supports scene images
- Prompt references them as `@Image1`, `@Image2`

---

## 5. Two-Pass Panel Refinement Decision Tree

Determines how each generated panel is refined for character/style consistency.

```
INPUT: shot, panelPath

START
  |
  +-- refinement disabled globally?
  |   -> SKIP (no refinement)
  |
  +-- shot.skipRefine === true?
  |   -> SKIP (per-shot opt-out)
  |
  +-- panel already refined in a prior run?
  |   -> SKIP (backup file exists, not regenerated)
  |
  +-- shot has characters?
  |   |
  |   YES -> CHARACTER REFINEMENT
  |   |      images[0]: panel
  |   |      images[1]: char1 front-facing reference
  |   |      images[2]: char2 front-facing reference (if 2 chars, max 2)
  |   |      prompt: match face/body proportions + wardrobe
  |   |      respects: wardrobe overrides, environment adaptation
  |   |
  |   NO --+
  |        |
  +--------+
  +-- no characters (establishing, insert, title card)
      -> STYLE REFINEMENT
         images[0]: panel
         images[1]: style anchor (a refined character shot from same project)
         prompt: match rendering style, palette, line weight, lighting
         respects: environment adaptation

POST-REFINEMENT:
  Multi-edit returns 1024x1024
  -> Crop center + scale to original aspect ratio (e.g., 768x1376 for 9:16)
```

---

## 6. Model Capability Quick Reference

```
                    elements  ref_images  scene_images  end_image  resolution
Kling O3 R2V          Y          Y            Y           Y        derived
Kling V3 Pro          X (400)    X (400)      X           Y        derived
Kling O3 Pro          X          X            X           Y        derived
Vidu Q3               X          Y            X           X        1080p
Veo 3.1 Fast          X          X            X           X        720p
nano-banana-pro       X (400)    X (400)      X           n/a      1K
nano-banana-pro-edit  n/a        up to 2      n/a         n/a      1024x1024
```

Legend: Y = supported, X = not supported, (400) = returns HTTP 400 error

---

## 7. Multi-Shot Grouping Decision Tree

Determines whether consecutive shots should be grouped into a single native
multi-shot unit or rendered as individual R2V singles. Multi-shot units render
on `seedance-2-0-enhanced-reference-to-video` by default (2026-08-05) — one
reference-first generation with `Lens switch.` separators, carrying the full
@Image slot plan. The Kling i2v lane is an explicit
`videoDefaults.multiShotModel` override only.

```
INPUT: window of consecutive shots

START
  |
  +-- any shot has mustStaySingle or allowMultiShot === false?
  |   -> SINGLES (script override blocks grouping)
  |
  +-- any shot is establishing, insert, or title card?
  |   -> SINGLES (these should always render independently)
  |
  +-- total duration exceeds 15s?
  |   -> SINGLES (exceeds the single-generation limit on both lanes)
  |
  +-- shots span more than one location?
  |   -> SINGLES (one slot plan per generation — rule 21b)
  |
  +-- do consecutive pairs share at least one character?
  |   |
  |   NO -> SINGLES (different characters lose R2V anchoring)
  |   |
  |   YES -> GROUP (identity/environment/lighting hold inside one generation)
  |
  +-- CRITICAL: for talk shows / interviews / panels:
      -> PREFER SINGLES (identity anchoring > temporal continuity)
      -> set mustStaySingle: true on all shots

PAIRWISE OVERLAP CHECK (fixed bug):
  For shots [A, B, C]:
    A.characters ∩ B.characters must be non-empty
    B.characters ∩ C.characters must be non-empty
  NOT: "each shot has chars in the union pool" (this is the OLD buggy check)
```

---

## 8. Duration Validation Decision Tree

Validates shot durations against model specs before queuing.

```
INPUT: model, requestedDuration

START
  |
  +-- model has no duration constraints?
  |   -> USE AS-IS
  |
  +-- requestedDuration in model.durations?
  |   -> USE AS-IS
  |
  +-- otherwise
      -> SNAP to nearest valid duration
      -> log warning

MODEL DURATION CONSTRAINTS:
  veo3.1-fast-image-to-video:  4s, 6s, 8s (NO 3s, 5s, 7s)
  kling-o3-*-reference-to-video: 3s-15s (1s increments)
  kling-o3-pro-image-to-video:   3s-15s (1s increments)
```
