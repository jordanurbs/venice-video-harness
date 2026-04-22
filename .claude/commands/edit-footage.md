# /edit-footage

End-to-end editing pipeline for existing media. Read the [video-editing skill](../skills/video-editing/SKILL.md) before running this command — it defines the EDL format, the ask-confirm-execute-self-eval loop, and the anti-patterns to avoid.

Scope: cuts, trims, re-orderings, filler-word removal, and delivery of an edited mp4 from sources already on disk. This is NOT the generation pipeline. For synthesizing new shots use `/produce-episode` or `/generate-videos`.

## When To Use

- User brings raw footage (interview takes, phone recordings, screen caps) and wants a cut
- User wants to re-cut a Venice-generated episode without re-rendering shots
- User needs to rescue a truncated TTS VO by editing the working audio
- User asks to trim umms / false-starts from a talking-head take

## Preflight

Confirm before starting:

1. **Source directory** — where are the clips? Typically `output/<project>/shots/` or a user-supplied folder.
2. **Output target** — `output/<project>/edit/final-edit.mp4` by default.
3. **Ground-truth script (if any)** — for TTS-generated content, locate the `VO_TEXT` config so the transcriber can run in aligned mode and flag VO truncation.
4. **Format expectations** — aspect ratio (pull from `series.json` if it exists), target duration, cut style (hard cuts by default; crossfades only if user asks).

If the directory is missing or contains zero matching sources, stop and ask the user for the correct path.

## Step 1 — Transcribe

```bash
npx tsx scripts/transcribe-sources.ts \
  --dir <sources_dir> \
  --out output/<project>/edit/takes_packed.md \
  --model base.en
```

If a ground-truth script exists:

```bash
npx tsx scripts/transcribe-sources.ts \
  --dir <sources_dir> \
  --out output/<project>/edit/takes_packed.md \
  --aligned-from scripts/<project>/config.ts
```

The transcriber writes one `*.words.json` per source plus `takes_packed.md`. Transcription time: ~0.1x realtime for the `base.en` model on an M-series Mac.

If transcription fails with a "whisper-cpp binary not found" or "model not found" error, print the install commands to the user and stop:

```
brew install whisper-cpp
mkdir -p ~/.cache/whisper.cpp
curl -L -o ~/.cache/whisper.cpp/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

## Step 2 — Read The Pack

Read `output/<project>/edit/takes_packed.md` end to end. Identify:

- Best take of each idea (when multiple takes cover the same content)
- Natural silence-gap cut candidates (≥ 0.45s pauses)
- Filler words eligible for trimming (`umm`, `uh`, `you know`, `i mean`)
- Any VO truncation warnings the transcriber flagged (aligned mode)

Only call `timeline-view` at decision points — comparing retakes, disambiguating a pause, checking mouth-close before a cut. Never dump frames without a specific question to answer.

```bash
npx tsx scripts/timeline-view.ts \
  --video <file> \
  --start 12.3 --end 16.1 \
  --words output/<project>/edit/<stem>.words.json \
  --out /tmp/tl.png
```

## Step 3 — Propose Strategy And Wait

Post a summary to the user BEFORE rendering anything. Include:

- **Sources used** (count of clips, which takes)
- **Estimated output duration** (computed via `estimateOutputDurationSec` on the proposed EDL)
- **Trim/filler rules** being applied (e.g. "remove detected umms, preserve Kokoro `...` beats")
- **Transitions** (default all hard cuts — state explicitly if any crossfade is proposed)
- **Color grade** (none by default)
- **Subtitle plan** — always ask yes/no before running `burn-in-subtitles`

Then ask:

> "Proceed with the render? (yes / revise / cancel)"

Do not touch the renderer before the user answers "yes".

## Step 4 — Author The EDL And Render

Build the EDL in TypeScript using the helpers in [`src/editing/edl.ts`](../../src/editing/edl.ts):

```ts
import { createEmptyEdl, addClip, writeEdl } from '../../src/editing/edl.js';

