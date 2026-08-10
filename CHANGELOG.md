# Changelog

## 2.16.0-montage (branch: seedance-2-5-montage) — 2026-08-07

### Changed

- **Seedance 2.5 is now the default video model across every lane** (was
  Seedance 2.0 R2V Enhanced). `DEFAULT_ACTION_MODEL`, `DEFAULT_ATMOSPHERE_MODEL`,
  `DEFAULT_CHARACTER_CONSISTENCY_MODEL`, `DEFAULT_MULTISHOT_MODEL`,
  `resolveVideoFamilyDefaults('seedance'|'auto')`, and the in-family
  `resolveLipSyncModel('seedance'|'auto')` all resolve to
  `seedance-2-5-reference-to-video`, matching the montage lane. This unifies the
  whole harness on 2.5: single-pass up to 30s, up to 30 reference images,
  `audio_url` + reference audio in-family. Trade-off: 2.5 caps at 720p (the
  mini-drama generator already pins 720p for Seedance, so no request regresses);
  2.0 R2V Enhanced (1080p) stays registry-known and selectable via
  `videoDefaults`. Added `seedance-2-5-reference-to-video` to
  `MODELS_SUPPORTING_AUDIO_INPUT` (its spec is `audio_input: true`; the
  registry-coverage test enforces the set). Regenerated `capabilities.json`.
  See AGENTS.md rule 51.
- **`sd25-pe` skill installed** at `.agents/skills/sd25-pe/` — the Seedance 2.5
  Prompt Optimizer plus a harness-bridge section mapping its compiled Prompts
  onto the harness fields (montage SEQUENCE grammar, @Image discipline, no-music
  suffix; the harness stays authoritative on identity/refs/duration/resolution).

### Added

- **Seedance 2.5 in the registry.** `seedance-2-5-text-to-video` /
  `seedance-2-5-image-to-video` / `seedance-2-5-reference-to-video` — live on
  quote/queue only (not on GET /models), probed 2026-08-07. Every integer
  duration 4s-30s, 480p/720p, aspect 21:9/16:9/4:3/1:1/3:4/9:16,
  ~$0.29/s at 720p (30s ≈ $8.67). R2V accepts `audio_url`,
  `reference_audio_urls`, and `reference_video_urls`; image-reference budget
  raised to **30** on the 2.5 R2V lane (release-note ceiling 30/10/10, 50
  total — enforced harness-side). Added to `MODELS_USING_IMAGE_TAGS`,
  `MODELS_SUPPORTING_REFERENCE_IMAGES`, `MODELS_SUPPORTING_REFERENCE_AUDIO`,
  and `MAX_REFERENCE_IMAGES_BY_MODEL`.
