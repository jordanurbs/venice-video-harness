# Core Schema Additions

Oct 5, 2026 · the Venice Video Creator team, for Jordan. Follows `plan-to-update.md` (proposal) and `plan-to-update-response.md` (your answers).

You accepted three optional additions to `series/types.ts` in principle: `takes[]`, the approval digest, and a `ReferenceSet` passed as data. This document gives each a concrete shape, and adds four smaller fields that our first downstream consumption of `packages/core` (PR #41) and a field-by-field comparison of the two schemas surfaced. Every item is an optional field or a new type; an unchanged CLI keeps working. We would like a yes / no / change-it per item before Phase 3 freezes the schema, so Phase 5 on our side migrates once.

Ground rule, stated so it is not in doubt: the harness is the source of truth. Where our app and the harness disagree, our choice goes. Everything below is additive to `series/types.ts`; nothing asks the CLI to change what it stores today.

## 1. `takes[]` — accepted in principle; the shape

A take is one render of one shot: what was sent, what came back, what QA said, whether a human accepted it. The CLI has the inputs (`*.recipe.json` sidecars, `failed-requests.log`, the `qa-report`) but no per-take record. Retry policy, cost history and "which take is in the cut" all need one.

```ts
export interface ShotTake {
  id: string;
  /** Reference seconds / ISO — see §7. */
  createdAt: string;
  /** The exact `/video/queue` body minus the base64 payloads (asset refs instead). */
  recipe?: TakeRecipe;
  model: string;
  seed?: number;
  /** Project-relative path of the rendered clip; absent while queued or after a failure. */
  outputPath?: string;
  /** Venice queue id, for re-attach and for the audit trail. */
  queueId?: string;
  /** USD, from `/video/quote` or the retrieve body; absent when unknown. */
  costUsd?: number;
  status: 'queued' | 'rendered' | 'failed' | 'rejected';
  /** Venice's refusal / failure, classified (`classifyVideoQueueRefusal`, `VideoGenerationFailedError`). */
  failure?: { kind: string; status?: string; detail?: string; refunded?: boolean };
  qa?: TakeQA;
  /** A human accepted this take for the shot as the shot was configured then — see §2 for the binding. */
  review?: TakeReview;
}

export interface TakeRecipe {
  prompt: string;
  negativePrompt?: string;
  duration: string;
  resolution?: string;
  aspectRatio?: string;
  audio?: boolean;
  /** In push order, so `@ImageN` can be reconstructed. Asset refs, not bytes. */
  referenceImages?: string[];
  startFrame?: string;
  endFrame?: string;
  audioUrl?: string;
  referenceAudio?: string[];
  elements?: Array<{ frontal: string; angles: string[] }>;
  sceneImages?: string[];
}

export interface TakeQA {
  score?: number;
  passed: boolean;
  issues: string[];
  summary: string;
  /** The vision model that judged it. */
  model?: string;
}
```

`ShotScript.takes?: ShotTake[]` and `ShotScript.currentTakeId?: string` ("the one in the cut"). The CLI could populate `takes[]` from the recipe sidecar at render time with no other change; everything else is optional.

What we are asking: is `TakeRecipe` the right level (asset refs, no bytes), and is `status` the right ladder? We hold `qaPassed` / `qaIssues[]` today and would drop our shape for yours.

## 2. Approval digest — accepted in principle; align with #40

#40 already stores per shot `{ panelSha256, settingsDigest }` in `qa-approved.json`, and `settingsDigest` is a sha256 of canonical `PanelSettings`. We hold the same two facts under different names (`revision: { assetID, contentDigest, settingsDigest }`) and bind them in two places: the panel review and the take review.

Proposal: lift #40's shape into core as the one binding type, and use it on both.

```ts
/** What a human looked at: the panel's bytes and the settings it depends on. From `panel-approval.ts`. */
export interface ApprovalBinding {
  panelSha256: string;
  settingsDigest: string;
}

export interface PanelReview {
  binding: ApprovalBinding;
  verdict: 'passed' | 'failed' | 'unchecked' | 'error';
  /** Who or what reviewed: a model id, or a person. */
  reviewer: string;
  summary: string;
  approvedBy?: string;
  approvalReason?: string;
  approvedAt?: string;
  reviewedAt: string;
}

export interface TakeReview {
  status: 'approved';
  at: string;
  note?: string;
  /** `settingsDigest` of the shot's video settings when approved; an edit after that makes the take stale. */
  settingsDigest: string;
}
```

`ShotScript.panelReview?: PanelReview`. The CLI keeps writing `qa-approved.json`; `verifyApproval` reads the same `ApprovalBinding` either way. Your #40 note 3 (paths bound, not bytes, for reference images) applies equally; we do not propose changing it.

What we are asking: name. `ApprovalBinding` vs `ShotApproval` (what #40 calls it). We will take whichever you keep.

## 3. `ReferenceSet` — accepted as "the key unlock"; the shape

Today `buildReferenceSlotPlan(series, shot, modelId)` probes disk (`existsSync`, `readdirSync`) for `characters/<slug>/{anchor,front,three-quarter,profile,full-body}.png`, `locations/<slug>/{north,south,east,west,…}.png`, `storyboards/<slug>.png`. A browser host has the same images as asset ids, not files. Proposal: the planner takes a `ReferenceSet` and the CLI builds one from disk with today's exact file rules, so CLI behaviour is unchanged by construction.

```ts
/** One image a shot may reference, with where it came from and what it shows. `ref` is opaque to core. */
export interface ReferenceImage {
  /** Path on the CLI, asset id in a browser. Core never opens it. */
  ref: string;
  /** Rule-41 provenance: `true` blocks faces-off models; `false` clears; absent = undecided. */
  hasFace?: boolean;
}

export interface CharacterReferences {
  name: string;
  /** `anchor.png` > `front.png` > `three-quarter.png` on the CLI. */
  primary: ReferenceImage;
  /** In preference order; the planner takes the first that is not `primary`. Keyed by view so the role clause can name it. */
  angles: Array<ReferenceImage & { view: 'three-quarter' | 'profile' | 'full-body' | string }>;
}

export interface LocationReferences {
  slug: string;
  /** In compass order (`north`, `south`, `east`, `west`, then the legacy names), each with its wall so the role clause can name it. */
  plates: Array<ReferenceImage & { wall: 'north' | 'south' | 'east' | 'west' | string }>;
}

export interface ReferenceSet {
  characters: CharacterReferences[];
  locations: LocationReferences[];
  /** `storyboardRef` plate, when present. */
  storyboard?: ReferenceImage;
}
```

`buildReferenceSlotPlan(series, shot, modelId, refs: ReferenceSet)`; `ReferenceSlot.path` becomes `ReferenceSlot.ref`. The CLI's `resolveShotReferenceInputs` then reads `slot.ref` as a path exactly as it reads `slot.path` now. The role clauses, fill order (primaries → storyboard → location → one character angle) and budget are untouched.

What we are asking: is `hasFace` the right place for the provenance bit (it is what `assertFacesOffCompatible` reads from the sidecar today), and do you want `wall` / `view` as closed unions or open strings? We lean open, since custom `*.png` plates are already allowed.

## 4. `Character.kind: 'person' | 'object'`

We anchor props and vehicles the same way as people: a locked reference, angle views, an `@ImageN` slot with a role clause ("is the golden chalice: its shape, material and markings"). The harness's `Character` is a person (`gender`, `age`, `voiceDescription`). Proposal: `kind?: 'person' | 'object'`, default `'person'`, and the three places that assume a face read it:

- `resolveVideoModel`'s `faceSafe` only swaps faces-off ids when a `person` is in the shot (an object-only shot is fine on a `-basic` id).
- `assertFacesOffCompatible` treats an object's references as `hasFace: false` unless the sidecar says otherwise.
- the identity line uses an object role clause instead of `— wearing <wardrobe>`.

Nothing else changes; `gender` / `age` / `voiceDescription` stay required on the type and are ignored for objects (or become optional, your call).

## 5. `ShotScript.dialogue` as a list, each line with an id

Core's `dialogue` is one `{ character, line, delivery } | null`. We hold `dialogue: Array<{ id, characterId?, speaker?, text, voiceOver }>` because a shot can carry two lines and a beat map (picture timed to an accepted VO take) keys on the line id. You said in the response you would consider an array "only if the harness wants multi-line shots". The ask is smaller than that:

```ts
export interface DialogueLine {
  /** Stable across edits; what a beat map or a lip-sync cue points at. */
  id?: string;
  character: string;
  line: string;
  delivery?: string;
  /** Narration / V.O.: no mouth on camera, `audio: false` on the model, TTS owns the lane. Today inferred from the character name (`NARRATOR`, `V.O.`). */
  voiceOver?: boolean;
}
```

`dialogue: DialogueLine | DialogueLine[] | null`, with the prompt builder treating a single object as a one-element list. Existing `series.json` files parse unchanged; `voiceOver` makes the NARRATOR-by-name convention explicit without removing it. If a list is a step too far, `id` and `voiceOver` on the single object alone cover our beat map.

## 6. `referenceCheck` on `Character` and `Location`

A vision check of the locked reference against its own description, run once at lock time: "does `front.png` show what `description` says?" Panels and every shot copy the reference, so a wrong one is cheapest to catch there. We store `{ ref, pass, issues[], summary }` and show it beside the lock. Optional, informational, never a gate on the CLI unless you want one.

```ts
export interface ReferenceCheck {
  /** The reference that was checked; the check counts only while it is still the locked one. */
  ref: string;
  pass: boolean;
  issues: string[];
  summary: string;
}
```

`Character.referenceCheck?`, `Location.referenceCheck?`. `lock-character` could run it with the series' `intelligence.visionModel`; we already do on our side.

## 7. Two conventions to settle, no new fields

- **Timestamps.** Core uses ISO strings (`createdAt: string`). Our files use Swift reference seconds (number since 2001-01-01). We will convert at our adapter; core stays ISO. Stated so nobody proposes a number.
- **Motion.** Core's `ShotScript.motion` is `low | medium | high`. Ours is `still | subtle | moderate | dynamic`. We map `still → low`, `subtle | moderate → medium`, `dynamic → high` and drop our ladder. Stated so nobody proposes a fourth step.

## What we are not proposing

- Our `audioContent` (`full | noMusic | ambienceOnly | dialogueOnly`) → dropped; `VIDEO_NO_MUSIC_SUFFIX` plus `nativeAudio` cover it.
- Our `startFromPanel` / `matchPreviousPanel` → dropped; rule 42 holds (your answer 3).
- Our per-shot `status` ladder → dropped; `EpisodeMeta.status` plus `takes[].status` cover it.
- Our `styleBlock` string → dropped for `AestheticProfile`.
- Our `resolution` as a plan-level default → dropped; the model's ladder and `buildModelParams` decide.

## Sequencing

Items 1–3 shape Phase 3 (the prompt builder and reference slots move into core with `ReferenceSet` as their input; `takes[]` and `ApprovalBinding` are what the Phase 4 loop reads and writes). Items 4–6 are independent one-field PRs that can land any time after #41. Item 7 is just an agreement.

We will open each accepted item as its own small PR against `main`, type first with a test, then the one or two call sites that read it.
