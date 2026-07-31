# Changelog

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
