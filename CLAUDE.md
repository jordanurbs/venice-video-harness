# Venice Video Harness

This workspace is an agent-first, Venice-optimized harness for consistent video creation.

It is meant to be operated through natural language in an IDE like Cursor or VS Code with an agent such as Claude Code. The user should not be asked to run terminal commands manually. The agent reads the rules, selects the right playbooks, and executes code as needed.

## What This Harness Does

1. Helps an agent plan and execute consistency-first Venice video workflows
2. Supports recurring characters, locked visual systems, and reference-driven generation
3. Provides reusable orchestration through `CLAUDE.md`, `.claude/commands/`, `.claude/agents/`, and `.claude/skills/`
4. Includes a working narrative reference implementation in `src/mini-drama/`
5. Preserves generated media by archiving instead of destructively replacing where possible

## How To Operate

The intended interface is:
- natural-language requests to the agent
- orchestration rules in `CLAUDE.md`
- workflow playbooks in `.claude/commands/`
- reusable Venice knowledge in `.claude/skills/`
- underlying TypeScript and script execution in `src/` and `scripts/`

The CLI and scripts are the execution layer underneath the harness, not the primary user interface.

## Included Reference Implementation

This repository includes a narrative video reference pipeline in:

```text
src/mini-drama/
```

That implementation is useful out of the box for story-driven, character-consistent video work, but the harness itself is broader than that specific use case. Adapt the commands, rules, and prompts for other formats such as trailers, branded short-form, campaign sequences, explainers, or recurring social series.

## Default Venice Routing

Preferred defaults in the bundled implementation:
- `kling-v3-pro-image-to-video` for action and stronger motion
- `veo3.1-fast-image-to-video` for atmosphere and quieter beats
- reference-capable Kling O3 models when character consistency is worth the extra cost
- `nano-banana-2` as the default image generation model unless explicitly overridden

## Budgeting

This harness is quality-first, not bargain-first.

When planning runs, account for:
- image generation
- multi-edit refinement
- video generation
- Venice TTS, SFX, ambience, and music
- re-renders needed to fix continuity issues

## Agent Rules

1. Never ask the user to run terminal commands manually.
2. Treat the user’s natural-language request as the primary interface.
3. Read the relevant command/playbook before executing a workflow.
4. Prefer reusable harness patterns over one-off hacks when updating the repo.
5. Preserve generated shot assets by archiving prior versions instead of deleting them.
6. Keep secrets out of source control. `output/`, `.env`, and other local-only artifacts stay local.
7. Be honest about what is generic harness logic versus what belongs only to the bundled narrative reference implementation.

## Recommended Workflow Pattern

For any new use case, the agent should:
1. Identify the project format and continuity requirements
2. Decide whether the bundled `src/mini-drama/` implementation fits directly or should be adapted
3. Use the command playbooks and skills as the operational layer
4. Run the underlying code only when needed to produce assets
5. Validate output quality before moving deeper into expensive generations

## Output

Generated project output belongs in:

```text
output/
```

No active generated projects are included in this harness copy.

## Important

- This is an agent-operated harness first, not a CLI-first app
- It is Venice-specific and consistency-focused by design
- The included mini-drama workflow is a reference implementation, not the only intended use case