- **Montage-first generation (this branch's default).** The planner groups
  each scene (consecutive shots sharing a `location`) into ONE single-pass
  `montage` unit up to 30s on `seedance-2-5-reference-to-video`, prompted
  with the timestamped SEQUENCE grammar from the vault's "Make a full trailer
  with Seedance 2.5" pack (`buildMontagePrompt`): SHOT header ("cut it
  yourself in the edit"), @Image identity declarations from the standard
  reference slot plan, per-beat `[0:03-0:05] …` blocks with diegetic sound,
  geography hold, one style token ending in "Face stable throughout, no
  deformation. Diegetic sound only, no music, no on-screen text.", short
  negative. New module `src/mini-drama/montage.ts` (scene grouping, beat
  layout, montage planning, post-render cutting).
- **Beat-accurate cutting into a media library.** After the render,
  `cutMontageIntoShots` slices the clip at the SAME `montageBeats`
  timestamps the prompt declared (scaled to the actual rendered duration):
  canonical `scene-001/shot-NNN.mp4` files for the assembler AND organized
  copies in `episode-N/media-library/scene-NN/` with the uncut master and a
  `manifest.json` per scene.
- **`autoEdit` toggle.** `videoDefaults.autoEdit: true` (or
  `generate-videos --auto-edit`) chains straight into `assemble-episode`
  after the cut; the default `false` (or `--no-auto-edit`) stops at the
  media library for hand editing / the Venice Video Creator.
- **Opt-outs.** `videoDefaults.montageMode: false` or
  `generate-videos --no-montage` restores the 2.0-era per-shot / 15s
  multi-shot planner (unchanged). Inserts, title cards, `mustStaySingle`,
  and exact-lip-sync shots fall through as singles automatically.
  `videoDefaults.montageModel` / `montageMaxDurationSec` override the lane.
- **Smoke tests:** `scripts/smoke-montage-plan.ts` (grouping, plan, prompt),
  `scripts/smoke-montage-cut.ts` (cutting + library layout + manifest).
- **Duration preflight** understands montage units: validates the unit total
  against the 2.5 ladder instead of per-beat windows.

## 2.15.0 — 2026-08-06

### Added

- **Capability manifest: the probe-verified registry is now a machine-readable
  export downstream clients can sync against.** New
  `src/venice/capabilities-manifest.ts` builds a versioned JSON manifest
  (`schemaVersion: 1`) carrying the full `VIDEO_MODELS` registry, the eight
  exact-id capability sets (elements, referenceImages, sceneImages, endImage,
  imageTags, audioInput, perReferenceAudio, referenceAudio), the budgets
  (per-model reference-image caps, image-model prompt caps, the 2500-char
  video prompt limit), and the routing defaults (action / atmosphere /
  character-consistency / multi-shot / lip-sync / image models). Three ways
  to consume it:
  - `venice-video capabilities` — emits the manifest on stdout.
  - `capabilities.json` at the repo root — a committed snapshot regenerated
    by `npm run manifest` (wired into `prepack`, shipped in the npm tarball),
    so clients can fetch the raw file from GitHub `main` or read it from an
    npm install. `generatedAt` is pinned while data is unchanged, so the
    snapshot only diffs when the registry actually moves.
  - Library exports: `buildCapabilitiesManifest()`,
    `renderCapabilitiesManifest()`, `CAPABILITIES_SCHEMA_VERSION`.

  The manifest is data only — prompt builders and planners still ship with
  each client. First consumer: the Venice Video Creator macOS app, which
  fetches it at launch (behind a user toggle) to keep its
  `VideoModelCapabilities` allowlists current between app releases.
  `tests/capabilities-manifest.test.mjs` guards registry coverage, set
  consistency, known-id routing defaults, deterministic rendering, and the
  CLI command's JSON shape.

### Fixed

- **`MODELS_SUPPORTING_END_IMAGE` no longer lists the Wan 2.7 i2v family.**
  The live queue rejects `end_image_url` on Wan 2.7 i2v (Uncensored/Spicy):
  "This model does not support end_image_url" — probed 2026-07-06 during the
  Venice Video Creator app sync. The `VideoModelSpec` entries already said
  `supportsEndImage: false`; the set had silently drifted from the registry.
  Caught by the app's bundled-manifest test the day the manifest went live.

## 2.14.1 — 2026-08-05

### Changed

- **README: added a human-facing "Installing the CLI" section.** Installation
  was documented only inside the agent-runner quick start; a person at a
  terminal had no plain install path. The new section covers prerequisites
  (Node 20+, ffmpeg/ffprobe), the global npm install with `setup` (interactive
  or `--api-key`/`--workspace`/`--skip-validation`) and `doctor`, the three
  bins on PATH (`venice-video`, `video-harness`, `storyboard`), the
  from-source path (clone, `npm install`, `npm run build`, `npm run dev --` /
  `node dist/mini-drama/cli.js`, `.env` for the API key), and pointers to
  `pipeline` and `shell`. Docs only.

## 2.14.0 — 2026-08-05

### Changed

- **Provider-neutral workspace: `.claude/` → `.agents/`, `CLAUDE.md` symlink
  removed.** The knowledge pack (20 command playbooks, 10 sub-agent roles,
  9 skills, hooks-config) now lives at `.agents/` — a neutral name any coding
  agent (Cursor, Claude Code, Hermes, OpenClaw, Codex, opencode) can read
  without implying a provider. Every reference was rewritten: `package.json`
  `files[]`, `src/agent/guide.ts` (the `agent-guide` text shipped inside the
  binary), source-comment cross-references, `AGENTS.md`, `README.md`, and all
  intra-pack links (`hooks-config.json`, skills, commands, agents). The
  `CLAUDE.md → AGENTS.md` symlink is gone — `AGENTS.md` is the single
  orchestration hub. Claude Code's own `settings.local.json` was untracked
  (provider-local state, now git-ignored along with any `.claude/` a specific
  runner drops in a checkout).
- **What deliberately still says `.claude`:** external tools' own read paths.
  Claude Code and Cursor consume skills from `~/.claude/skills/` /
  `<workspace>/.claude/skills/` — that is their convention, not this repo's
  layout — so the `venice-video-mcp-install-skills` docs still name those
  targets, and the optional Seedance Skill OS install still lands wherever
  the runner reads. Historical CHANGELOG entries are unchanged (they describe
  the tree as it was). No code behavior changes; docs, packaging, and the
  embedded agent-guide text only.

## 2.13.1 — 2026-08-05

### Changed

- **README: Video Model Routing catches up with the 2.13.0 multi-shot default.**
  The routing table gained a "Multi-shot units" row naming
  `seedance-2-0-enhanced-reference-to-video` as the default lane (`Lens switch.`
  separators, pure reference mode from the full slot plan) with
  `kling-o3-pro-image-to-video` demoted to an explicit
  `videoDefaults.multiShotModel` override, and the "carry these" rule 3 now
  notes the planner applies Seedance native multi-shot by default. Docs only.

## 2.13.0 — 2026-08-05

### Changed

- **Multi-shot units now default to Seedance 2.0 R2V Enhanced — the Kling i2v
  lane is an explicit override only.** `DEFAULT_MULTISHOT_MODEL` /
  `resolveMultiShotModel()` (new, `src/series/types.ts`) route every
  multi-shot generation unit to `seedance-2-0-enhanced-reference-to-video`,
  the same reference-first lane as singles. The old default,
  `kling-o3-pro-image-to-video`, has NO `elements` and NO
  `reference_image_urls` support, so every multi-shot unit silently dropped
  all identity anchoring (anti-pattern 1's underlying trap). Specifics:
  - **New `buildMultiShotPrompt()`** dispatches on the resolved model. The
    Seedance path builds ONE native multi-shot generation per rule 21:
    identity declarations from the unit's @Image slot plan up front, role
    clauses for the blocking plate and location angles, per-beat
    `Shot N (Xs):` blocks (names → `@ImageN`, authored `Blocking:` restated
    per beat, `[@ImageN, voice, delivery]: "line"` dialogue), literal
    `Lens switch.` separators, and a geometry-hold clause pinned to the plate
    (rule 49). ≤2500-char video prompt cap with aesthetic-first trimming.
  - **Pure reference mode for the whole unit:** `reference_image_urls` pushed
    in slot-plan order (union of the window's characters + the beat's plate +
    location angles), no `image_url` start frame, no `end_image_url`. The
    unit also carries voice-donor `reference_audio_urls` (@AudioN) for its
    dialogue speakers, deduped across beats within Venice's 3-clip budget.
  - **Planner:** unit type renamed `kling-multishot` → `multishot` (the old
    name still parses from existing generation-plan.json files); units carry
    the resolved model; multi-shot windows can no longer span locations
    (rule 21b — one slot plan per generation); the 15s window limit message
    no longer names Kling (both lanes cap at 15s).
  - **Override:** `videoDefaults.multiShotModel` (new) selects another lane
    explicitly — setting it to `kling-o3-pro-image-to-video` restores the
    legacy Kling 3.0 format (`buildKlingMultiShotPrompt` is retained and
    still exported). `KLING_MULTISHOT_MODEL` is deprecated but resolvable.
  - **Docs:** AGENTS.md rule 18 rewritten (Seedance default, Kling as
    override), anti-pattern 1 annotated, `venice-video-model-routing`
    (SKILL/README/decision trees) and `character-consistency` updated.
  - **Tests:** `test-spatial-consistency.mjs` now covers the dispatcher —
    default resolution, Lens-switch structure, slot plan (plate + location),
    per-beat blocking with @ImageN substitution, geometry hold, and the
    explicit Kling override path; `audio-routing.test.mjs` asserts the
    grouped unit renders on Seedance R2V.

## 2.12.0 — 2026-08-05

### Added

- **Spatial consistency is now authored data, not per-generation inference
  (rule 49).** Visual consistency was already reference-anchored, but *where*
  characters and objects sit — screen side, depth, facing, position relative to
  the set — was re-inferred by the model on every generation, which is where
  side-swaps, teleporting props, and mirrored geography came from
  (anti-pattern 28). Two new fields carry the geometry through the whole
  pipeline:
  - **`Location.spatialAnchors`** — the locked geography of a place: 3-5 named
    landmarks and their fixed relative positions. Baked into the location's
    reference angles at generation time, injected as
    `Fixed layout (never rearrange): …` into every panel and video prompt for
    shots tagged with the location, and sticky on merge (an existing anchor
    set is never overwritten by a later script part). `add-location` takes
    `--spatial-anchors`.
  - **`ShotScript.blocking`** — the shot's authored geometry: 1-2 sentences
    placing each character/object relative to the named anchors, the frame
    (screen left/right, foreground/background), and their facing/eyeline.
    Injected verbatim (with `@ImageN`/`@ElementN` name substitution) into the
    panel prompt (`BLOCKING: …`), the video prompt (`Blocking: …`), and the
    Kling multi-shot per-shot blocks; it also seeds the beat's storyboard
    blocking-plate description. `insert-shot` inherits the anchor shot's
    location and blocking for same-scene splices and takes `--location` /
    `--blocking` overrides.
- **The script LLM is now required to author the geometry.** Both workshop
  system prompts (`workshop` in `workshop.ts` and `workshop-script` in
  `cli.ts`) demand `spatialAnchors` per location and `blocking` per character
  shot, with continuity rules: characters keep their screen sides and relative
  positions across consecutive shots unless a movement is written into the
  action, screen direction and eyelines obey the 180-degree rule, and blocking
  always references the location's named anchors. `workshop-script` warns when
  character shots are missing `blocking` or locations are missing
  `spatialAnchors` (post-condition advisory, same pattern as the duration and
  no-music checks).
- **`qa-storyboard` reads geometry.** A fourth SPATIAL CONTINUITY dimension
  checks each panel against the shot's stated blocking and the location's
  landmarks, and the command now attaches the nearest prior panel from the
  same location so side-swaps, mirrored geography, and moved landmarks are
  caught against real coverage instead of prose alone. A spatial flip that
  breaks the scene is FLAG-CRITICAL; a wrong frame side or relocated landmark
  is FLAG-MODERATE.
- **Stronger geometry clauses in video prompts.** The blocking-plate clause now
  explicitly forbids mirroring/swapping ("each character stays on the same
  side of the scene… do not mirror, swap, or rearrange who stands where"), and
  plateless location shots get a geography-hold clause pinned to the location's
  first `@ImageN` slot. Blocking plates themselves are prompted for legible
  placement (screen side, distance, facing, landmark relations readable in one
  look) and carry the location's fixed layout.
- **Docs and knowledge pack updated together:** AGENTS.md rule 49 +
  anti-pattern 28, README "carry these" rule 8, `agent-guide` (binary +
  `venice-agent-guide` skill), `shot-composition` (spatial blocking rules),
  `character-consistency` (Layer 5: spatial anchoring),
  `venice-video-model-routing` (blocking/fixed-layout prompt lines),
  `prompt-engineer` ([BLOCKING] template section), `storyboard-qa`, and the
  `qa-storyboard` / `workshop-episode` playbooks.
- **Tests:** `tests/test-spatial-consistency.mjs` covers blocking injection in
  panel/video/multi-shot prompts, `@ImageN` substitution inside blocking,
  fixed-layout injection, the no-mirroring and geography-hold clauses, plate
  descriptions inheriting blocking, and the workshop prompt contract.

## 2.11.2 — 2026-08-05

### Changed

- **README: added `HERMES-AGENT-SETUP.md` and trimmed the ACP explainer.** A
  paste-ready re-setup prompt for Hermes users on an old global install (which
  shipped only the compiled CLI — no `AGENTS.md`, skills, or MCP) is now linked
  from the Hermes/OpenClaw quick start. Removed the "ACP does not run the
  harness" section — it was conceptual myth-busting, not setup or operating
  guidance — and reworded the "separate runtime" section to stand on its own.
  The operational runtime/long-render guidance is unchanged. Docs only.

## 2.11.1 — 2026-08-05

### Changed

- **README agent instructions rewritten around the published packages.** With
  both `venice-video-harness` and `venice-video-mcp` on npm, the Hermes/OpenClaw
  path is now a plain global install rather than a two-repo clone with
  hand-written absolute paths. Added a "Quick start for Hermes and OpenClaw"
  block, rewrote "Registering the MCP server" to lead with the published
  `venice-video-mcp` bin (and an `npx -y venice-video-mcp` variant) while keeping
  the clone + `HARNESS_BIN`/`HARNESS_PATH` path as a documented dev alternative,
  and switched the companion-skills step to the on-PATH
  `venice-video-mcp-install-skills` bin. Clarified that with both packages
  installed globally you set none of the harness path variables — the MCP finds
  `venice-video` on `PATH`. Softened the stale "npm latest trails this repo"
  version-drift note. Docs only; no code change.

## 2.11.0 — 2026-08-05

### Added

- **The CLI now describes itself, so the operating knowledge travels inside the
  binary instead of only in a checkout.** A knowledge pack that lives in a file
  array can be left out of a tarball or unreachable to a runner that never
  clones; a command cannot. Three new commands:
  - `venice-video agent-guide [--json]` — the ~80/20 core rules (find the next
    step, queue-time billing and re-attach, long renders needing background
    invocation, the human gates, consistency-first generation). Sourced from
    `AGENTS.md`, kept in `src/agent/guide.ts`.
  - `venice-video pipeline [--json]` — the ordered stages, the artifact each
    produces, the two human gates, and the literal command that advances each.
    Mirrors the on-disk state machine in `src/session/status.ts`.
  - The same core rules are also installable as a skill
    (`.claude/skills/venice-agent-guide/`), so a runner that pulls skills from
    GitHub (for example `hermes skills install
    jordanurbs/venice-video-harness/venice-agent-guide`) gets them without a
    clone or an npm publish.

- **`--json` on the agent-facing read commands** — `status`, `doctor`, `queue`,
  `pipeline`, and `agent-guide`, plus a global `--json`. Output is exactly one
  JSON object on stdout; the human text rendering is unchanged. An agent no
  longer has to scrape prose whose wording can shift.

### Changed

- **Honest exit codes.** `venice-video status` with no project selected now exits
  non-zero instead of printing a note and exiting 0 — an agent checking `$?` was
  seeing success on an error.

- **Ordinary failures are a clean `error:` line, not a Node stack trace.** A usage
  error in a non-TTY used to surface as an uncaught exception with a
  `Node.js v22.x` footer that reads as a crash. The top-level handler now prints
  the message and exits 1; set `VENICE_VIDEO_DEBUG=1` for the stack.

- **Gate errors state the condition and the command that clears it, and no longer
  present `--skip-approval` / `--skip-qa` as a "Bypass".** The skip flags bypass
  the check without making the underlying approval true, so they are not the fix
  for an agent — the error now says so.

- **The MCP server's harness resolution order was reversed so intent wins.**
  `venice-video-mcp` now resolves `HARNESS_BIN`, then `HARNESS_PATH/dist`, then a
  `venice-video` on `PATH` (previously `PATH` outranked `HARNESS_PATH`). Setting
  `HARNESS_PATH` is an explicit statement of intent and must beat an ambient,
  often-stale global install. Resolution is also logged once to stderr
  (`[venice-video-mcp] harness: …`) so it can never again pick the wrong binary
  silently. See `venice-video-mcp` 0.4.0.

- **`install-skills` grew `--target hermes` and `--dir <path>`** so the companion
  skills can be installed into a runner's own skills directory
  (`~/.hermes/skills/venice/`) rather than only a Claude-shaped `.claude/skills/`.
  `--target openclaw` errors honestly — its skills path is not verified on any
  machine yet — and points at `--dir`.

## 2.10.0 — 2026-08-05

### Added

- **The agent operating contract now ships in the published package.** `AGENTS.md`
  (47 agent rules, 20 production anti-patterns), `.claude/commands/`,
  `.claude/agents/` and `.claude/skills/` are in the `files` array. Until now the
  package published only `dist` and the README, so an agent driving a global
  install — Hermes Agent and OpenClaw both do — had the compiled CLI and nothing
  that explains it: no pipeline order, no gate map, no model-routing rules, no
  anti-patterns. It saw `--help`, a flat list of 40-plus commands, and guessed.
  That was the largest single cause of poor agent-driven output, and it was a
  knowledge gap rather than a missing capability. Verify with
  `ls "$(npm root -g)/venice-video-harness/AGENTS.md"`. `.cursor/rules/` stays
  repo-only, being IDE configuration rather than operating knowledge.

- **README > "Driving this from an agent"** — explicit instructions for a coding
  agent operating the harness. Covers the three integration surfaces and what
  each one gives the agent, MCP registration with the companion skills, the
  version-drift preflight, the cwd/workspace trap, the two pipeline gates and why
  not to route around them with `--skip-approval` / `--skip-qa`, queue-time
  billing and re-attach instead of blind retry, the output-parsing sharp edges
  (no `--json`, `status` exiting 0 on "No project selected", usage errors
  arriving as Node stack traces), a complete non-interactive run, and the twelve
  rules with the most effect on output quality.

- **Two sections on where the harness actually runs**, replacing a single
  too-narrow note about ACP. ACP (Agent Client Protocol) connects an *editor* to
  an *agent* over stdio, with the editor supplying the working directory — it
  neither runs the harness nor provisions a runtime, so the harness has no
  position in an ACP conversation and MCP remains the tool-side protocol.
  Provisioning a separate runtime for long renders is a genuinely good fit but is
  a different mechanism (in Hermes, `terminal.backend`: local / docker / ssh /
  modal / daytona / singularity), and it has four prerequisites the default
  images do not meet: `venice-video`, `ffmpeg` and `ffprobe` in the image, the API
  key passed through, a persistent workspace volume, and a retrieval step home.
  **The trap worth knowing:** `pending-jobs.json` lives in the per-machine config
  directory, so on an ephemeral container the record that makes an interrupted
  render re-attachable dies with the container and an already-billed render
  becomes unrecoverable — mount the config dir, or keep generation on a
  persistent backend.

- **Documented the harness-resolution order the MCP server uses, because it has a
  silent failure mode.** The server tries `HARNESS_BIN`, then `venice-video` on
  `PATH`, then `HARNESS_PATH/dist/mini-drama/cli.js` — so a global install
  outranks `HARNESS_PATH`, and a config setting only `HARNESS_PATH` on a machine
  with a global `venice-video` drives the **global** copy. Since npm `latest`
  trails this repo, that silently runs an older binary: newer flags fail and fixed
  bugs reappear while everything looks configured correctly. Verified by
  handshaking the server both ways and reading back the `command` field in the
  response, which names the binary that answered. The README now says to set
  `HARNESS_BIN` and how to confirm which copy is live.

- **Guidance on long-render invocation.** `generate-videos`, `assemble-episode`,
  `produce-episode`, `finish` and `upscale` run 3–10 minutes, while a typical
  agent terminal tool defaults to a 180-second timeout and caps a foreground
  command at 600s (Hermes's numbers). A foreground render is killed partway
  through, and because Venice bills at queue time it is already paid for. These
  stages must be invoked as background commands with completion notification, and
  a killed render is recovered by re-running the identical command rather than
  starting over.

## 2.9.0 — 2026-08-05

### Added

- **`venice-video update`** (alias `upgrade`) installs the latest published
  release, so upgrading is no longer a remembered npm incantation. `--check`
  reports what is available and installs nothing, `--dry-run` prints the exact
  npm command first, `--tag` follows a dist-tag other than `latest`, and a build
  ahead of the tag is reported rather than downgraded unless `--force` is given.
  The install targets the prefix the running copy lives in rather than the `npm`
  first on `PATH`: a version manager can leave those pointing at different
  prefixes, and then `npm install -g` reports success while the executable that
  actually runs stays on the old version. The new version is read back off disk
  afterwards, and a mismatch says to check `command -v venice-video`. A copy
  inside a project's `node_modules` or a git checkout is not installed over —
  each prints the command that does own it.

- **The intelligence model is now a project setting.** The workshop, the shot
  script and storyboard QA are the three steps that reason rather than render,
  and the model behind them is chosen when the project is created: **Kimi K3**
  (default), GLM 5.2 or Grok 4.5 on the **private** tier, where the prompt stays
  on Venice infrastructure; Fable 5, Opus 5, GPT 5.6 Sol or Qwen 3.8 Max on the
  **anonymized** tier, where it is routed to an external provider with
  identifying metadata stripped. The wizard asks, `--intelligence` states it
  upfront, `series.new` takes `intelligenceModel`, and `--model` still overrides
  a single run. Existing projects have no stored choice and fall back to the
  default. Previously the pipeline was hardwired to `llama-3.3-70b`, which
  neither reasons nor reads images.
- A text-only choice is paired with a vision-capable companion **from the same
  privacy tier** — GLM 5.2 borrows Grok 4.5 for QA, never an anonymized model.
  Sending a private project's panels to a weaker tier to work around a missing
  capability would break the promise the operator made when they picked private.
  The pairing is shown in the wizard and as a pill on the treatment page.

### Fixed

- **`qa-storyboard` could not have worked for any user.** Its default model,
  `qwen-2.5-vl`, was sunset from the Venice catalog and returns
  `Specified model not found`. Every panel hit the error path, was recorded as
  `FLAG-LOW` "Vision API error", and the run then reported "No critical issues"
  and suggested `qa-approve` — green-lighting a storyboard where nothing had
  been checked. The default now comes from the project's intelligence model, and
  shots whose vision call failed are counted separately as unchecked and
  suppress the approval suggestion.
- Venice error messages are no longer discarded. The client read only
  `error.message`, but the API also returns `{error: "..."}` for routing
  failures and `{issues: [{message}]}` for validation, so the two most useful
  messages — `Did you mean: …` on an unknown model, and `Image content is not
  supported by this model` — were being replaced with a bare
  `Venice API returned HTTP 400`.
- Structured-output requests now retry once with the parse error quoted back to
  the model. GLM 5.2 drops a closing brace roughly one attempt in three, which
  previously failed the whole command; it now completes reliably. Fence
  stripping also tolerates a model that narrates before its JSON.
- Vision requests were capped at 2000 `max_tokens`, which a reasoning model can
  spend entirely on thinking and return empty content. Raised to 4000, and an
  empty reply now says which of the two causes it was.
- An explicit `--model` on `qa-storyboard` is used verbatim rather than being
  silently swapped for a known vision model.

## 2.8.0 — 2026-08-05

### Added

- **The treatment page tracks the run.** `WORKSHOP.html` is re-rendered by every
  command that produces an artifact, so the tab you already have open is one
  reload away from current. It gains a Production progress card (stage, panel /
  clip / dialogue counts, and the next command) and an Output column on the shot
  script showing each shot's panel — replaced by the clip's poster frame once it
  renders — with badges for panel, clip, voiceover and QA verdict. Hover a
  flagged verdict to read the issue. `WORKSHOP.md` carries the same progress
  summary.
- Thumbnail encoding is cached against each file's mtime in
  `.treatment-thumbs.json`, so a refresh re-encodes only what changed (~10ms for
  an unchanged episode, versus ~280ms cold).

### Fixed

- **`storyboard-episode` suggested `/qa-storyboard`, which cannot be run.** A
  leading `/` is reserved for the shell's meta-commands, and the suggestion also
  omitted `-p` and `-e`. Every suggested next step is now a complete, runnable
  command line. The same applied to the `generate-videos` QA-gate error and the
  `storyboard-episode` approval error, which printed `<project>` placeholders.
- **`status` told workshop-driven projects to re-approve a script they had
  already shot.** `storyboard-episode` accepts either `script-approved.json` or
  `script.status === 'approved'`, but the status reporter checked only the file
  — and `workshop --approve` sets only the status. It now mirrors the real gate.
- A shot whose dialogue object carries an empty line rendered as empty quotes in
  the shot script; it now reads as no dialogue.

## 2.7.0 — 2026-08-05

### Added

- **Wan 3.0** as a selectable video family. It is the only family that renders
  past 15s — the ladder runs 5/10/15/20/25/30s at 480p, 720p, and 1080p, with
  native audio always on and a 9-image reference stack on the R2V lane. It
  accepts no audio input, so projects on Wan 3.0 fall back to Wan 2.7 for exact
  lip-sync.
- Creative references are now shown on the workshop page. Image and video
  references render as an inline gallery in `WORKSHOP.html` (downscaled WebP
  thumbnails embedded as data URIs, so the file stays self-contained; video
  posters come from a frame at 0.5s), and image references become markdown
  embeds in `WORKSHOP.md`. Anything that can't be decoded still lists as a path.
- Setup and workshop questions announce that they are skippable, and each
  optional prompt now shows `[Enter to skip]`.

### Changed

- **Exact lip-sync is family-aware instead of always Wan 2.7.** Seedance 2.x
  and MiniMax H3 both accept a top-level `audio_url` on their R2V lanes, so a
  project on either family now lip-syncs in-family, keeping its full reference
  stack. Only families with no audio-driven lane route out to Wan 2.7.
- The Seedance keyframe pre-pass (rule 32) now runs only for lip-sync models
  that take no reference images. An in-family R2V lip-sync render is one
  generation instead of two, roughly halving the per-shot cost.
- `mustStayAsWanLipSync` is renamed `mustRenderAsExactLipSync`; the old name
  remains as a deprecated alias.
- Wizard, flag, and prompt copy no longer names a specific lip-sync model where
  the model depends on the project's family.

## 2.6.0 — 2026-07-31

### Added

- `venice-video shell` — a persistent interactive session. Commands run without
  a process restart, so the Venice client's rate-limit pacing and caches stay
  warm across a whole production instead of resetting on every invocation.
- A selected project and part. `use <project> [part]` makes `-p` and `-e`
  optional on every command; `unuse` clears it. The selection is stored in user
  config, so it applies to one-shot commands and survives restarts.
- Background commands: suffix any command with `&`, then `/jobs`,
  `/jobs log <id>`, and `/jobs cancel <id>`. Output from a backgrounded render is
  captured to its own buffer rather than sprayed over the prompt.
- `venice-video status` — reports where a project sits in the pipeline and which
  command to run next.
- `venice-video queue` — lists Venice renders left in flight, with `prune` and
  `clear` subcommands.
- Shell conveniences: tab completion for commands, flags, and project slugs; a
  persistent history file; a context-aware prompt; `!<cmd>` passthrough to the
  system shell.

### Fixed

- **Interrupted renders no longer orphan paid work.** Each Venice `queue_id` is
  now recorded to disk *before* polling starts. Re-running a command re-attaches
  to the pending job instead of submitting and billing a second render. Previously
  a Ctrl-C, crash, or dropped connection lost the id while Venice kept charging.
- `Ctrl-C` now cancels the in-flight operation through an `AbortSignal` threaded
  into every Venice request, poll loop, and retry backoff, rather than only
  killing the process between requests.
- Video polling gained an overall timeout and a consecutive-error ceiling, so a
  wedged render fails instead of hanging indefinitely.
- Tests no longer inherit an ambient `VENICE_VIDEO_WORKSPACE`, which could
  silently redirect the projects they create.

## 2.5.3 — 2026-07-31

- Workshop generation now writes a formatted, self-contained `WORKSHOP.html` alongside JSON and Markdown.
- The HTML presents story, inputs, structure, visual language, cast, locations, production plan, references, open questions, and the shot script in a browser-friendly layout.
- The CLI opens `WORKSHOP.html` automatically in the default browser after generation/revision when running interactively; failure to open never fails the workshop.
- Workshop status now lists the HTML path, and all rendered content is HTML-escaped.

## 2.5.2 — 2026-07-31

- The Creative references prompt now says to drag a file or directory into the terminal.
- Dragged quoted paths, escaped spaces, and `~` paths are normalized automatically.
- Reference directories are recursively inventoried (up to 100 files); supported text references are read into workshop context, while image/video/audio paths and metadata are preserved for planning.
- Leaving references or other optional creative fields blank explicitly tells the workshop to propose strong answers from the project concept instead of treating them as missing requirements.

## 2.5.1 — 2026-07-31

- Replaced the vague “What should the finished project accomplish?” workshop prompt with concrete, project-specific audience-outcome questions.
- Film asks what the audience should feel, understand, or keep thinking about when it ends.
- Product video asks what viewers should understand, believe, and do next; music video, screenplay adaptation, and series receive similarly specific questions.
- Added examples directly in the interactive prompt and renamed the noninteractive flag to `--outcome` while retaining `--objective` as a deprecated alias.

## 2.5.0 — 2026-07-31

- Integrated the Topaz 2x/4x video-upscale engine into the standalone CLI.
- Added Standard vs 4K delivery selection to the complete project workshop.
- Added `venice-video finish`, which finds the assembled project master, estimates cost, requires confirmation, and writes a preserved 4K delivery master under `masters/`.
- Added advanced `venice-video upscale` for arbitrary finished video files.
- Large masters are split into upload-safe chunks, processed concurrently and resumably, concatenated without another video encode, and remuxed with the original audio.
- Registered `topaz-video-upscale` in the model catalog and added finishing/delivery regression tests.

## 2.4.4 — 2026-07-31

- Added `venice-video workshop` as the project-level creative control center.
- The workshop develops objective, audience, runtime, logline, synopsis, themes, structure, aesthetic, cast, voices, locations, audio approach, production risks, open questions, and the complete shot script in one coherent process.
- Added structured revision feedback, status inspection, readable `WORKSHOP.md`, and explicit approval that materializes production state.
- Replaced unclear manual command-chain handoffs after `new` and `new-script` with the guided workshop.
- Kept low-level commands as advanced controls rather than the default onboarding experience.

## 2.4.3 — 2026-07-31

- Film projects now use Film/Part terminology in script scaffolding and workshop output instead of Episode language.
- Added `new-script` and `workshop-script` commands while preserving `new-episode` and `workshop-episode` compatibility aliases.
- Film script prompts no longer force 60-second episode timing, one-location structure, cliffhangers, or mandatory episodic title cards.
- Film script templates default to five minutes when no requested duration exists; concepts can request any target duration.

## 2.4.2 — 2026-07-31

- Native dialogue now remains on the selected R2V family and uses Seedance/HappyHorse voice-donor references when available.
- Wan 2.7 routing now requires the explicit Exact lip-sync strategy.
- Reworded the audio wizard to distinguish native voice-reference generation from exact audio-driven mouth movement.
- Reordered model families to Automatic, Seedance, MiniMax H3, HappyHorse, Grok Imagine, Kling O3.

## 2.4.1 — 2026-07-31

- Added an install-time diagnostic that warns when npm's global executable directory is missing from `PATH` and prints the exact shell command to fix it.
- Added README troubleshooting for successful global installs where `venice-video` is not found.

## 2.4.0 — 2026-07-31

First standalone CLI release.

### Added

- Global `venice-video` command that runs without Cursor, Claude Code, OpenCode, MCP, or another agent host.
- `venice-video setup` for validated API-key and workspace configuration.
- `venice-video doctor` plus configuration inspection and cleanup commands.
- Film-first `venice-video new` wizard. Film projects may be any length.
- Explicit project workspaces instead of relying on the current directory.
- Resumable episode production with a standalone vision-QA approval gate.
- Importable TypeScript package surface for the Venice client, model registry, video generation, and series management.
- Packed-artifact tests covering setup, key masking, private file permissions, and Film creation.

### Changed

- Video retrieval now uses the configured Venice client instead of reading the environment directly.
- Sharp updated to 0.35.3 to resolve inherited 2026 libvips vulnerabilities.
- npm artifacts are restricted to compiled output, documentation, and the license.

### Compatibility

- Existing `video-harness` and `storyboard` executable aliases remain available.
- Repository `.env` and `VENICE_API_KEY` workflows remain supported.
- Agent orchestration files remain in the repository but are not included in the npm package.
