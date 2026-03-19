# Model Routing Decision Trees

Structured flowchart versions of the routing logic for Venice AI video and image model selection. Load this reference when evaluating which model, frame source, or reference strategy to use for a specific shot.

---

## 1. Video Model Upgrade Decision Tree

Determines whether to upgrade from the base action/atmosphere model to the character-consistency model.

```
INPUT: shot, previousShot
       baseModel = action or atmosphere model
       consistencyModel = character-consistency model

START
  |
  +-- shot.useElements OR shot.useReferenceImages?
  |   YES -> consistencyModel (explicit opt-in)
  |
  +-- shot has no characters?
  |   YES -> baseModel (no characters to anchor)
  |
  +-- shot.type in {close-up, reaction}?
  |   YES -> consistencyModel (identity-sensitive framing)
  |
  +-- shot.continuityPriority === 'identity'?
  |   YES -> consistencyModel (identity preservation requested)
  |
  +-- any character NOT in previousShot?
  |   YES -> consistencyModel (new character needs reference anchoring)
  |
  +-- none matched
      -> baseModel (default prompt-first)
```

When `consistencyModel` is selected:
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
