# Venice Video Harness

Agent-first, Venice-optimized tooling for consistency-first video creation.

This harness is built for creators who want an IDE agent such as Claude Code to operate a reusable Venice production system for:
- character-consistent video projects
- visual-style-locked series or campaigns
- storyboard-to-video workflows
- short-form narrative, branded, trailer, social, or cinematic sequences
- repeated generation where continuity matters more than one-off novelty

## What This Is

Most Venice integrations are thin wrappers around API calls. This harness is the higher-level layer on top:
- orchestration rules in `CLAUDE.md`
- reusable playbooks in `.claude/commands/`
- specialized agents in `.claude/agents/`
- reusable Venice skills in `.claude/skills/`
- TypeScript execution code underneath in `src/`

The goal is not just "generate a clip." The goal is to help an agent consistently plan, generate, refine, QA, and assemble visually coherent video work.

## What It Can Be Used For

This rig is intended to be adapted for projects like:
- episodic fiction
- trailers and teasers
- branded cinematic sequences
- recurring-character social series
- narrative explainers
- style-locked creative campaigns
- any Venice workflow where image-to-video consistency matters

## Included Reference Implementation

This repository ships with a working reference implementation for narrative mini-drama production inside:

```text
src/mini-drama/
```

That reference pipeline includes series, characters, episodes, storyboard generation, QA, video generation, audio, and assembly.

Use it in one of two ways:
- operate it directly as the included reference implementation
- treat it as the starting harness and adapt the commands, agents, and rules to your own video format

The currently bundled `.claude/commands/` and `src/mini-drama/` workflows are narrative-oriented starter playbooks. They are included because they are a strong reference implementation for consistency-first Venice video work, not because the harness is limited to mini-dramas forever.

## What Makes It Venice-Optimized

- image prompts tuned for Venice image generation
- two-pass panel generation with Venice multi-edit refinement
- model-routing logic for action, atmosphere, and character-consistency tiers
- support for reference-aware Venice video generation
- environment-aware prompt adaptation for daytime vs night scenes
- Venice-native audio generation paths for TTS, SFX, and music

## Preferred Video Models

The harness is opinionated about model choice because consistency is the point:

- `kling-v3-pro-image-to-video` for action, movement, dialogue, and stronger cinematic motion
- `veo3.1-fast-image-to-video` for atmosphere, inserts, establishing shots, and quieter beats
- Kling O3 reference-capable models when identity consistency is critical and reference attachments are worth the extra cost

## Budgeting Note

This harness assumes you want best-of-the-best output quality, not bargain-mode generation.

That means you should budget for:
- repeated image generation and multi-edit passes
- premium video generations
- reference-driven consistency passes
- Venice TTS, SFX, ambience, and music where needed
- iteration cost when refining continuity problems

Treat this as a quality-first production harness and plan API spend accordingly.

## Intended Runtime

This is not a CLI-first end-user app.

It is meant to be operated in an IDE like Cursor or VS Code with an agent such as Claude Code. The user directs the workflow in natural language. The agent reads the project rules, chooses the relevant playbooks, and runs code as needed.

In other words: the CLI and scripts are the execution layer underneath the harness, not the primary product surface.

## Project Structure

```text
CLAUDE.md                    Agent orchestration hub
.claude/commands/            Workflow playbooks
.claude/agents/              Specialized agent roles
.claude/skills/              Venice and workflow knowledge
src/mini-drama/              Reference narrative video implementation
src/venice/                  Venice API client and media helpers
src/storyboard/              Storyboard and legacy helpers
scripts/                     Utility scripts for generation and post-production
output/                      Generated project data (gitignored)
```

## Getting Started In Agent Chat

1. Open the project in Cursor or VS Code.
2. Make sure the agent can read `CLAUDE.md`, `.claude/commands/`, and `.claude/skills/`.
3. Make sure `VENICE_API_KEY` is available via `.env`.
4. Ask the agent to initialize the harness if dependencies are not installed yet.
5. Then direct the agent in natural language.

Good first messages:

- "Set up this Venice video harness for first use"
- "Help me build a consistent character-driven video workflow"
- "Create a reusable Venice pipeline for a branded short-form series"
- "Use the included narrative implementation to start a new project"

If the harness is operating correctly, the agent should:
- read the orchestration rules in `CLAUDE.md`
- select the right playbook from `.claude/commands/`
- load any relevant Venice skill(s)
- install dependencies and run setup steps if needed
- execute the underlying code for you

## Requirements

- Node.js 20+
- `ffmpeg` and `ffprobe` on your PATH
- a `VENICE_API_KEY`

## Setup

Ask the agent to initialize local setup. That setup should include:
- creating `.env` from `.env.example` if needed
- confirming `VENICE_API_KEY` is present
- installing dependencies for the execution layer
- validating the build

The environment file should contain:

```bash
VENICE_API_KEY=your_key_here
```

Typical setup commands the agent may run under the hood:

```bash
npm install
npm run build
```

## Notes

- This harness is intentionally opinionated and Venice-specific
- It is agent-operated first, not terminal-operated first
- The included mini-drama pipeline is a reference implementation, not the only intended use case
- To broaden it for a different format, adapt `CLAUDE.md`, `.claude/commands/`, and the reference workflow in `src/`
