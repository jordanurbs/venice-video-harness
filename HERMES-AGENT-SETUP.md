# Setting up the Venice video harness on Hermes (existing / old install)

For a Hermes user who already has an **old** `venice-video` (e.g. a stale global
`2.6.0`) and wants to re-set-up and use it properly with the published packages.

It upgrades the stale global, adds the MCP server (which almost certainly was
never installed, since it wasn't on npm before), wires the companion skills, and
makes the agent read the operating rules before it touches the gated pipeline.

## The prompt to paste into Hermes

```
Set up the Venice video harness fresh and confirm it works, in this order:

1. Install both packages globally at their latest versions:
   npm install -g venice-video-harness@latest venice-video-mcp@latest
   Then confirm the upgrade actually landed: `venice-video --version` must
   report 2.11.x (an old global like 2.6.0 means the PATH copy didn't update —
   fix PATH or the npm prefix before continuing).

2. Check the environment: `venice-video doctor` (it verifies the Venice API
   key, ffmpeg, and ffprobe). If it complains about the key, run
   `venice-video setup`. Set a workspace you own:
   export VENICE_VIDEO_WORKSPACE=~/VeniceVideos

3. Register the MCP server by its published bin (no clone, no absolute paths):
   hermes mcp add venice-video --command venice-video-mcp
   Make sure the server's env has VENICE_API_KEY and HARNESS_WORKSPACE set,
   then: hermes mcp test venice-video  (must handshake and list 7 tools).

4. Install the companion skills into Hermes:
   venice-video-mcp-install-skills --target hermes

5. Before running any workflow, read the operating rules — the pipeline is
   gated and some stages spend money at queue time:
   venice-video agent-guide
   venice-video pipeline --json
   and read AGENTS.md at "$(npm root -g)/venice-video-harness/AGENTS.md".

Report the version, doctor result, the MCP tool list, and confirm the skills
are installed.
```

## Two things to know (the failure modes that make it look broken)

- **The only values you must supply are real:** your Venice API key, and a
  workspace path you own for `HARNESS_WORKSPACE`. Everything else is defaulted.
- **If `venice-video --version` still shows the old number after step 1**, npm
  installed into a different prefix than the `venice-video` on your `PATH`
  (common with node version managers). The harness README's "Version-drift
  check" and `venice-video update` both handle this; the quickest tell is
  comparing `command -v venice-video` against `npm prefix -g`.

After this, you drive it in plain language through Hermes (the MCP tools), or the
agent runs the CLI directly — either way it now has the embedded `agent-guide`,
the shipped `AGENTS.md`, and the Hermes skills, instead of guessing from `--help`.