const edl = createEmptyEdl();
addClip(edl, { sourceId: 'C0A31', startSec: 2.52, endSec: 6.74, rationale: 'Hook' });
addClip(edl, { sourceId: 'C0B55', startSec: 0.00, endSec: 4.20 });
addClip(edl, { sourceId: 'C0A31', startSec: 12.30, endSec: 18.90 });

writeEdl(edl, 'output/<project>/edit/edl.json');
```

Render:

```ts
import { readEdl } from '../../src/editing/edl.js';
import { renderEdl } from '../../src/editing/render.js';

const edl = readEdl('output/<project>/edit/edl.json');
const result = renderEdl(edl, takes, {
  outputPath: 'output/<project>/edit/final-edit.mp4',
});
```

`renderEdl` archives any existing output via `-v1`, `-v2`, ... before writing the new file (workspace rule `shot-asset-safety.mdc`).

## Step 5 — Self-Eval Via cut-qa

After the render, run the programmatic checks from [`src/editing/self-eval.ts`](../../src/editing/self-eval.ts) and hand the report to the `cut-qa` agent for interpretation:

```ts
import { runCutQa, summarizeReport, saveSession } from '../../src/editing/self-eval.js';

const report = runCutQa({
  renderedPath: result.outputPath,
  edl,
  takes,
  iteration: session.iterations.length + 1,
  aspectRatio: '16:9',
  groundTruthScript,
  renderedAsrWords,
});

console.error(summarizeReport(report));

session.iterations.push(report);
saveSession(session, 'output/<project>/edit/session.json');
```

Then invoke `.claude/agents/cut-qa.md` with the report. The agent proposes fixes, you apply them to the EDL, and re-render.

**Max 3 iterations.** If the 3rd iteration still has `fail`-severity findings, stop and surface to the user with:

1. The persisting findings
2. The fixes that were attempted
3. A question: "Continue iterating manually, ship with known issues, or pause?"

## Step 6 — Subtitles (If Wanted)

Always ask "Burn in subtitles? (yes / no)" before running the captioning step, per the [burn-in-subtitles skill](../skills/burn-in-subtitles/SKILL.md). If yes:

```bash
npx tsx .claude/skills/burn-in-subtitles/scripts/derive-captions.ts \
  --vo output/<project>/edit/final-edit.mp4 \
  --vo-text-file scripts/<project>/config.ts \
  --vo-delay 0
```

Captions go on top of the final cut via a separate ffmpeg pass — never baked into the EDL render itself.

## Step 7 — Persist And Deliver

At this point `output/<project>/edit/` contains:

- `takes_packed.md` — the agent-readable pack
- `*.words.json` — per-source word timings
- `edl.json` — the final cut list
- `session.json` — iteration history with every cut-qa report
- `final-edit.mp4` — deliverable
- `final-edit-v1.mp4`, `final-edit-v2.mp4`, ... — archived prior renders

Report back to the user with:

- Output file path
- Final duration
- Number of cut-qa iterations required
- Any remaining warnings
- Link to the EDL for review / future revisions

## Never

- Never delete a source file mid-session (workspace rule).
- Never overwrite `final-edit.mp4` without archiving first. `renderEdl` does this automatically; don't work around it.
- Never auto-trim filler words without user approval — "you know" can be content-bearing for some speakers.
- Never render without running step 3 first. Rendering before confirming a strategy is how sessions go sideways.
- Never ship a cut with unresolved `fail`-severity cut-qa findings without explicit user consent.

## See Also

- [`.claude/skills/video-editing/SKILL.md`](../skills/video-editing/SKILL.md) — the full philosophy and rules
- [`.claude/skills/burn-in-subtitles/SKILL.md`](../skills/burn-in-subtitles/SKILL.md) — caption derivation
- [`.claude/agents/cut-qa.md`](../agents/cut-qa.md) — the QA agent invoked in step 5
- [`src/editing/types.ts`](../../src/editing/types.ts) — EDL, Take, Session type definitions
- `CLAUDE.md` rule 26 — VO truncation cause and cure
