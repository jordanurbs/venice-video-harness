# Venice Video Harness

A standalone, Venice-optimized CLI for **consistency-first video creation** at any length.

Install it, enter a Venice API key, and create films directly from the terminal. No coding agent, IDE extension, or MCP host is required. The same repository also includes optional orchestration material for agent-driven workflows.

> **If you are an AI agent driving this CLI, read [Driving this from an agent](#driving-this-from-an-agent) before running any command.** The pipeline is gated and the commands are order-dependent; `--help` alone is not enough to operate it, and several stages spend money at queue time.

Use it for:

- **Character-consistent video projects** (any genre, any length)
- **Visual-style-locked series or campaigns**
- **Storyboard-to-video workflows**
- **Short-form and long-form narrative content** (mini-dramas, documentaries, explainers)
- **Branded cinematic sequences, trailers, and teasers**
- **Recurring-character social series**
- **Any multi-shot Venice workflow where continuity matters**
- **Text-first editing of existing footage** — transcribe sources with local whisper.cpp, read the 12KB pack, propose a cut, render with 30ms audio fades, then self-eval at every cut boundary. Inspired by [browser-use/video-use](https://github.com/browser-use/video-use).

## What This Is

Most Venice integrations are thin wrappers around API calls. This package is the higher-level production layer:

- **Standalone `venice-video` CLI** with setup, diagnostics, self-update, project creation, generation, QA, assembly, and export commands
- **Direct Venice API client** with retries, rate limiting, deprecation warnings, and async media polling
- **Persistent project state** for characters, locations, episodes, references, recipes, and provenance
- **Comprehensive model registry** covering Venice video, image, audio, and music models
- **Optional agent orchestration** in `AGENTS.md` and `.agents/` for users who want natural-language operation

## Installing the CLI

For a human at a terminal. (Driving it from an agent instead? See the next section.)

**Prerequisites:** Node 20+, and `ffmpeg` + `ffprobe` on PATH (used for video/audio processing; `venice-video doctor` checks all three).

### Global install (recommended)

```bash
npm install -g venice-video-harness

venice-video setup     # prompts for your Venice API key + default project workspace
venice-video doctor    # verifies API key, ffmpeg, ffprobe
```

`setup` prompts interactively (the API key prompt is hidden); for non-interactive use pass `--api-key <key>` and `--workspace <dir>`, or set `VENICE_API_KEY` in the environment. `--skip-validation` stores the key without contacting Venice.

The install puts three commands on PATH:

- `venice-video` — the primary CLI
- `video-harness` — alias for the same CLI
- `storyboard` — the legacy screenplay-ingestion CLI

From there:

```bash
venice-video pipeline   # the ordered stages, their gates, and the command that advances each
venice-video shell      # persistent interactive session: select a project once, background renders, /jobs
venice-video --help     # everything else
```

### From source (development)

```bash
git clone https://github.com/jordanurbs/venice-video-harness.git
cd venice-video-harness
npm install
npm run build

# Run via tsx during development, or the compiled CLI:
npm run dev -- pipeline
node dist/mini-drama/cli.js pipeline
```

Put the API key in `.env` at the repo root (`VENICE_API_KEY=...`) — many scripts source it from there — or run `setup` as above.

## Driving this from an agent

Instructions for a coding agent operating the harness — Claude Code, Cursor,
Hermes Agent, OpenClaw, OpenCode, Codex, or anything else with a shell tool.
Read this section in full before the first command.

### Pick your surface, and know what it gives you

Three surfaces exist. They differ in how much of the harness's operating
knowledge reaches you, which is the single largest predictor of output quality.

| Surface | How it runs | What you get | Use when |
|---|---|---|---|
| **Repo-resident agent** | Agent's cwd is a clone of this repo | Everything: `AGENTS.md` (55 rules, 31 anti-patterns), `.agents/commands/`, `.agents/agents/`, `.agents/skills/`, `.cursor/rules/` | Authoring and iteration — the best results by a wide margin |
| **MCP** | `venice-video-mcp` (on npm) shells out to this CLI | 7 action-discriminated tools, structured JSON responses, progress notifications, plus 4 companion skills carrying the pipeline order | Any agent that supports MCP — Hermes, OpenClaw, Cursor, Claude — with no clone required |
| **Bare global CLI** | `npm install -g`, shell tool, `--help` | The compiled CLI, this README, `AGENTS.md`, `.agents/skills/`, and the self-describing commands below (`agent-guide`, `pipeline`) | When your runner has a shell but no MCP — start with `venice-video agent-guide` |

### Quick start for Hermes and OpenClaw (no clone, no absolute paths)

Both packages are on npm, so an agent whose entire environment is a global
install and a chat box has a complete, knowledge-bearing setup. Nothing here
requires cloning a repo or hand-writing a path.

> **Tried the harness or MCP before and got poor results?** Earlier global
> installs shipped only the compiled CLI — no `AGENTS.md`, no skills, no MCP on
> npm — so the agent was guessing from `--help`. That is fixed now.
> [`HERMES-AGENT-SETUP.md`](HERMES-AGENT-SETUP.md) is a paste-ready prompt that
> upgrades a stale global, registers the MCP, installs the Hermes skills, and
> points the agent at the operating rules — run it once and re-set-up cleanly.

```bash
# 1. Install both globally. The harness ships AGENTS.md + .agents/skills/;
#    the MCP ships its 7 tools and 4 companion skills.
npm install -g venice-video-harness venice-video-mcp --foreground-scripts

# 2. Point the harness at a workspace and confirm the environment.
export VENICE_API_KEY=vn_...
export VENICE_VIDEO_WORKSPACE=~/VeniceVideos
venice-video doctor          # checks API key, ffmpeg, ffprobe
venice-video agent-guide     # the core operating rules, inside the binary

# 3a. Hermes — register the MCP by its published bin (it is on PATH now):
hermes mcp add venice-video --command venice-video-mcp
hermes mcp test venice-video # confirm the handshake
venice-video-mcp-install-skills --target hermes   # skills → ~/.hermes/skills/venice/

# 3b. OpenClaw / any MCP runner — same idea, using whatever the runner's
#     "add MCP server" command is, with command `venice-video-mcp` and the
#     env below. Install its skills into the runner's skills dir:
venice-video-mcp-install-skills --dir <that runner's skills dir>
```

When both are installed globally, the MCP finds `venice-video` on your `PATH`
automatically — you do **not** need `HARNESS_BIN` or `HARNESS_PATH`. The only
required env for the MCP process is `VENICE_API_KEY`, plus `VENICE_VIDEO_WORKSPACE`
(or `HARNESS_WORKSPACE`) if you want projects somewhere other than the cwd. See
[Registering the MCP server](#registering-the-mcp-server) for the details and the
one case where you *do* set a path (pointing at a local build).

OpenClaw's exact MCP-registration and skills-directory conventions are not yet
verified here; the shapes above are what to adapt. `venice-video-mcp-install-skills
--target openclaw` currently errors on purpose rather than guessing a path — pass
`--dir` once you know it.

**The bare-CLI trap, and how to check whether you are in it.** Through version
**2.9.0** the npm package published only `dist`, `README.md`, `CHANGELOG.md`,
`LICENSE`, and `scripts/postinstall.mjs`. `AGENTS.md` and `.agents/` were left
out, so an agent working from a global install of those versions had no access to
the anti-patterns, the model-routing rules, or the pipeline playbooks. It saw a
flat list of 40-plus commands with no ordering information and no indication of
which stages were gated. That is the most common reason agent-driven runs produce
poor output, and it is a knowledge problem rather than a capability problem.

From **2.10.0** onward the package ships `AGENTS.md` plus the knowledge pack
(`commands/`, `agents/`, `skills/` — under `.claude/` through 2.13.x, under the
provider-neutral `.agents/` from 2.14.0). Check what your install actually has:

```bash
ls "$(npm root -g)/venice-video-harness/AGENTS.md"
```

If that file is present, read its "Agent Rules" and "Learned Anti-Patterns"
sections before generating anything. If it is missing, you are on an older
package and must do one of the following first:

1. **Upgrade**, then read the shipped `AGENTS.md`.
2. **Register the MCP server** (see below). It carries the pipeline order in its
   companion skills and returns JSON instead of prose.
3. **Clone this repo** and work inside it, so `AGENTS.md` and `.agents/` load
   from the working tree.
4. **Read `AGENTS.md` from GitHub** and hold its rules in context for the session.

`.cursor/rules/` is intentionally repo-only; it is IDE configuration, not
operating knowledge.

### The CLI describes itself (start here on any surface)

From **2.11.0** the essential knowledge travels inside the binary, so even a bare
global install is not knowledge-free. Three things to run first, all of which
support `--json` for machine consumption:

```bash
venice-video agent-guide          # the core rules: gates, queue-time billing, long-render handling
venice-video pipeline --json      # the ordered stages, their gates, and the next command for each
venice-video status -p <dir> --json   # where a project stands and the exact command to run next
```

`agent-guide` is the ~80/20 subset of `AGENTS.md` — read it before generating
anything, then reach for the full rules and playbooks when you need depth. The
same core rules are installable as a skill for runners that pull skills from
GitHub: `hermes skills install jordanurbs/venice-video-harness/venice-agent-guide`
(and any of the other `.agents/skills/` by name).

From **2.15.0** the probe-verified model registry is also machine-readable:

```bash
venice-video capabilities   # full capability manifest as JSON: model specs, capability sets, budgets, routing defaults
```

The same manifest is committed as `capabilities.json` at the repo root
(regenerated on every release), so downstream clients — the Venice Video
Creator macOS app is the first — can fetch
`https://raw.githubusercontent.com/jordanurbs/venice-video-harness/main/capabilities.json`
and stay capability-synced between their own releases without shelling out to
the CLI.

### Running the harness in a separate runtime (containers, remote backends)

Running long renders off the main machine is a real and useful capability. In
Hermes it is the **terminal backend**, configured independently of any agent
protocol:

```yaml
# ~/.hermes/config.yaml
terminal:
  backend: local        # local | docker | ssh | modal | daytona | singularity
  timeout: 180
  lifetime_seconds: 300
```

A remote or containerized backend is a good fit for this harness, because renders
are long, CPU-idle, and network-bound — exactly the work you want off a laptop.
But the harness keeps state on disk, so four things have to be true before a
non-`local` backend produces usable output:

| Requirement | Why |
|---|---|
| `venice-video`, `ffmpeg`, `ffprobe` installed **in the runtime image** | The default images are generic Node/Python; none of the three is present |
| `VENICE_API_KEY` reaches the runtime | Via the backend's env passthrough, not your shell |
| `VENICE_VIDEO_WORKSPACE` on a **persistent volume** | Renders land next to the process. On an ephemeral container they are deleted with it |
| A retrieval step back to the host | Nothing copies `masters/` or `output/` home for you |

**The trap specific to this harness.** `pending-jobs.json` — the record that makes
an interrupted render re-attachable instead of re-billable — is written to the
**per-machine config directory** (`~/Library/Application Support/venice-video` on
macOS, `~/.config/venice-video` on Linux). In an ephemeral runtime that directory
dies with the container, so a render that was already queued and billed becomes
unrecoverable: the new runtime has no record to re-attach to. If you run renders
in a container, mount the config directory persistently, or keep generation on a
`local`/persistent backend and use the remote runtime only for assembly.

### Long renders need a background invocation, not a longer timeout

This applies to every agent runner with a command timeout, and it is a common
cause of half-finished runs that look like harness failures.

`generate-videos`, `assemble-episode`, `produce-episode`, `finish`, and
`upscale` routinely run **3–10 minutes**. Hermes's terminal tool defaults to a
**180-second** timeout and hard-caps a *foreground* command at 600s, rejecting
anything higher with a note to use `background=true` with
`notify_on_complete=true`. A foreground render therefore gets killed partway
through on the default settings.

Because Venice bills at queue time, a killed render is **already paid for**. So:

- Run every generation or assembly stage as a **background command with
  completion notification**, not a foreground call with a raised timeout.
- If one does get killed, **re-run the identical command** — see below on
  re-attaching. Do not treat the kill as a failed render and start over.
- Raise `terminal.timeout` only for the short commands (`status`, `doctor`,
  `validate-*`); it is the wrong tool for a 10-minute render.

### Registering the MCP server

**Published package (recommended — no clone, no absolute paths).** The
`venice-video-mcp` bin is on your `PATH` after a global install, and it finds the
`venice-video` harness the same way:

```bash
npm install -g venice-video-harness venice-video-mcp

# Hermes Agent
hermes mcp add venice-video --command venice-video-mcp
hermes mcp test venice-video     # confirm the handshake before relying on it

# Cursor / Claude Desktop / any runner that reads a JSON config:
#   "venice-video": { "command": "venice-video-mcp", "env": { "VENICE_API_KEY": "vn_..." } }
# or, with no global install at all, run it on demand:
#   "venice-video": { "command": "npx", "args": ["-y", "venice-video-mcp"], "env": { … } }
```

**Local build (development / running ahead of npm).** Point the server at a built
clone instead. This runs whatever you have checked out:

```bash
hermes mcp add venice-video --command node \
  --args /ABS/PATH/venice-video-mcp/bin/venice-video-mcp.js
# plus HARNESS_BIN or HARNESS_PATH in the env, see below
```

Environment for the server process:

| Variable | Purpose |
|---|---|
| `VENICE_API_KEY` | **Required.** Forwarded to the harness |
| `HARNESS_WORKSPACE` | Where projects are created. Must already exist. Falls back to the cwd, which is rarely right for a GUI-launched runner — set it |
| `HARNESS_BIN` | Optional. Absolute path to `dist/mini-drama/cli.js` in a built clone. Set only to pin a specific local build |
| `HARNESS_PATH` | Optional. Absolute path to a built clone. Fallback for a local build — see below |

With both packages installed globally you set **none** of the three harness paths:
the server finds `venice-video` on `PATH`. You only reach for `HARNESS_BIN` /
`HARNESS_PATH` when you deliberately want a local checkout instead of the published
CLI.

**Resolution order (fixed in `venice-video-mcp` 0.4.0).** The server resolves the
harness as `HARNESS_BIN`, then `HARNESS_PATH/dist/mini-drama/cli.js`, then a
`venice-video` on `PATH`. An explicit `HARNESS_PATH` outranks an ambient global
install, because setting it is a statement of intent — the old order let a stale
global silently win over a clone you pointed at deliberately. The server also logs
the resolved binary once to stderr (`[venice-video-mcp] harness: …`) on the first
tool call, so the choice is never silent.

Every MCP response includes the exact command it ran, so you can confirm which
binary answered:

```json
{ "ok": true, "command": "node /path/to/harness/dist/mini-drama/cli.js list-series" }
```

If that shows a path under a global npm prefix when you meant to use a clone,
`HARNESS_BIN` is missing.

Then install its companion skills, which carry the pipeline order the tool
descriptions deliberately leave out. From a global install the command is on
`PATH` (use `node /ABS/PATH/venice-video-mcp/bin/install-skills.js …` for a clone):

```bash
venice-video-mcp-install-skills --global        # Claude/Cursor: ~/.claude/skills/
venice-video-mcp-install-skills --target hermes  # Hermes: ~/.hermes/skills/venice/
venice-video-mcp-install-skills --dir <path>     # any other runner's skills dir
```

The four skills are `venice-mcp-pipeline` (request-to-tool-call mapping and the
gate flowchart), `venice-mcp-cookbook` (one worked example per action),
`venice-mcp-directing` (shot-prompt quality), and `venice-mcp-troubleshooting`
(every known failure mode). Without them the MCP tools are thin per-command
wrappers and you will reconstruct the pipeline by trial and error. Claude Code and
Cursor read `.claude/skills/` (their convention — the installer symlinks there);
Hermes reads `~/.hermes/skills/`, so `--target hermes` installs a `venice`
category there. Any other runner: pass `--dir` with its skills path. This repo's
own knowledge pack lives provider-neutrally in `.agents/`.

### Preflight: run these three checks first

```bash
venice-video --version          # must match the docs you are reading
venice-video doctor             # API key, ffmpeg, ffprobe
venice-video status -p <dir>    # pipeline stage + the next command to run
```

**Version-drift check is not optional.** Releases can lag commits, so the
published npm `latest` may trail this repo. Documentation for a version newer
than your installed binary describes flags it rejects:

```bash
$ venice-video new --intelligence kimi-k3
error: unknown option '--intelligence'
```

If `--version` does not match the version documented here, either upgrade or
work from the `--help` output of the binary you actually have. Never construct a
command from documentation you have not version-matched. When upgrading, pass
the prefix explicitly, because a global install can silently land in a different
Node prefix than the `venice-video` on your PATH:

```bash
npm install -g venice-video-harness@latest --prefix "$(npm prefix -g)" --foreground-scripts
command -v venice-video && venice-video --version
```

### Set the workspace explicitly — always

The project workspace resolves to `VENICE_VIDEO_WORKSPACE`, then the stored
config value, then **`./output` relative to the current working directory**. A
daemon-launched or GUI-launched agent has an arbitrary cwd, so projects get
created in unpredictable places and every later `-p` lookup fails.

```bash
export VENICE_VIDEO_WORKSPACE=~/VeniceVideos
```

Pass `-p <project>` and `-e <episode>` explicitly on **every** command. The
`use` / `unuse` selection is stored in user config and is meant for a human in
`venice-video shell`; an agent inheriting whatever the operator last selected is
a silent-wrong-project bug.

### The pipeline is gated. This is the order

```
new  ->  workshop  ->  workshop --approve  ->  [references]  ->  storyboard-episode
                                                                       |
                                                                       v
                                                qa-storyboard  ->  qa-approve
                                                                       |
                                                                       v
       generate-videos  ->  qa-videos  ->  generate-music  ->  assemble-episode  ->  finish
```

`[references]` = `add-character` / `generate-location-references` / `generate-storyboard-refs`.
Workshop approval materializes characters and locations as data only; `storyboard-episode`
blocks until each scripted character and location has reference images on disk.

Three gates block progress by design:

| Gate | Cleared by | Blocks |
|---|---|---|
| Script approval | `workshop --approve` or `approve-script` | `storyboard-episode` |
| Storyboard QA | `qa-approve`, after `qa-storyboard` reports no critical issues — the approval reads the report, and criticals/unchecked shots require `--force` | `generate-videos` |
| Video QA | `qa-videos` writing a passing `video-qa-report.json` (cross-unit identity, head glitches, boundary jumps) — a failing report blocks; a missing one warns | `assemble-episode` |

**Do not route around a gate.** `--skip-approval` and `--skip-qa` exist for
operators who have already reviewed the work by other means. An agent that hits
a gate error and retries with a skip flag is spending money to render
unreviewed panels, which is the exact outcome the gate prevents. When a gate
blocks you, run `venice-video status -p <dir>`, which reports the stage and
prints the next command in full copy-pasteable form, and clear the gate properly.

`produce-episode` runs the whole pipeline in one command. It is not a reliable
unattended path on a clean project, because it reaches stages that require a QA
approval artifact that does not exist yet. Prefer the explicit stage-by-stage
sequence.

### Money is spent at queue time, so never blind-retry a render

Venice charges when a render is **queued**, not when it is downloaded. A lost
`queue_id` is money already spent.

- Every queued render is recorded in `pending-jobs.json` keyed by output path
  *before* the first poll. If a generation command is interrupted, **re-run the
  identical command with the identical output path** — the harness re-attaches
  to the in-flight job and resumes polling. Do not "start fresh."
- Inspect in-flight work with `venice-video queue`. Only `queue clear` a record
  you know is dead. Do not delete a pending record to silence a warning.
- `venice-video queue` is Venice's side of the work; the shell's `/jobs` is only
  the current session's background commands. Different lists.
- A render produces no output for long stretches. That is normal, not a hang. Do
  not kill and reissue a quiet command; see the timeout note above for how to
  invoke these stages in the first place.
- Use `POST /video/quote` (surfaced by the CLI before paid steps) to price a run
  before committing. `finish` prints an estimate and requires `--yes` to proceed.

### Parsing output

The CLI is written for humans reading a terminal, but the agent-facing commands
now also emit JSON:

- **`--json` on the agent-facing commands** — `status`, `pipeline`, `agent-guide`,
  `doctor`, and `queue` (plus a global `venice-video --json <command>`) print
  exactly one JSON object on stdout, or use the MCP server, which returns
  `{ ok, message, paths, data, warnings, ... }` as `structuredContent`. Commands
  without `--json` still print prose — parse those conservatively.
- **Exit codes are honest** (from 2.11.0). `venice-video status` with no project
  now exits non-zero, not 0. `$?` is a reliable success signal for the
  agent-facing commands.
- **Ordinary errors are a clean `error:` line, not a stack trace** (from 2.11.0).
  A usage error in a non-TTY prints the message and exits 1; set
  `VENICE_VIDEO_DEBUG=1` to see the stack.
- **Deprecation warnings go to stderr**, prefixed `⚠ MODEL DEPRECATION:`, once
  per unique model/date pair. Surface them; they are the early signal that a
  model is about to start failing.

### Interactive commands, and how to run them non-interactively

`new` and `workshop` prompt when attached to a TTY. In a non-TTY they require
their arguments up front. A complete non-interactive project creation:

```bash
export VENICE_VIDEO_WORKSPACE=~/VeniceVideos

venice-video new \
  --type film \
  --name "signal-drift" \
  --concept "A radio astronomer starts hearing her own voice in the background noise" \
  --genre "science fiction" \
  --setting "a decommissioned desert array, present day" \
  --audio-strategy native \
  --video-family seedance

venice-video workshop -p ~/VeniceVideos/signal-drift \
  --outcome "Leave viewers unsettled by the signal" \
  --duration "3 minutes" \
  --audience "science fiction short-film viewers"

venice-video workshop -p ~/VeniceVideos/signal-drift --status
venice-video workshop -p ~/VeniceVideos/signal-drift --approve
venice-video status -p ~/VeniceVideos/signal-drift
```

`new` requires at minimum `--type`, `--name`, and `--concept` without a TTY;
everything else falls back to a default rather than prompting.

### The rules that most affect output quality

Full text lives in `AGENTS.md` > "Agent Rules" (55 rules) and "Learned
Anti-Patterns" (30 entries). If you can only carry a few, carry these:

1. **Direct the scene, don't decorate it.** Name one intention for the beat and
   derive camera, light, blocking, performance, and sound from it. Stacking
   "cinematic / epic / 4k / masterpiece" adjectives gives the model nothing to
   serve.
2. **Prefer 15s shots.** Two 15s shots beat five 6s shots on identity stability,
   motion completion, continuity, and cost. Reserve short durations for
   deliberate quick beats.
3. **Prefer Seedance native multi-shot for any 2–3 beat scene.** One generation
   with `Lens switch.` separators holds identity, environment, and lighting
   across the beats and costs roughly 3× less than three separate renders.
   (Since 2026-08-05 the planner does this by default: multi-shot units render
   on Seedance R2V Enhanced with the full reference slot plan.)
4. **Front-load style.** Aesthetic descriptions go at the start of a prompt, not
   the end, or style drifts across angles.
5. **Keep Seedance prompts under 60 words**, using Subject, Action, Camera,
   Style, Constraints.
6. **Never group shots with different characters into one multi-shot unit.**
   Cuts between different speakers must be separate singles so each gets its own
   identity anchoring.
7. **Re-anchor every separately-rendered shot to the same locked references** and
   restate the character's invariant traits — including relative size — in every
   prompt.
8. **State placement explicitly — spatial consistency is authored, not
   inferred.** Lock each location's landmark geography in
   `Location.spatialAnchors` and give every character shot a `blocking` field:
   each subject's position relative to the named anchors, screen side, depth,
   and facing/eyeline. Keep screen sides and eyelines constant across a scene's
   shots unless a movement is scripted (180-degree rule). The harness injects
   both verbatim into panel, blocking-plate, and video prompts.
9. **Pass `aspectRatio` explicitly** on reference-to-video generation.
10. **Never multi-edit close-up face shots on 16:9 panels.** The square-to-16:9
    crop removes roughly 25% top and bottom, losing foreheads and chins.
11. **Archive prior renders; never delete generated shot assets.**
12. **Validate model capabilities before sending** `elements`,
    `reference_image_urls`, `scene_image_urls`, `end_image_url`, or `audio_url`.
    The registry is `src/venice/models.ts` in a clone; from a global install use
    `.agents/skills/venice-video-model-routing/SKILL.md` or the model tables
    below.
13. **Ask before burning in subtitles**, and derive caption timings from
    `ffmpeg silencedetect` on the rendered voiceover rather than estimating them.

### Checkpoints where you should stop and ask

The harness is quality-first and several stages are expensive and hard to undo.
Stop for confirmation before: rendering an EDL cut, replacing native dialogue
with TTS, burning in subtitles, upscaling to a 4K master, and any run whose
quote you have not shown the operator. Post a short summary of what you are
about to do and wait.

## Supported Venice Models

### Video Models

Live catalog (synced against `GET /api/v1/models?type=video` — 103 entries). Families the harness routes to today; private / `-video-to-video` / `-extend-video` variants exist in the live catalog but aren't surfaced here.

| Family | Image-to-Video | Text-to-Video | Max Duration | Audio | Special Features |
|--------|---------------|---------------|-------------|-------|-----------------|
| **Seedance 2.0** | i2v, R2V | t2v | 15s | Yes (stereo, lip-sync 8+ langs) | **#1 ranked.** R2V: flat `reference_image_urls`, `@Image` tags. Default routing target. |
| **Seedance 2.0 Fast** | i2v, R2V | t2v | 15s | Yes | Cheaper / faster Seedance 2.0 variant. Same 4-15s ladder, same provenance gate. |
| **Seedance 1.5 Pro** | i2v | t2v | 12s | Yes | Older Seedance line; kept for parity. |
| **HappyHorse 1.1** | i2v, R2V (up to 9 refs) | t2v | 15s | Yes (joint single-pass, 7-lang phoneme lip-sync) | **#1 blind-preference T2V + I2V** (Alibaba 15B). 3-15s, 720p/1080p, nine aspect ratios. Best for talking characters + multilingual localization; SFW/commercial-leaning. The `happyhorse` video-family now routes here. |
| **HappyHorse 1.0** | i2v, R2V | t2v | 15s | Yes | Prior line, kept for back-compat. Livelier hand-camera realism / cinematic grain vs Seedance. |
| **MiniMax H3** | i2v, R2V (up to 9 refs) | t2v | 15s (**5s floor**) | Yes (native stereo, not toggleable) | Open-weight omni-modal model — one net covers T2V/I2V/reference. **2K is the only resolution** (no draft tier) at ~1/3 the per-second cost of other families; 24fps, 2500-char prompts. The `minimax-h3` video-family routes here. Sub-5s durations are a hard 400. |
| **MiniMax H3 Max** | i2v, R2V (up to 9 refs) | t2v | 15s (**5s floor**) | Yes (native, not toggleable) | **Simple prompts — the model stages its own coverage.** Registry `promptStyle: 'simple'`, so the prompt builder strips blocking, locked location descriptions, and geography-hold clauses; say the intent in a sentence or two. Best for montages and beats where the model telling its own story is the point. **768P max — 2K is a hard 400**, the inverse of base H3 (480P is the draft tier). `private` tier, uncensored, 10000-char prompts. $0.024/s. The `minimax-h3-max` video-family routes here. |
| **MiniMax H3 Max Turbo** | i2v | t2v | 15s (**5s floor**) | Yes (native, not toggleable) | Same model and constraints at **$0.012/s — the cheapest lane in the registry**, which makes 15s takes cheap enough to render several and pick. **No R2V lane** (`-turbo-reference-to-video` does not exist), so the `minimax-h3-max-turbo` family routes identity shots to `minimax-h3-max-reference-to-video`. |
| **Wan 3.0** | i2v, R2V (up to 9 refs), Enhanced | t2v | **30s** | Yes (always on, not toggleable) | **Longest shots on Venice** — 5/10/15/20/25/30s at 480p/720p/1080p, five aspect ratios plus adaptive, 5000-char prompts. The `wan-3-0` video-family routes here. No audio input anywhere in the family, so it can't lip-sync to a supplied recording. `*-enhanced-*` variants are beta. |
| **Wan 2.7** | i2v, R2V, V2V, Spicy | t2v | 15s | Wan i2v has no audio; lip-syncs via `audio_url` input | **The audio-driven fallback for exact lip-sync.** R2V exposes per-element `audio_url` for multi-speaker. Spicy = uncensored i2v variant. Seedance 2.x R2V and MiniMax H3 R2V also accept a top-level `audio_url`, so those families never route here. |
| **Wan 2.6** | Standard, Flash, R2V | Standard | 15s | Yes (i2v/t2v); R2V capped at 10s | Now has R2V variant with `audio_url` input. 1080p. |
| **Wan 2.5 Preview** | i2v | t2v | 10s | Yes | `audio_url` input. |
| **Wan 2.2 A14B** | — | t2v | 5s | No | Legacy text-to-video. |
| **Wan 2.1 Pro** | i2v | — | 6s | No | Legacy. |
| **Runway Gen-4.5** | Gen-4.5, Turbo, Aleph | Gen-4.5 Text | 10s | No (silent) | Strong motion physics; 7 aspect ratios. No R2V, no audio, no end-image. |
| **Sora 2** | Standard, Pro | Standard, Pro | Standard 12s / **Pro 20s** | Yes | Pro now reaches 20s + `true_1080p` resolution. |
| **Veo 3.1** | Fast, Full | Fast, Full | 8s | Yes | Up to 4K resolution. |
| **Veo 3** | Fast, Full | Fast, Full | 8s | Yes | |
| **Kling O3** | Pro, Standard, 4K + R2V variants | Pro, Standard, 4K | 15s | Yes | R2V: `elements`, `reference_image_urls`, `scene_image_urls`. 4K variants for delivery-grade output. |
| **Kling V3** | Pro, Standard, **4K R2V** | Pro, Standard, **4K** | 15s | Yes | 4K variants added 2026-05+. `end_image_url` on R2V. |
| **Kling 2.6 Pro** | i2v | t2v | 10s | Yes | `end_image_url`. |
| **Kling 2.5 Turbo Pro** | i2v | t2v | 10s | No | `end_image_url`. |
| **PixVerse C1** | i2v, R2V, Transition | t2v | **15s** | Yes | Replaces v5.6: same four resolutions but 15s ladder + new R2V variant. |
| **PixVerse v5.6** | Standard, Transition | Standard | 8s | Yes | Legacy; prefer C1 for new projects. |
| **Grok Imagine** | i2v, **R2V**, V2V | t2v | i2v/V2V/t2v 15s · R2V 5/8/10s | i2v/t2v: yes · R2V: no | R2V added 2026-05+ (no longer needs Kling fallback). 7 aspect ratios. |
| **LTX Video 2.0** | Fast, Full, v2.3, 19B + V2V/extend | Fast, Full, v2.3, 19B | 20s (Fast/v2.3) · 10s (Full) · 18s (19B) | Yes | Up to 4K, longest durations. |
| **Longcat** | Standard, Distilled | Standard, Distilled | **30s** | No | Longest single-shot for non-talking-head work. |
| **Vidu Q3** | i2v | t2v | 16s | Yes | `reference_image_urls`. |
| **OVI** | i2v | — | 5s | Yes | |

> **Seedance face rule (removed 2026-07):** Seedance 2.0 used to reject face-bearing input images that weren't produced by `seedream-v5-lite` / `seedream-v5-lite-edit`. Venice removed that restriction — any image family now works for face-bearing inputs, so the harness uses `nano-banana-2` for all panels. See [Image / Video Family Pairing](#image--video-family-pairing) below.

### Image Models (28 entries)

`nano-banana-pro`, `nano-banana-2`, `gpt-image-2` (high-quality alternative to `nano-banana-pro`), `gpt-image-1-5`, `flux-2-pro`, `flux-2-max`, `grok-imagine-image`, `grok-imagine-image-quality`, `hunyuan-image-v3`, `imagineart-1.5-pro`, `qwen-image-2`, `qwen-image-2-pro`, `recraft-v4`, `recraft-v4-pro`, `seedream-v4`, `seedream-v5-lite`, `chroma`, `hidream`, `venice-sd35`, `lustify-sdxl`, `lustify-v7`, `lustify-v8`, `wai-Illustrious`, `z-image-turbo`, `ernie-image`, `ernie-image-turbo`, `wan-2-7-text-to-image`, `wan-2-7-pro-text-to-image`, `bria-bg-remover`

New since the last sync: `grok-imagine-image`, `grok-imagine-image-quality`, `lustify-v8`, `ernie-image`, `ernie-image-turbo`, `wan-2-7-text-to-image`, `wan-2-7-pro-text-to-image`. Sunset: bare `qwen-image` (use `qwen-image-2`).

### Multi-Edit Models

`qwen-edit`, `qwen-image-2-edit`, `qwen-image-2-pro-edit`, `flux-2-max-edit`, `gpt-image-2-edit` (high-quality alternative to `nano-banana-pro-edit`), `gpt-image-1-5-edit`, `grok-imagine-edit`, `nano-banana-2-edit`, `nano-banana-pro-edit`, `seedream-v4-edit`, `seedream-v5-lite-edit`

### Audio / Music Models

- **TTS**: `tts-kokoro` (50+ voices), `tts-qwen3-0-6b`, `tts-qwen3-1-7b` (style-prompted voices)
- **Music**: `elevenlabs-music`, `minimax-music-v2`, `minimax-music-v25`, `minimax-music-v26`, `lyria-3-pro`, `ace-step-15`, `stable-audio-25`
- **Expressive speech / prompt-driven audio**: `seed-audio-1-0` (BytePlus Seed Audio 1.0 — 25 named voices, speed 0.5–2, up to a 2048-char prompt; premium prompt-directed narration/VO via the async audio queue). Use `generate-audio --prompt … [--voice … --speed …]`.
- **SFX**: `elevenlabs-sound-effects-v2`, `mmaudio-v2-text-to-audio`
- **TTS (ElevenLabs)**: `elevenlabs-tts-v3`, `elevenlabs-tts-multilingual-v2`

### The intelligence model

Three steps in the pipeline reason rather than render: the **workshop** develops
the project, **workshop-script** writes the shot script, and **qa-storyboard**
reads the rendered panels back and flags identity, wardrobe, setting and framing
drift. One model does all three, chosen when the project is created and stored on
`series.intelligence`. It generates none of the pixels or audio.

| Model | Tier | Reads panels | $/M out |
|---|---|---|---|
| **Kimi K3** (default) | private | yes | 18.75 |
| GLM 5.2 | private | no | 4.40 |
| Grok 4.5 | private | yes | 6.80 |
| Fable 5 | anonymized | yes | 60.00 |
| Opus 5 | anonymized | yes | 30.00 |
| GPT 5.6 Sol | anonymized | yes | 37.50 |
| Qwen 3.8 Max | anonymized | yes | 7.50 |

**Private** means the prompt stays on Venice infrastructure. **Anonymized** means
it is routed to an external provider with identifying metadata stripped.

A text-only model cannot do storyboard QA, so it is paired with a vision-capable
companion **from the same privacy tier** — GLM 5.2 borrows Grok 4.5, never an
anonymized model. The pairing is shown before you commit to it, in the wizard and
on the treatment page.

```bash
venice-video new                                   # asks, defaulting to Kimi K3
venice-video new --intelligence claude-opus-5      # or state it upfront
venice-video workshop -p <project> --model grok-4-5   # override one run
```

GLM 5.2 needs a second attempt at valid JSON about one time in three; the client
retries automatically, so the choice costs latency rather than a failed command.

## What Makes It Venice-Optimized

- Image prompts tuned for Venice image generation models
- Two-pass panel generation with Venice multi-edit refinement
- **Model-routing logic** for action, atmosphere, and character-consistency tiers
- Support for reference-aware video generation (`elements`, `reference_image_urls`, `scene_image_urls`)
- Environment-aware prompt adaptation (daytime vs night scenes)
- Venice-native audio generation paths for TTS, SFX, and music
- **Video quote endpoint** for cost estimation before generation
- Model-aware parameter building (auto-skips unsupported params per model)
- **Parallel editing pipeline** — transcribe existing footage locally, read a 12KB pack, render with 30ms audio fades, self-eval at every cut boundary

## Project Structure

```
AGENTS.md                        Agent orchestration hub
.agents/
  commands/                      19 workflow playbooks (see below)
  agents/                        6 specialized agent roles (see below)
  skills/                        6 Venice and workflow knowledge packs (see below)
.cursor/rules/                   IDE-level safety rules
src/
  venice/                        Venice API client layer
    client.ts                    HTTP transport, retries, rate limiting
    models.ts                    Complete model registry (50+ models)
    video.ts                     Video queue/retrieve/quote/complete
    generate.ts                  Image generation
    multi-edit.ts                Multi-image layered editing
    edit.ts                      Upscale, background remove
    audio.ts                     TTS, music, SFX, queued audio
    voices.ts                    Voice catalog (Kokoro + Qwen3)
    types.ts                     Full API type definitions
  series/                        Project state and character management
    manager.ts                   Create/load/save series
    types.ts                     Character, ShotScript, SeriesState types
  mini-drama/                    Reference narrative video implementation
    cli.ts                       Commander CLI (25+ commands)
    prompt-builder.ts            Image + video prompt construction
    video-generator.ts           Video rendering with frame chaining
    generation-planner.ts        Single vs multi-shot planning
    panel-fixer.ts               Multi-edit character correction
    subtitle-generator.ts        SRT from script
    assembler.ts                 Video assembly + audio mix
  editing/                       Parallel editing pipeline (inspired by browser-use/video-use)
    types.ts                     WordTiming, Take, TakesPack, Edl, EditSession
    packer.ts                    Collapse word streams -> takes_packed.md
    aligner.ts                   Ground-truth script alignment for generated VO
    providers/whisper-cpp.ts     Local transcription provider
    edl.ts                       EDL authoring + ffmpeg rendering
    silence.ts                   silencedetect wrapper + filler-word detection
    render.ts                    EDL -> final-edit.mp4 with 30ms audio fades
    self-eval.ts                 Drive cut-qa agent, max 3 iterations
    overlays.ts                  Overlay manifest types
  storyboard/                    Legacy screenplay storyboard pipeline
  characters/                    Character extraction and references
  parsers/                       Fountain + PDF screenplay parsing
  assembly/                      Remotion scaffold and manifest
scripts/                         Utility scripts (.ts tracked, .mjs gitignored)
templates/                       HTML storyboard viewer template
output/                          Generated projects (gitignored)
```

## Getting Started

### Requirements

- Node.js 20+
- `ffmpeg` and `ffprobe` on your PATH
- A Venice API key
- **Optional (editing pipeline):** `whisper-cpp` on PATH for local transcription

### Standalone install

The CLI works directly against the Venice API. Cursor, Claude Code, OpenCode,
MCP, and other agent harnesses are optional integrations, not runtime requirements.

```bash
npm install -g venice-video-harness --foreground-scripts
venice-video setup
venice-video doctor
venice-video new
```

The `--foreground-scripts` flag makes the package's PATH diagnostic visible;
modern npm otherwise suppresses successful post-install output. After installation,
verify that your shell can find the executable:

```bash
command -v venice-video
venice-video --version
```

If npm reports a successful install but `venice-video` is not found, npm's global
`bin` directory is not on your shell `PATH`. The install output prints the exact
directory and an `export PATH=...` command when it detects this condition. You can
also inspect the directory manually:

```bash
NPM_BIN="$(npm prefix -g)/bin"
echo "$NPM_BIN"
export PATH="$NPM_BIN:$PATH"
```

Add that `export` line to `~/.zshrc`, `~/.bashrc`, or the startup file for your
shell, then open a new terminal. Node version managers can create this mismatch
when the active `npm` installs globally somewhere different from the active
Node shim.

`venice-video setup` prompts for the API key without echoing it, validates it,
and stores it in the OS-appropriate user configuration directory with owner-only
permissions. It also records a default project workspace. Environment variables
still take precedence for CI or ephemeral use:

```bash
export VENICE_API_KEY=your_key
export VENICE_VIDEO_WORKSPACE=~/VeniceVideos
```

After `new`, the CLI hands the project to one guided control center:

```bash
venice-video workshop -p ~/VeniceVideos/my-film
# Noninteractive: --outcome "Leave viewers exhilarated, then unsettled by the signal"
```

The workshop develops the complete project—not only a shot list:

- audience outcome, audience, runtime, constraints, and optional dragged reference files/directories
- logline, synopsis, themes, acts/movements, and story beats
- visual aesthetic, palette, lighting, lens language, and texture
- characters, wardrobe, voices, and continuity anchors
- locations and environmental continuity
- dialogue/audio approach and exact-lip-sync decisions
- production-ready shot script, risks, and open questions

It writes a formatted `WORKSHOP.html` for browser review, `WORKSHOP.md` as a
portable text version, and `workshop.json` as the structured source. In an
interactive terminal, the HTML opens automatically in your default browser. Iterate without losing project context:

```bash
venice-video workshop -p ~/VeniceVideos/my-film --feedback "Make the middle more tense"
venice-video workshop -p ~/VeniceVideos/my-film --status
venice-video workshop -p ~/VeniceVideos/my-film --approve
```

Approval materializes the accepted aesthetic, cast, locations, and script into
the existing production pipeline.

### The treatment page tracks the run

`WORKSHOP.html` is not written once and left to go stale. Every command that
produces an artifact rewrites it, so the browser tab you already have open is
one reload away from the current state. The page gains:

- a **Production progress** card: the pipeline stage, panel/clip/dialogue
  counts, and the next command in full copy-pasteable form (`-p` and `-e`
  included, so it works pasted into any terminal, not only the shell)
- an **Output** column on the shot script: each shot's panel thumbnail,
  replaced by the clip's poster frame once the shot renders, with badges for
  panel, clip, voiceover and its QA verdict — hover a flagged verdict to read
  the issue

Images are embedded as WebP data URIs, so the page stays a single self-contained
file that survives being moved or emailed. Encoding is cached against each
file's mtime in `.treatment-thumbs.json`, so a refresh only re-encodes what
actually changed (a typical refresh is ~10ms). The refresh can never fail the
command that triggered it: an undecodable panel or a half-written QA report
just leaves that cell blank.

Commands that refresh the page: `approve-script`, `storyboard-episode`,
`fix-panel`, `insert-shot`, `qa-storyboard`, `qa-approve`, `generate-videos`,
`generate-music`, `override-audio`, `assemble-episode`, and `finish`.

The workshop also asks for the final delivery target. Choose **4K master** to
keep generation/drafts economical and upscale only the approved assembled cut:

```bash
venice-video finish -p ~/VeniceVideos/my-film
# Prints input, output, and cost estimate first; then:
venice-video finish -p ~/VeniceVideos/my-film --yes
```

The finishing command finds the assembled master, chunks large videos into
upload-safe segments, upscales them through `topaz-video-upscale`, resumes
already-finished chunks after interruption, concatenates without another video
encode, and remuxes the original audio. The 4K master lands in `masters/` while
the original assembled master is preserved. Current rough estimate: about
$0.12 per input second; the CLI always shows the estimate before spending.

For a standalone file outside a project:

```bash
venice-video upscale --input final-cut.mp4 --factor 4
venice-video upscale --input final-cut.mp4 --factor 4 --yes
```

Individual commands such as
`explore-aesthetic`, `add-character`, and `storyboard-episode` remain available
for advanced manual control, but they are no longer the default onboarding path.

The `new` wizard starts with these production types:

1. **Film** — a film of any length; there is no short-duration assumption
2. Series
3. Product video
4. Music video
5. Screenplay

Film projects use `new-script` and `workshop-script` terminology. Internally,
legacy JSON keys and directories still use `episode` for compatibility, but the
CLI and scriptwriter prompt call the work a Film and Part. Film scripts do not
inherit the series workflow's 60-second duration, one-location structure, or
next-episode cliffhanger.

A non-interactive Film can also be created explicitly:

```bash
venice-video new \
  --type film \
  --name "Long Horizon" \
  --concept "A feature-length journey across a flooded world" \
  --genre adventure \
  --audio-strategy native \
  --video-family auto
```

Useful standalone commands:

```bash
venice-video config show
venice-video config set-workspace ~/VeniceVideos
venice-video config unset-api-key
venice-video list-series
venice-video update
venice-video --help
```

### Staying up to date

```bash
venice-video update           # install the latest published release
venice-video update --check   # report what is available, install nothing
venice-video update --dry-run # print the npm command it would run
venice-video update --tag next
```

The install goes to the prefix the running copy lives in, not to whatever `npm`
happens to be first on your `PATH`. Those are the same directory in a plain
install, but a Node version manager can leave them pointing at different
prefixes — in which case `npm install -g` reports success while the executable
you actually run stays on the old version. `update` reads the new version back
off disk afterwards and says so if they disagree.

A build that is ahead of the published tag — an unreleased local build, or a
dist-tag that was rolled back — is reported rather than downgraded; pass
`--force` to install the published version anyway.

Two installs `update` will not overwrite, because it does not own them:

- a copy in a project's `node_modules`, whose version belongs to that project's
  lockfile (`npm install venice-video-harness@latest` there instead)
- a copy running from a git checkout, where npm would clobber local work
  (`git pull && npm install && npm run build`)

In both cases the command prints the right instructions and exits non-zero.

### Interactive shell

Every command above also runs inside a persistent session:

```bash
venice-video shell
```

The shell keeps one warm process for the whole production, which changes three
things that matter over a long session:

- **A selected project and part.** `use <project> [part]` sets them once; after
  that `-p` and `-e` are optional on every command and the prompt shows what you
  are pointed at. `unuse` clears the selection. The selection persists across
  shell restarts and applies to one-shot commands too.
- **Warm rate limiting and caches.** The Venice client's pacing state survives
  between commands instead of resetting on every invocation, so back-to-back
  generation stops tripping 429s.
- **Background commands.** Suffix any command with `&` to detach it, then keep
  working. `/jobs` lists them with elapsed time and current progress detail,
  `/jobs log <id>` replays captured output, `/jobs cancel <id>` aborts one.

```
venice-video my-film · ep 01 › storyboard-episode
venice-video my-film · ep 01 › generate-videos &
  [1] started in the background. Check with /jobs.
venice-video my-film · ep 01 › /jobs
  [1] running    4m12s  generate-videos — shot 3/12 polling
```

Session extras: `Tab` completes commands, flags, and project slugs; `↑`/`↓` walk
a persistent history file; `Ctrl-C` cancels the running command without killing
the session (`Ctrl-D` or `/exit` leaves); `/help`, `/status`, `/jobs`, `/cd`, and
`/pwd` are shell meta-commands; `!<cmd>` runs something in your system shell.

### Loop mode — watch the whole plan while it renders, or iterate on real shots

Once a plan exists (an approved shot script), you can play the entire film as a
live browser loop while the harness renders it, instead of waiting for the full
gated pipeline:

```bash
venice-video loop -p ~/VeniceVideos/my-film -e 1                   # asks the purpose
venice-video loop -p ~/VeniceVideos/my-film -e 1 --mode looping    # or state it
venice-video loop -p ~/VeniceVideos/my-film -e 1 --mode production
```

Loop mode starts with one **required, deliberate decision** — **is this for
LOOPING or for PRODUCTION?** — because it is a real quality-vs-flow tradeoff, not
a default to fall through. In a terminal it asks; non-interactively you must pass
`--mode` (it errors otherwise). You can state it in plain words —
`--mode looping` / `loop` / `fun` / `creative`, or `--mode production` / `prod` /
`gather`:

- **Looping — creative flow, lower quality.** The first generation is **t2v**,
  every shot after it **chains i2v off the previous shot's last frame**, and it
  **never uses R2V** (those renders are too slow for a loop). Turbo, 480P, fast.
  Not final-quality; it's for watching and riffing.
- **Production — gather usable shots, higher quality.** **Max R2V + references**
  at 768P, identity locked, each shot rendered independently. Slower, but the
  takes you pin are keepers.

Either way it boots the local web UI, opens the browser to a **Loop** tab, and
**auto-starts** a background engine that renders each shot into the episode's
`loop/` directory and **keeps regenerating fresh takes continuously** (it does
not stop after a fixed number of takes — only a Pause or the budget stops it).
The plan plays on repeat and each shot hot-swaps in as its take finishes;
because the render outruns playback, the video keeps evolving. Pin the keepers,
regenerate the ones you don't, and watch a running spend meter. Both modes
**skip the storyboard/QA gates** and write **only** under `loop/` — canonical
`scene-001/shot-NNN.mp4` renders and `series.json` are never touched, so a loop
can run alongside real production.

Two behaviors make the loop play as one continuous piece:

- **Last-frame chaining (default on).** Shot 1 renders normally; **every shot
  after the first renders i2v using the previous shot's last frame as its first
  frame**, so the clips flow into each other. Turn it off with `--no-chain` to
  render each shot independently (in create mode that keeps per-shot R2V identity
  locking).
- **Full-length takes.** Every generation renders the model's full length
  (**15s** by default — MiniMax H3 Max's max), for maximum footage and playback
  per render. Override with `--duration`.

Because the engine auto-starts, the **Loop** tab shows **Pause** while it's
running. It regenerates until you Pause or the budget is reached; when the budget
is reached it pauses and the button becomes **Resume**, which authorizes another
budget's worth and continues. (`--max-takes` is a ring buffer — the number of
candidate takes kept per shot — not a stop condition; older takes are pruned so
an infinite run can't fill the disk.)

The two modes differ in what they render:

| Purpose (`--mode`) | Model | Resolution | Identity | Use it to… |
|---|---|---|---|---|
| **looping** | MiniMax H3 Max **Turbo** t2v/i2v (~$0.012/s) | 480P | **not** locked (Turbo has no R2V lane) | keep a fast, continuous loop going for creative flow |
| **production** | MiniMax H3 Max **R2V** for character shots, i2v/t2v otherwise (~$0.024/s) | 768P | **locked** via the project's reference stack | gather real, usable shots and pin keepers |

Production mode uses the same reference-first routing as the real pipeline:
character shots render on `minimax-h3-max-reference-to-video` with the full
`@Image` reference stack (character sheets, location angles, blocking plates)
plus voice-donor audio, so identity holds. Shots with no references on disk
degrade to i2v (off a panel) or t2v, so generate your character/location
references first for the full effect.

Continuous regeneration spends money, so it is capped by default:

```bash
venice-video loop -p <dir> -e 1 \
  --mode production \      # looping | production (required; also accepts loop/fun, prod/gather)
  --resolution 768P \      # defaults: 480P (looping) / 768P (production)
  --duration 15s \         # per-take length, snapped to the 5-15s ladder (default 15s)
  --budget 2 \             # pause after ~$2; Resume/regenerate authorizes another budget
  --max-takes 3 \          # candidate takes kept per shot (ring buffer, not a stop)
  --no-chain \             # render shots independently instead of i2v last-frame chaining
  --no-face-continuity \   # don't prompt chained shots to end on the character's face (see below)
  --once                   # or: render one take per shot, then stop
# --unbounded              # remove the budget cap (spends until you Ctrl-C)
```

The loop is resumable: takes, pins, and spend are recorded in
`loop/loop-manifest.json`, so re-running `loop` picks up where it left off.
`Ctrl-C` stops the engine and the server.

**A shot that keeps failing is given up on, not re-billed forever.** After 3
consecutive render failures the engine marks the shot `failed`, stops scheduling
it, and moves on — so a server-side-doomed shot (e.g. a MiniMax i2v start frame
with a human face, which Venice bills at queue time then 500s on retrieve) can't
burn the whole budget one failed take at a time. A manual **regenerate** in the
UI revives it.

**Face continuity (on by default, for smoother i2v transitions).** In a chained
loop each shot's last frame becomes the next shot's i2v start frame, so
`--face-continuity` (default on) prompts each character shot to **end on the
character's face**, giving the next clip a clean anchor to continue from
(`--no-face-continuity` turns it off). One important caveat: MiniMax i2v renders
**die server-side when the start frame shows a face** (AGENTS.md anti-pattern
31), so on the MiniMax loop lanes this prompting is **auto-suppressed** — a
face-ending frame would kill the next chained render. It activates on any i2v
model that accepts face start frames. For smooth character-face loops **today**,
use **production** mode: R2V locks the face from the reference sheets across every
shot, with no i2v chaining involved (verified — MiniMax R2V accepts face-bearing
reference sheets; only i2v *start frames* die).

### Stream mode — an infinite, live-authored story

`loop` cycles a fixed plan. `stream` never repeats. It writes the story forward
one beat at a time and never renders a beat twice:

```bash
venice-video stream -p ~/VeniceVideos/my-show \
  --direction "90s multi-camera sitcom, live studio audience laugh track after every joke"
```

How it works:

1. You pick the writer. A new stream asks which model writes the beats (it is
   the voice of the whole story, and its speed sets how far the stream lags
   playback). Non-interactive runs must pass `--writer <model>` (or `--writer
   default` = `deepseek-v4-flash-0731-fast`, the fastest reliable writer in
   the bakeoff); a resumed stream keeps the writer it last ran with. The
   writer and the per-beat cost print before beat 1 bills.
2. The writer writes beat 1 from the series bible: concept, setting, aesthetic,
   and cast.
3. Beat 1 renders text-to-video on MiniMax H3 Max Turbo.
4. The writer reads `story-so-far.md` (one line per prior beat) plus the last
   6 beats verbatim, and writes beat 2 so it begins exactly where beat 1 ended.
5. Beat 2 renders image-to-video off beat 1's last frame.
6. Repeat forever, until Pause or the budget.

There is no re-anchoring and no ring buffer. Every beat descends from the frame
before it, and every beat stays on disk in order under
`episodes/episode-NNN/stream/` as `beat-NNNNN.mp4` + `beat-NNNNN.json`, with
`story-so-far.md` and `stream-manifest.json` beside them. The browser's
**Stream** tab plays forward from beat 1; when it reaches the newest beat before
the next is ready, it holds and then continues. Nothing else is needed: no
script, no storyboard, no references. A locked aesthetic (`set-aesthetic`) and
a cast (`add-character`, `--skip-images` is fine) make the writer much better.

```bash
venice-video stream -p <dir> \
  -e 1 \                    # episode the stream lives under (default 1)
  --direction "<text>" \    # standing direction folded into every beat's writer prompt
  --writer <model> \        # writer; asked for a new stream, required non-interactively (see the bakeoff table)
  --video-family <family> \ # minimax-h3-max-turbo (default) | minimax-h3-max | wan-3-0 | grok-imagine | seedance-2-0 | seedance-2-5 | kling-o3-standard
  --resolution 480P \       # default: the family's draft tier
  --duration 15s \          # per-beat length, snapped to the 5-15s ladder
  --budget 2                # stop after ~$2; Continue authorizes another budget
# --unbounded               # no cap (streams until Ctrl-C)
```

The stream is resumable: re-running `stream` continues from the last beat on
disk and chains off it. After 3 consecutive failures (write, chain, or render)
the engine stops rather than skip a beat — a stream cannot have a hidden cut.
Identity drifts slowly over many hops, by design; that is the trade for a
continuous, unbroken picture.

**Faces and the chain.** MiniMax i2v accepts a start frame that is filled by a
human face, bills it, and then fails server-side (anti-pattern 31). Because
every beat chains off the previous last frame, one face-ending beat could stall
the whole stream. Three things keep it alive: the writer is told to end every
beat on a wide shot with no face close-up; a failed chained render first steps
the start frame back into the previous clip (0.5s, then 1.5s); and after
`STREAM_CHAIN_FAILURES_BEFORE_RESET` (2) chained failures on one beat, that beat
renders text-to-video as a **soft reset** (`lane: "t2v-reset"`) — the prompt
restates the scene from the previous beat's summary, identity drifts for one
beat, and the story keeps going. The Stream tab shows the retry error while it
happens and marks reset beats in the story list.

**Speed is the constraint.** A beat's wall time is writer latency + render
latency, and the viewer watches 15 s of video per beat. Nothing on Venice
renders 15 s of video in under 15 s, so every stream eventually catches up to
its newest beat and holds. The two model choices decide how bad the lag is, and
both are dropdowns in the **Stream** tab (a change applies to the next beat):

| Writer (thinking off) | Median per beat | Valid beats | Tier |
|---|---|---|---|
| `deepseek-v4-flash-0731-fast` (default) | 3.8 s | 9/9 | private |
| `mistral-small-2603` | 5.2 s | 9/9 | private |
| `seed-2-1-turbo` | 9.2 s | 9/9 | anonymized |
| `kimi-k3` (harness intelligence default) | 9.8 s (35 s with thinking) | 8/9 | private |
| `deepseek-v4-flash` | 11.0 s | 6/6 | private |
| `minimax-m27` (thinking on) | 10.1 s | 5/6 | private |
| `gemini-3-8-flash` (thinking on) | 19.1 s | 4/6 | anonymized |

Rejected: `z-ai-glm-5-3` (thinking-only, 0/3 valid), `z-ai-glm-5-3-flash`
(prose instead of JSON without thinking), `grok-4-6` (67 s), `qwen3-6-35b-a3b`
(truncates JSON 1 in 3), `kimi-k3-fast` (HTTP 500 every call). Re-run the
numbers with `npx tsx scripts/bakeoff-stream-writer.ts -p <project> --no-thinking`.

| Video family | ~Render per 15 s beat | $/15 s (quote) | Keeps up? |
|---|---|---|---|
| `minimax-h3-max-turbo` (default) | 30 s | $0.11 | nearly |
| `minimax-h3-max` | 60 s | $0.22 | no |
| `wan-3-0` | 120 s | $0.68 | no |
| `grok-imagine` | 90 s | $0.95 | no |
| `seedance-2-0` | 180 s | $1.32 | no |
| `seedance-2-5` | 180 s | $1.93 | no |
| `kling-o3-standard` | 150 s | $1.84 | no |

Pick Seedance for the production look and accept that the viewer waits
between beats. The tab says so next to the dropdown.

The `stream` command registers its episode in `series.json` if it is missing, so
the Stream tab always has an episode to show. (Before 2.21.1 a stream under an
unregistered episode rendered beats the browser could not display.)

### Interrupted renders are resumable

The harness records each Venice `queue_id` to disk *before* it starts polling, so
a cancelled command, a crash, or a closed laptop no longer orphans a render you
have already paid for. Re-running the same command re-attaches to the pending job
and keeps polling it instead of submitting and billing a second one.

```bash
venice-video queue              # renders Venice still has in flight
venice-video queue prune        # forget records too old for Venice to still hold
venice-video queue clear <id>   # forget one record (does not refund it)
```

The shell reports stranded renders in its banner on startup. Note the split:
`queue` is Venice's side of the work (real money, survives restarts), while
`/jobs` is only the background commands of the current session.

For server environments, prefer `VENICE_API_KEY` instead of writing a user
configuration file. Credential precedence is environment variable, then stored
user configuration, then the repository `.env` compatibility path.

The setup command stores the key in a user-only configuration file, not the OS
keychain. On macOS and Linux the file mode is `0600`. Use an environment variable
or an external secrets manager where file-based storage is not appropriate.

### Repository development

```bash
npm install
npm run build
npm test
npm run test:legacy
npm run dev -- <command>
```

The repository still includes agent orchestration in `AGENTS.md` and `.agents/`.
Those layers can operate the same execution engine, but the installed
`venice-video` command does not depend on them.

### Programmatic Usage

```typescript
import { VeniceClient, generateVideo, quoteVideo, listVideoModels } from 'venice-video-harness';

const client = new VeniceClient();

// Get a cost estimate
const quote = await quoteVideo(client, {
  model: 'kling-v3-pro-image-to-video',
  duration: '8s',
  audio: true,
});
console.log(`Estimated cost: $${quote.quote}`);

// Generate a video
const result = await generateVideo(client, {
  model: 'kling-v3-pro-image-to-video',
  prompt: 'A slow dolly shot pushes forward...',
  duration: '8s',
  imageUrl: 'data:image/png;base64,...',
  audio: true,
  outputPath: 'output/shot-001.mp4',
});

// Query model capabilities
const longModels = listVideoModels({ minDurationSec: 20 });
const refModels = listVideoModels({ supportsElements: true });
```

## Video Model Routing

The harness defaults are opinionated because consistency is the point:

**Seedance 2.0 R2V Enhanced for ALL lanes (reference-first, 2026-07-30). Kling O3 R2V fallback only when characters overflow the 9-reference budget.**

Every shot renders in **pure reference mode** — no start image — from an ordered `@ImageN` reference stack of up to 9 images: one primary angle per character, the scene beat's composed **storyboard blocking plate** (where the characters stand in the location relative to each other), multiple location angles (wide/medium/detail), and second character angles. Overflow drops second character angles first, then extra location angles; blocking plates are protected. Voice-donor clips ride alongside as `reference_audio_urls` (`@AudioN`) so each character's voice stays right take to take.

| Role | Default Model | When Used |
|------|--------------|-----------|
| **Character shots (up to ~6 characters)** | `seedance-2-0-enhanced-reference-to-video` | Default R2V — up to 9 `reference_image_urls` with `@Image` tags (chars + blocking plate + location angles), 1080p, up to 15s, native stereo audio |
| **Character shots (budget overflow)** | `kling-o3-standard-reference-to-video` | Auto-fallback — structured `elements` for multi-character identity |
| **Establishing / mood / action** | `seedance-2-0-enhanced-reference-to-video` | Anchors to location reference angles via `@Image` tags |
| **Multi-shot units (2+ grouped beats)** | `seedance-2-0-enhanced-reference-to-video` | Default since 2026-08-05 — ONE native multi-shot generation with `Lens switch.` separators, pure reference mode from the full slot plan. The old default `kling-o3-pro-image-to-video` (no reference support at all) is an explicit `videoDefaults.multiShotModel` override only |

These defaults are overridable per-project via `series.json` → `videoDefaults`. To target a non-Seedance family (e.g. for accounts that lack Seedance access, or projects that need a different look), set `videoDefaults` to `kling-o3-standard-reference-to-video` (character consistency) and `veo3.1-fast-image-to-video` (atmosphere). Image models default to `nano-banana-2` / `nano-banana-2-edit` for all panels regardless of video family.

### Picking a family at project creation

`venice-video new` asks which family to use, and `venice-video new-series` asks too when it's run on a terminal without `--video-family`. Both write the answer to `series.json` → `videoDefaults.videoFamilyPreference` and swap the action / atmosphere / character-consistency models to match. The wizard orders the families as Automatic, Seedance, Wan 3.0, MiniMax H3, MiniMax H3 Max, MiniMax H3 Max Turbo, HappyHorse, Grok Imagine, then Kling O3.

### Choosing dialogue audio

- **Native dialogue** keeps the shot on the selected video family. Seedance and HappyHorse attach each character's short voice-donor clip through `reference_audio_urls`, then generate the authored line in-frame with that voice identity.
- **Exact lip-sync** renders the exact line with Venice speech and passes that file to the video model as `audio_url`, so the character's mouth follows the recording.
- **Narrator voice-over** keeps spoken narration out of the video prompt and mixes Venice speech over the picture in post.

A voice-donor reference preserves timbre, accent, and pacing; it is not the exact dialogue recording. The two are separate API capabilities and separate strategies — a project only renders TTS up front when it explicitly selects exact lip-sync.

Which model handles exact lip-sync depends on the family, because only some lanes accept an audio file:

| Family | Lip-sync route | Cost per shot |
|--------|----------------|---------------|
| `seedance`, `auto` | In-family on `seedance-2-0-enhanced-reference-to-video`, which accepts a top-level `audio_url` | One render — the reference stack already anchors identity |
| `minimax-h3` | In-family on `minimax-h3-reference-to-video`, the one H3 lane with `audio_input` | One render |
| `happyhorse`, `wan-3-0`, `grok-imagine`, `kling-o3` | Out to `wan-2-7-image-to-video` | Two renders (~$0.85) — Wan 2.7 i2v takes no reference images, so a Seedance R2V pass supplies its keyframe first. See AGENTS.md rule 32 |

Override the choice per project with `series.json` → `videoDefaults.lipSyncModel`.

| Family | Picks | Trade-off |
|--------|-------|-----------|
| `seedance` | Seedance 2.0 Enhanced R2V for all three lanes | The default. Strongest identity anchoring, 720p drafts, 4-15s. |
| `wan-3-0` | Wan 3.0 i2v (action/atmosphere) + Wan 3.0 R2V (identity) | The only family that renders past 15s: 5-30s at 480p/720p/1080p, native audio always on, 9-image reference stack. Takes no audio input, so exact lip-sync leaves the family. |
| `minimax-h3` | H3 i2v (action/atmosphere) + H3 R2V (identity) | 2K with native stereo audio at ~1/3 the per-second cost. But 2K is the only resolution, so there's no cheap draft pass, and the 5s floor means 3-4s beats have to be re-scripted. |
| `happyhorse` | HappyHorse 1.1 i2v + R2V | Best native lip-sync (7 languages, phoneme-level), 3-15s, 720p/1080p. |
| `grok-imagine` | Grok Imagine i2v + R2V | Atmosphere-forward look; R2V durations stepped at 5s/8s/10s. |
| `kling-o3` | Kling O3 Standard i2v + R2V | Stylized and illustrated aesthetics; `elements` + `scene_image_urls`. |
| `auto` | Whatever the harness currently defaults to | Tracks the default as it moves; Seedance Enhanced today. |

Non-interactive callers (the MCP, CI) pass `--video-family` explicitly; when it's omitted without a TTY the harness defaults stay in place.

## Image / Video Family Pairing

**Venice removed the Seedance seedream-only face restriction (2026-07).** Seedance 2.0 previously rejected face-bearing input images that weren't produced by `seedream-v5-lite` / `seedream-v5-lite-edit`; it now accepts face-bearing images from **any** image family. The harness therefore uses a single high-quality default for every panel — character-bearing or faceless, generation or multi-edit:

| Image Role | Default | Why |
|------------|---------|-----|
| Character reference sheets | `nano-banana-2` | Any family works — no seedream requirement |
| Character-bearing panels | `nano-banana-2` | Any family works — no seedream requirement |
| Character fix via multi-edit | `nano-banana-2-edit` | Any family works |
| Atmosphere / establishing panels | `nano-banana-2` (configurable) | `gpt-image-2` / `nano-banana-pro` are high-quality alternatives |
| Style-match multi-edit (no characters) | `nano-banana-2-edit` (configurable) | `gpt-image-2-edit` is a high-quality alternative |

Defaults are configurable per-project under `series.json`:

```json
{
  "videoDefaults": {
    "actionModel": "seedance-2-0-enhanced-reference-to-video",
    "atmosphereModel": "seedance-2-0-enhanced-reference-to-video",
    "characterConsistencyModel": "seedance-2-0-enhanced-reference-to-video",
    "imageDefaults": {
      "generationModel": "nano-banana-2",
      "editModel": "nano-banana-2-edit"
    }
  }
}
```

### Seedance Pre-flight Gate (neutralized)

The former provenance-driven pre-flight gate is a **no-op** as of 2026-07. Because Seedance accepts any image family, there is nothing to validate, reroute, or launder before a Seedance call — `ensureSeedanceCompatibility()` always proceeds and `videoDefaults.seedanceCompatibility` is no longer auto-set (an explicit value is read but does nothing meaningful). Provenance sidecars (`shot-NNN.provenance.json`) are still written as metadata for other tooling but nothing gates on them. (The separate Seedance face **consent** attestation, HTTP 409 `needs_consent`, is unrelated and still handled at queue time.)

The sidecar shape:

```json
{
  "generationModel": "nano-banana-2",
  "editModels": ["nano-banana-2-edit"],
  "hasFace": true,
  "createdAt": "...",
  "updatedAt": "..."
}
```

Provenance sidecars are written automatically by the storyboard assembler, panel-fixer, reference-manager, and the mini-drama panel generator. Images without a sidecar (e.g. files from before this change) are treated as "unknown" and will trigger the pre-flight gate. If you know an existing image has no face, hand-edit its sidecar to add `"hasFace": false` and the gate will pass.

If you want to skip the pre-flight entirely, target a non-Seedance video model (e.g. switch `videoDefaults` to Kling O3 + Veo).

## Reference Implementation

The `src/mini-drama/` directory contains a full working implementation for narrative mini-drama production. Use it directly or adapt the patterns for your own format:

- Series/character/episode management
- Script workshopping via LLM
- Two-pass storyboard generation (generate + multi-edit refine)
- Vision-based QA
- Video generation with frame chaining
- Audio post-production with layered ambient beds
- Subtitle burn-in and final assembly

## Editing Pipeline

Parallel to the generation pipeline. The generation side **synthesizes** new shots from prompts; the editing side **cuts** already-existing media (Venice-generated shots or real raw footage). They share ffmpeg and the burn-in-subtitles skill but are otherwise independent.

Inspired by [browser-use/video-use](https://github.com/browser-use/video-use), the pipeline is text-first: the LLM reads a compact `takes_packed.md` (~12KB per 40 min of audio) rather than frame-dumping video. Composite PNGs are only consulted at explicit decision points — comparing retakes, disambiguating a pause, verifying post-render QA.

### When to reach for editing vs generation

| Task | Pipeline | Entry |
|------|----------|-------|
| Synthesize new shots from prompts | Generation | `/produce-episode`, `/generate-episode-videos` |
| Re-cut a generated episode for pacing | Editing | `/edit-footage` |
| Trim filler words from a VO take | Editing | `/edit-footage` |
| Edit raw user-supplied footage | Editing | `/edit-footage` |
| Rescue a truncated TTS VO (rule 26) | Editing | `/edit-footage` |
| Add branded lower-thirds / title cards | Editing | `overlay-designer` agent |
| Post-assembly QA on any rendered video | Editing | `cut-qa` agent |

### The five steps

1. **Transcribe** via local whisper.cpp → per-source `*.words.json` + `takes_packed.md`
2. **Read pack** — LLM forms a cut strategy from text alone
3. **Confirm** — propose strategy to user, wait for "yes / revise / cancel"
4. **Render EDL** — JSON cut list → ffmpeg concat with 30ms audio fades (archive-first)
5. **Self-eval** — `cut-qa` agent runs 6 programmatic checks at every cut boundary; max 3 fix iterations

### Required tooling

- `whisper-cpp` on PATH (`brew install whisper-cpp`)
- A whisper.cpp model, e.g.:
  ```bash
  mkdir -p ~/.cache/whisper.cpp
  curl -L -o ~/.cache/whisper.cpp/ggml-base.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  ```
- `sharp` npm dep (bundled) for the `timeline-view` composite
- `ffmpeg` + `ffprobe` (already required by the generation pipeline)

### cut-qa checks

Runs automatically after every assembly or edit render. Each check produces zero or more `CutQaFinding` entries:

| Check | Kind | Typical severity |
|-------|------|------------------|
| Aspect regression vs `series.storyboardAspectRatio` | `aspect-regression` | `fail` |
| Frame-hash jump across a cut | `visual-jump` | `warn` (or `fail` if inside a word) |
| VO truncation vs ground-truth script | `vo-truncation` | `fail` |
| Mean-luma delta across a cut in the same location | `lighting-discontinuity` | `warn` |
| Audio peak > -6 dBFS within cut boundary | `audio-pop` | `fail` |
| Caption overlap with in-frame text | `subtitle-overlap` | `warn` |

Hard cap at 3 fix iterations before surfacing to the user with the persisting findings and the fixes that were attempted.

### Overlay pipeline

Branded motion graphics (lower-thirds, title cards, chapter markers, logo bugs) are a post-process on top of the delivered cut — never baked into the EDL render. The `overlay-designer` agent plans the overlays, spawns Remotion / ffmpeg workers in parallel, and composites via `scripts/render-overlay.ts`.

Venice-logo safety rules (AGENTS.md rule 17, anti-pattern #11) are enforced at manifest validation time — manifests that contain "VVV" / "triple-V" or pass mostly-transparent PNGs are rejected before rendering.

### Editing pipeline commands

```bash
# Transcribe a folder of sources into a pack + per-source words.json
npx tsx scripts/transcribe-sources.ts \
  --dir output/<project>/shots \
  --out output/<project>/edit/takes_packed.md \
  --model base.en

# Align against a ground-truth TTS script (detects VO truncation)
npx tsx scripts/transcribe-sources.ts \
  --dir output/<project>/audio \
  --out output/<project>/edit/takes_packed.md \
  --aligned-from scripts/<project>/config.ts

# Inspect a specific time range as a composite PNG
npx tsx scripts/timeline-view.ts \
  --video output/<project>/final.mp4 \
  --start 12.3 --end 16.1 \
  --words output/<project>/edit/final.words.json \
  --out /tmp/tl.png

# Composite overlays onto a delivered cut
npx tsx scripts/render-overlay.ts \
  --manifest output/<project>/overlays/manifest.json
```

See [`.agents/skills/video-editing/SKILL.md`](.agents/skills/video-editing/SKILL.md) for the full philosophy, EDL format, and editing-specific anti-patterns.

## Timeline Export (NLE round-trip)

After an episode is rendered, the harness can export the assembled timeline as an XML file that imports into your editor of choice. Every video segment, dialogue clip, SFX clip, and music cue lands on its own track so you can fine-tune cuts, audio balance, and color in the NLE instead of editing the assembler's ffmpeg filter graph.

```bash
# Final Cut Pro X (FCPXML 1.10) — the original  path
mini-drama export-timeline -p output/<project> -e 1 --format fcpxml

# Adobe Premiere Pro (Final Cut Pro 7 XML / xmeml v5)
mini-drama export-timeline -p output/<project> -e 1 --format premiere

# DaVinci Resolve (Resolve-tuned FCPXML 1.10)
mini-drama export-timeline -p output/<project> -e 1 --format davinci
```

Output filename mirrors the format:

| Format | File | Import path |
|--------|------|-------------|
| `fcpxml`   | `episode-NNN.fcpxml`         | FCP X → File → Import → XML… |
| `premiere` | `episode-NNN.premiere.xml`   | Premiere → File → Import… |
| `davinci`  | `episode-NNN.resolve.fcpxml` | Resolve → File → Import → Timeline… |

Lane layout (same across formats):

- Primary video track — every rendered shot in spine order, segment audio muted (-96 dB)
- Lane −1 (dialogue) — one clip per shot from `audio/dialogue-shot-NNN.mp3`
- Lane −2 (SFX) — one clip per `audio/sfx/*.mp3` matched to its shot
- Lane −3 (music) — `audio/music.mp3` spanning the full sequence

The `export-fcpxml` command from  is kept as a thin alias of `export-timeline --format fcpxml` for back-compat.

**NLE XML implementations vary by editor version.** If your editor refuses the import, or any clip lands on the wrong track or wrong timecode, please [open a GitHub Issue](https://github.com/jordanurbs/venice-video-harness/issues/new) with:

- editor name + exact version
- the format you exported (`fcpxml` / `premiere` / `davinci`)
- the generated XML file attached (or relevant snippet)
- what FCP X / Premiere / Resolve reported

Bug reports are how we'll catch the gaps — the test fixture confirms structure, but it can't substitute for real NLE import paths.

## Commands, Agents, and Skills

### Workflow Commands (`.agents/commands/`)

| Command | Purpose |
|---------|---------|
| `new-series` | Create a new series with locked aesthetics |
| `add-character` | Add a character with reference images |
| `lock-character` | Lock a character's voice (add `--voice-reference <file>` to import a voice-donor clip) |
| `lock-characters` | Batch voice locking |
| `generate-voice-reference` | Generate/import a character voice-donor clip (`reference_audio_urls` / @AudioN, Seedance & HappyHorse R2V) |
| `add-location` | Add a location with generated reference images (wide / medium / detail) |
| `generate-location-references` | Regenerate a location's reference images |
| `set-aesthetic` | Set or derive series aesthetic |
| `explore-aesthetic` | Generate aesthetic comparison samples |
| `workshop-episode` | Collaborative episode scripting |
| `storyboard-episode` | Storyboard one episode |
| `storyboard-scene` | Storyboard a single scene |
| `storyboard-all` | Storyboard all scenes |
| `fix-panel` | Fix a panel with multi-edit |
| `qa-storyboard` | Visual QA on panels |
| `generate-episode-videos` | Generate episode videos from panels |
| `generate-videos` | General video generation |
| `assemble-episode` | Final assembly with audio and subtitles |
| `produce-episode` | Full pipeline in one command |
| `audition-voices` | TTS voice auditions |
| `generate-trailer` | Full trailer pipeline |
| `ingest-screenplay` | Ingest Fountain/PDF screenplay |
| `edit-footage` | Text-first editing pipeline for existing media (cuts, trims, re-orders) |

### Specialized Agents (`.agents/agents/`)

| Agent | Role |
|-------|------|
| `art-director` | Aesthetic decisions, palette, lighting, composition |
| `prompt-engineer` | Venice image prompts, character consistency |
| `screenplay-reader` | Fountain/PDF parsing and scene extraction |
| `storyboard-assembler` | HTML storyboard viewer assembly |
| `storyboard-qa` | Panel QA for continuity and character checks |
| `trailer-curator` | Trailer shot selection and anti-spoiler rules |
| `cut-qa` | Post-render quality gate — 6 checks at every cut boundary, max 3 fix iterations |
| `overlay-designer` | Plans branded motion graphics; spawns Remotion / ffmpeg overlay workers in parallel |
| `remotion-overlay` | Renders one animated overlay as transparent ProRes / WebM |
| `ffmpeg-overlay` | Emits drawtext specs for static overlays |

### Production Skills (`.agents/skills/`)

| Skill | Purpose |
|-------|---------|
| `venice-api` | Venice REST API usage and defaults |
| `venice-video-model-routing` | R2V-first model routing, decision trees, scripts |
| `character-consistency` | Multi-shot character consistency guidance |
| `shot-composition` | Shot composition and camera guidance |
| `screenplay-parsing` | Screenplay parsing workflows |
| `venice-ui-production` | Manual Venice web UI prompt guides |
| `video-editing` | Text-first editing philosophy, EDL format, cut-qa loop (inspired by browser-use/video-use) |

### Directing layer (optional): Seedance 2.0 Skill OS

The harness is the *production crew* — it locks identity, routes models, QA's panels, mixes audio, and assembles. It does not, by itself, make a shot feel **directed**. The [**Seedance 2.0 Skill OS**](https://github.com/emily2040/seedance-2.0) supplies that missing brain: pure directing/prompting knowledge (no execution code) built on one principle — **direct the scene, don't decorate it.** Read the beat's dramatic function, name one intention, and derive camera, light, blocking, performance, and sound from it instead of stacking "cinematic" adjectives; hold one directorial voice across the whole story. Venice ships **Seedance 2.0 (+ Fast)** as a video model family, so the directing knowledge applies almost verbatim.

This principle is already baked into the harness where it matters:

- The **workshop system prompt** (`src/mini-drama/cli.ts`) carries a "DIRECT THE SCENE, DON'T DECORATE IT" block, so both the CLI and the `venice-video-mcp` `episode.workshop` produce directed scripts.
- `.agents/agents/prompt-engineer.md`, `.agents/skills/shot-composition/SKILL.md`, and `.agents/commands/workshop-episode.md` open with the same directing preface for agent-in-repo sessions.
- The `buildVideoPrompt` builders document the principle so future prompt logic stays directed.

Install Seedance OS to unlock its full `directing-engine`, genre library, `retake-protocol`, `continuation-handoff`, `seedance-copyright`, `seedance-antislop`, and multilingual `vocab/*`:

```bash
# Clone the repo (its root is shaped as the seedance-20 skill) into the skills dir:
git clone https://github.com/emily2040/seedance-2.0 .agents/skills/seedance-20
```

**Division of labor to respect:** the harness owns identity (R2V refs + Seedance → Wan keyframe pass), durations (the pre-flight gate + 15s default), and model routing. So use Seedance OS for **intention/camera/light/blocking/performance/sound** only — do not hand-write identity locks, `[Image1]` reference tags, or surface-specific durations into prompts. Skip Seedance OS's `api-status.md` / `surface-prompt-profiles.md` / `api-workflow.md` / `model-name-map.md` (those describe non-Venice surfaces). The `venice-video-mcp` repo's `venice-mcp-directing` skill is the matching bridge for MCP-driven work.

## Production Anti-Patterns

The harness documents 13 production anti-patterns learned from real shoots in `AGENTS.md`. These cover:

- Multi-shot grouping bugs (wrong character overlap checks)
- Character reference style drift across angles
- Duration validation failures per model
- R2V aspect ratio defaults causing portrait-mode bugs
- Multi-edit cropping foreheads on close-up panels
- Lighting inconsistency between consecutive shots
- Logo/sigil prompt mismatches
- Seedance 2.0's former seedream-only face-image restriction (removed by Venice 2026-07; gate now neutralized)
- And more

See `AGENTS.md` > "Learned Anti-Patterns" for the full list with root causes and fixes.

## API Coverage

| Venice Endpoint | Status | Module |
|----------------|--------|--------|
| `POST /image/generate` | Full | `generate.ts` |
| `POST /image/multi-edit` | Full | `multi-edit.ts` |
| `POST /image/upscale` | Full | `edit.ts` |
| `POST /image/background-remove` | Full | `edit.ts` |
| `POST /video/queue` | Full | `video.ts` |
| `POST /video/retrieve` | Full | `video.ts` |
| `POST /video/quote` | Full | `video.ts` |
| `POST /video/complete` | Full | `video.ts` |
| `POST /audio/speech` | Full | `audio.ts` |
| `POST /audio/queue` | Full | `audio.ts` |
| `POST /audio/retrieve` | Full | `audio.ts` |
| `POST /audio/complete` | Full | `audio.ts` |
| `POST /chat/completions` | Partial | `client.ts` (vision) |
| `POST /images/edit` | Deprecated | `edit.ts` |

## Credits and Acknowledgments

The editing pipeline (text-first transcripts, on-demand timeline composites, EDL + self-eval loop, parallel overlay sub-agents) is directly inspired by [**browser-use/video-use**](https://github.com/browser-use/video-use) — a 100% open source agentic video editor for Claude Code. Their core insight — *"the LLM never watches the video, it reads it"* via word-level transcripts plus on-demand filmstrip+waveform composites — is what makes agent-driven editing actually work instead of drowning in frame-dump tokens.

Key patterns borrowed and adapted for this harness:

- The `takes_packed.md` format and compact per-take phrase blocks
- The timeline-view composite (filmstrip + waveform + word labels + silence-gap markers)
- 30ms audio fades at every cut boundary to prevent pops
- Self-evaluating QA loop at cut boundaries, max 3 fix iterations
- Session persistence (`project.md` → our `session.json`) for cross-session memory
- Parallel sub-agent spawning for overlay / animation rendering
- The "ask → confirm strategy → execute → self-eval → persist" design principle

Differences in this port:

- Uses local **whisper.cpp** instead of ElevenLabs Scribe (no new API keys required; loses diarization out of the box — we inject speaker labels from the shot script for generated content instead)
- Ground-truth script alignment mode via LCS matching, with automatic VO-truncation detection (rule 26 rescue)
- Integrated with Venice's generation pipeline: shared provenance sidecars, shared ffmpeg primitives, shared burn-in-subtitles skill
- TypeScript (Node) rather than Python, to stay consistent with the rest of the harness

Go give [browser-use/video-use](https://github.com/browser-use/video-use) a star. It's a clean, opinionated reference for text-first video editing and it's the right shape for this kind of tool.

## License

MIT
