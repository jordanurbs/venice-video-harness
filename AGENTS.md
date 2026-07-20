# Venice Video Harness

THE cinematic AI-video harness (character lock, multi-shot, vision QA). CLAUDE.md holds the full agent rules — read it. Shared VENICE_API_KEY in .env is sourced by ~17 scripts across the workspace: do not move or rename .env.

**This repo is part of the `~/projects` workspace.** When working here standalone,
these workspace rules still apply (full router: `~/projects/AGENTS.md`):

- **On-brand always** — `~/projects/venice-brand/DESIGN.md`. No red; Venetian Blue accent-only; sentence case.
- **API-correct always** — load `~/projects/venice-skills/skills/<name>/SKILL.md` before any Venice API claim.
- **Videos are reuse-first** — check the shared library first: `node ~/projects/tools/arsenale/scripts/library-cli.mjs find <terms>`.
- **Never `rm -rf` a project dir** — move to `~/projects/archive/` instead; verify moves landed before touching sources.
