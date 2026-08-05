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
- Prefer native model dialogue (Seedance 2.0, HappyHorse 1.1 with voice-donor references) over exact TTS lip-sync.

## Where the full knowledge lives
- `AGENTS.md` — 47 rules and 27 production anti-patterns, shipped in the package.
- `.claude/skills/` — `venice-api`, `venice-video-model-routing`, `character-consistency`, `shot-composition`, `burn-in-subtitles`, `video-editing`, and more.
- `.claude/commands/` — 20 step-by-step playbooks; `.claude/agents/` — 10 sub-agent roles.
- Read the relevant playbook before running a workflow. Validate model capabilities against `src/venice/models.ts` before an API call.
