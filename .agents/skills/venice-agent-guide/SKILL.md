# Venice Video Harness — Agent Operating Guide

## Description
The core rules for driving the `venice-video` CLI from a coding agent (Hermes,
OpenClaw, Cursor, Claude Code, and others). This is the ~80/20 subset of
`AGENTS.md` — the rules whose absence loses money or produces unusable output.
It mirrors `venice-video agent-guide` (the same text ships inside the binary) and
the full rules live in `AGENTS.md`. Read this before running any workflow.

Keep this in sync with `src/agent/guide.ts`; if a rule changes in one, change it
in the other.

## Find the next step, do not guess
- `venice-video pipeline --json` lists the ordered stages, their gates, and the command that advances each.
- `venice-video status -p <project> --json` reports where a project stands and the exact next command.
- Always pass `-p <project>` (and `-e <episode>`) explicitly. Do not rely on a selection a human may have set — a daemon- or GUI-launched agent has an arbitrary working directory, so also set `HARNESS_WORKSPACE` to a fixed directory.

## Money is spent at queue time
- Venice bills when a render is **queued**, not when it downloads. A lost queue id is money already spent.
- Every queued render is recorded to `pending-jobs.json` before the first poll. If a command is interrupted, re-run the **same command with the same output path** — that re-attaches to the paid job instead of paying again.
- A killed render (for example a command timeout) is usually still running and billed. Do **not** treat a timeout as a failed render and retry it. Re-attach.
- Inspect in-flight work with `venice-video queue --json`. Only `queue clear` a record you know is dead.

## Long renders need background invocation
- `generate-videos`, `assemble-episode`, `produce-episode`, `finish`, and `upscale` run 3–10 minutes.
- Runners cap foreground commands (Hermes defaults to 180s, hard-caps at 600s). Run these in the background with a completion notification, not in the foreground.
- A foreground timeout kills the process but not the Venice job — see the billing rule above.

## Gates are human decisions
- `approve-script` and `qa-approve` are explicit human sign-offs, not steps an agent clears on its own.
- `--skip-approval` and `--skip-qa` do not make the script approved or QA cleared; they only bypass the check. They are **not** the fix. Ask the human to approve.

## Consistency-first generation
- Prefer 15s shots. Two 15s shots beat five 6s shots on identity stability, motion completion, continuity, and cost.
- Front-load style at the START of every prompt; keep Seedance prompts under ~60 words with the 5-part structure (Subject, Action, Camera, Style, Constraints).
- Direct the beat, do not decorate it: name one intention and derive camera/light/blocking/performance from it. Do not stack "cinematic / epic / 4k" adjectives.
- Re-anchor every separately-rendered shot to the SAME locked references and restate the character invariant traits (including relative size) in every prompt.
- State placement explicitly in every prompt: lock each location's landmark geography (`spatialAnchors`) and give every character shot a `blocking` field (position vs named anchors, screen side, depth, facing/eyeline). Keep screen sides and eyelines constant across a scene unless a movement is scripted.
- Prefer native model dialogue (Seedance 2.0, HappyHorse 1.1 with voice-donor references) over exact TTS lip-sync.

## Modes of operation — the linear pipeline is not the only path
- Default path: the gated pipeline (`venice-video pipeline`) — aesthetic → cast → episode → script → approve → storyboard → QA → render → assemble. Use it for a finished, identity-locked cut.
- Loop mode (`venice-video loop -p <project> -e <n> --mode <looping|production>`): once a shot script exists, render the whole plan continuously and watch it as a live browser loop that hot-swaps fresh takes. It SKIPS the storyboard/QA gates and writes only under `episodes/episode-NNN/loop/`, so it never touches the canonical cut. `looping` = creative flow, lower quality (Turbo 480P, disposable); `production` = gather usable, identity-locked takes (Max R2V @768P). `--mode` is REQUIRED non-interactively; `--budget` caps spend (default $2). This is NOT in the `pipeline` stage list — it is under `branches` in `pipeline --json`.
- **Loop mode plays AND renders at the same time — it does NOT pre-generate everything.** The browser loops the takes that already exist while the worker keeps generating new ones, swapping each shot's newer take in on the loop's **next pass** (never mid-clip). Two things make a running loop *look* pre-generated when it isn't: (a) it **pauses** when it hits `--budget` or you click Pause, then just replays what's on disk — raise `--budget` or pass `--unbounded` to keep it generating; (b) `--max-takes` is a per-shot ring buffer (default 3, older takes pruned), not a total.
- **Which mode evolves while you watch:** `looping` (Turbo, 480P) renders faster than it plays, so it visibly changes as you watch. `production`/create renders each shot slowly on Max R2V — it's for **gathering keeper takes**, not a continuously-evolving watch, and on a short/few-shot plan it can look static even while running (one take takes longer to render than a full loop cycle takes to play). Want "watch it keep changing"? Use `looping` with a higher/unbounded budget.
- **Stream mode** (`venice-video stream -p <project> -e <n> --writer <model> [--direction "..."]`): an INFINITE, live-authored story — not a loop. The writer model authors one beat at a time; beat 1 renders t2v, every later beat i2v off the previous last frame. Needs only `series.json`. Two things to do before starting: (1) **ASK the operator which model writes the beats** — it is the voice of the whole story and bills from beat 1; a non-interactive new stream with no `--writer` is a hard error (`--writer default` uses the project intelligence model). (2) If the show has human faces, put the camera rule in `--direction`: end every beat wide, never on a face close-up (MiniMax i2v dies on a face-filled start frame; the engine also enforces this in the writer prompt and falls back to a t2v soft reset after 2 chained failures). The command registers its episode in `series.json` so the Stream tab can show it.
- Three video lanes, chosen per shot by the router (see the `venice-video-model-routing` skill): **t2v** (prompt only), **i2v** (animate a supplied START image via `image_url` — establishing/atmosphere shots, or chaining off a previous last frame), **R2V** (identity anchored to a reference stack — the default for character shots). "i2v" means a supplied first frame; "R2V" means `reference_image_urls`, not a start frame — do not conflate them.
- To animate a single image you already have (plain i2v, no project), the routing skill's bundled `scripts/venice-video.py --image <file> --model <...-image-to-video>` is the standalone path; the project pipeline is for multi-shot, consistency-first work.

## Where the full knowledge lives
- `AGENTS.md` — 49 rules and 28 production anti-patterns, shipped in the package.
- `.agents/skills/` — `venice-api`, `venice-video-model-routing`, `character-consistency`, `shot-composition`, `burn-in-subtitles`, `video-editing`, and more.
- `.agents/commands/` — 20 step-by-step playbooks; `.agents/agents/` — 10 sub-agent roles.
- Read the relevant playbook before running a workflow. Validate model capabilities against `src/venice/models.ts` before an API call.
