---
name: burn-in-subtitles
description: This skill should be used whenever a video harness pipeline produces a voice-over (VO) track and the agent is about to assemble a final video — the agent MUST first ask the user whether to burn in subtitles. When subtitles are wanted, this skill provides the end-to-end captioning process: VO authoring rules that don't break Kokoro/ElevenLabs TTS, an automated silence-detection workflow that derives caption timings from the rendered VO instead of guessing, ffmpeg drawtext rendering for soft burned-in captions, and a verification step that proves sync before delivery. Includes an executable helper script `derive-captions.ts` that turns a measured VO into a drop-in `CAPTIONS` TypeScript array. Applicable to any harness project that mixes a TTS VO under video and assembles via ffmpeg.
metadata:
  requires:
    bins: ["ffmpeg", "ffprobe", "node", "tsx"]
---

# Burn-in Subtitles for Voice-over Trailers

Produce burned-in subtitles ("hardcoded" / "open" captions) on a finished trailer when the user wants them, with timings derived from the actual rendered VO instead of estimated by hand. This skill captures the full process — including the failure modes that sent us into a multi-revision drift loop on `The Grand Plutonian` teaser — so the next project gets working captions on the first attempt.

## Operating Rule (Mandatory)

**Always ask the user before adding subtitles.** Burn-in is a permanent baked-into-pixels decision and is not always wanted (cinema teasers may prefer no captions; social cuts almost always need them).

The first time you assemble a final video for a project, ask:

> "Do you want subtitles burned into the trailer?
> (a) Yes — soft and small at the bottom, baked into the video
> (b) No subtitles — VO carries the meaning"

Do not assume "yes" because the trailer has dialogue / VO. Do not assume "no" because it's a cinematic teaser. Only proceed when the user has said yes.

If yes, also ask follow-ups:
- Subtitle font size? (default 36-38px on a 720p canvas)
- Position? (default bottom, 50px margin)
- Opacity? (default 0.85 — soft, not harsh white)

## When This Skill Applies

- A harness project has produced a VO file (typically `output/<project>/audio/vo.mp3`).
- The harness assembles a final video via ffmpeg `drawtext`/`subtitles` filters or similar.
- The user has answered "yes" to the burn-in prompt above.
- The VO was produced by a TTS engine (Kokoro, ElevenLabs, Qwen3) — synthesized voices with deterministic phrasing.

## End-to-End Process

### 1. Author the VO with TTS-Safe Phrasing

The single most common failure with Kokoro and ElevenLabs is unstable phrasing causing TRUNCATION or RUNAWAY pauses. Follow these rules:

| Do | Don't |
|---|---|
| Use single ellipses `...` for breath gaps | Use doubled ellipses `......` (Kokoro silently truncates after them) |
| Use commas for short rhythm pauses | Use repeated periods `..` to fake a pause |
| Use `, ` between phrases for soft breaks | Use long stretches of dots inside a sentence |
| Write each phrase as its own line in a `VO_TEXT` array, joined with spaces | Concatenate everything into one giant string |
| Test with a single regen first to measure duration | Tune captions before measuring the actual VO |

**Confirmed failure case:** The VO `"This winter,......a film about being inflated......off the planet."` (with doubled ellipses) caused Kokoro `bm_george` to render only `"This winter,"` and end the file. The remaining 9 words were silently dropped. The fix was rewriting to single ellipses: `"This winter... a film about being inflated off the planet."` — which renders fully.

**Recommended VO_TEXT layout:**

```typescript
export const VO_TEXT = [
  "In the wake of the Big Print...",
  "when seven trillion dollars appeared, very politely, from nowhere...",
  "a small number of refined persons elected to depart...",
  // ... one phrase per array entry
].join(" ");
```

One array entry should generally map to one caption row. If a phrase is too long to fit one line at your chosen font size, the caption derivation step (below) will split it.

### 2. Render the VO

Run whatever stage in the harness produces the VO file. In the Venice harness:

```bash
npx tsx scripts/<project>/04-audio.ts --only=vo --force
```

Then **always measure the actual duration** before doing any caption math:

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 \
  output/<project>/audio/vo.mp3
```

### 3. Derive Caption Timings via Silence Detection

**Never hand-estimate caption timings.** They will drift and you will iterate 3+ times. Instead, use ffmpeg `silencedetect` to find the actual phrase boundaries in the rendered VO, then map them to your VO_TEXT phrases.

#### Manual approach

```bash
ffmpeg -hide_banner -i output/<project>/audio/vo.mp3 \
  -af "silencedetect=noise=-30dB:d=0.18" \
  -f null - 2>&1 | grep silence_
```

Read the output:
- Each `silence_end:` timestamp is when speech RESUMES — i.e., the start of a new phrase.
- The number of resume points should equal (or come within 1 of) the number of VO phrases.
- If they don't match, your VO has either truncated or has unexpected internal pauses (commas being voiced as full stops). Re-author the VO and re-render.

Threshold guidance:
- `noise=-30dB:d=0.18` — good default for Kokoro at 0.92x speed.
- If you miss small pauses (between commas), drop to `-28dB:d=0.12`.
- If you catch in-word breaths as silences, raise to `-32dB:d=0.20`.

#### Automated helper

This skill ships a TypeScript helper that does the silence detection AND prints a drop-in `CAPTIONS` array:

```bash
npx tsx .claude/skills/burn-in-subtitles/scripts/derive-captions.ts \
  --vo output/<project>/audio/vo.mp3 \
  --vo-text-file scripts/<project>/config.ts \
  --vo-delay 1.5 \
  --lead-in 0.1 \
  --linger-after-last 1.5 \
  > /tmp/captions-snippet.ts
```

The helper:
1. Runs `silencedetect` and parses speech segments
2. Reads your `VO_TEXT` array from the config file
3. Maps each VO phrase to a detected speech segment by syllable-weighted proportion
4. Splits any phrase whose detected segment exceeds a max-chars-per-line budget
5. Prints a TypeScript `CAPTIONS` array ready to paste into `config.ts`

After running, paste the output into your project's `config.ts` and proceed.

### 4. Convert Trailer Time vs VO Time

Caption start times must be in **trailer absolute time**, not VO time:

```
caption.start = vo_delay + segment_start_in_vo - lead_in_seconds
caption.end   = next_caption.start - 0.05  (back-to-back, no visible gap)
```

Where:
- `vo_delay` = how many seconds into the trailer the VO begins (from `adelay` in your audio mix).
- `lead_in_seconds` = 0.1s typically — captions appear slightly before the spoken word.
- The final caption's `end` = end-of-VO + 1-2s linger so the closing phrase hangs on screen.

The helper script does this conversion automatically when you pass `--vo-delay`.

### 5. Render Captions via ffmpeg drawtext

Captions are burned in by appending a chain of `drawtext` filters to the concatenated video, each gated by `enable='between(t,start,end)'`:

```typescript
const CAPTION_FONT_SIZE = 38;
const CAPTION_ALPHA = 0.85;
const CAPTION_BOTTOM_MARGIN = 50;
const FONT = "/Library/Fonts/Arial Unicode.ttf"; // or Avenir Next, etc.

function buildCaptionFilter(): string {
  return CAPTIONS.map((c, i) => {
    const txtPath = join(BUILD_DIR, `caption-${i}.txt`);
    return (
      `drawtext=font='${FONT}':textfile='${txtPath}':fontsize=${CAPTION_FONT_SIZE}` +
      `:fontcolor=white@${CAPTION_ALPHA}` +
      `:x=(w-text_w)/2:y=h-text_h-${CAPTION_BOTTOM_MARGIN}` +
      `:enable='between(t,${c.start},${c.end})'`
    );
  }).join(",");
}
```

Apply on the **concatenated** stream so caption timestamps are absolute trailer time:

```typescript
filters.push(`${concatInputs.join("")}concat=n=${SHOTLIST.length}:v=1:a=0[vcat]`);
filters.push(`[vcat]${buildCaptionFilter()}[vout]`);
```

Each caption's text goes into its own `.txt` file (avoids shell escaping for commas, colons, ellipses):

```typescript
async function writeCaptionTextFiles(): Promise<void> {
  await mkdir(BUILD_DIR, { recursive: true });
  for (let i = 0; i < CAPTIONS.length; i++) {
    await writeFile(join(BUILD_DIR, `caption-${i}.txt`), CAPTIONS[i].text, "utf-8");
  }
}
```

### 6. Width Constraints — Max Chars Per Line

A single drawtext caption renders one line. At 1280×720 with 38px Avenir Next sans-serif, the safe budget is **~53 characters** per line. Exceeding this clips off the left/right edges.

If a phrase is longer than the budget:
- **Preferred:** split into two captions at a natural pause (comma or `...`), with sub-timings proportional to syllable count
- **Fallback:** drop font size to 32px (allows ~63 chars) — but only for the affected captions, do not change global size

The derive-captions helper does this split automatically (`--max-chars-per-line` flag, default 53).

### 7. Verify Sync Before Delivery

Always extract spot-check frames AFTER the final video is assembled, at the start of the captions you suspect might drift (typically the first one after a long phrase, and any caption you split):

```bash
for t in 2.0 5.5 10.5 15.0 20.5 27.0; do
  ffmpeg -y -loglevel error -ss $t -i output/<project>/trailer-final.mp4 \
    -frames:v 1 "/tmp/verify_t${t}.png"
done
```

Read each frame and confirm the visible caption matches the VO phrase you expect at that moment.

If the user reports captions are "all late starting at X" or "all early starting at Y":
1. **Do not adjust by guessing.** Re-run silence detection.
2. The most common cause: VO_TEXT has unstable phrasing (doubled ellipses) that caused Kokoro to truncate or extend — your captions are timed to VO that doesn't exist or to a different VO than you think.
3. The second most common cause: your `vo_delay` is wrong. Check the actual `adelay` value in your assembly script, not what you remember.

## Anti-Patterns and Lessons Learned

These cost real iterations on `The Grand Plutonian` teaser before the workflow above existed:

### 1. Doubled Ellipses Truncate the VO

`"......"` in Kokoro VO_TEXT silently drops the rest of the file. `vo.mp3` ends mid-sentence with no error. You only notice when the captions referencing the dropped text appear over a held title card with no audible speech. **Always use single `...` only.**

### 2. Hand-Estimated Caption Timings Drift Cumulatively

Estimating phrases by word count + average WPM works for the first 2-3 captions. After that, accumulated error compounds and every caption shifts by +1.5-3s. The user notices around caption 5. **Always derive from silence detection.**

### 3. Captions Burned In Before Audio Prepend Stay Synced

If you add a poster frame at the start of the video (e.g., for X social preview thumbnails), prepend it via `concat` AFTER caption burn-in AND delay the audio by the same amount via `adelay`. Both video timestamps and audio shift by the same offset, so caption-to-audio relative sync is preserved automatically.

```bash
ffmpeg -y \
  -loop 1 -framerate 24 -t 0.0417 -i poster.png \
  -i trailer-with-captions.mp4 \
  -filter_complex "
    [0:v]scale=1280:720,format=yuv420p,fps=24[bv];
    [1:v]format=yuv420p[mv];
    [bv][mv]concat=n=2:v=1:a=0[v];
    [1:a]adelay=42|42[a]
  " \
  -map "[v]" -map "[a]" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart \
  trailer-final.mp4
```

### 4. drawtext Doesn't Support `letter_spacing`

Plain `drawtext` rejects `letter_spacing`. If you need tracking, use `pad=`/`expand=` tricks or render the text as a PNG via ImageMagick and overlay it. For burned-in captions you don't need tracking — leave it alone.

### 5. drawtext Comma Escaping in `enable` Expressions

`enable='between(t,1.5,3.2)'` — the commas inside `between()` would normally break ffmpeg's filter argument parsing. Wrapping the entire expression in single quotes (as shown) handles it. If you build the filter string in a language that strips quotes, escape commas as `\,` instead.

### 6. Captions Should Be Back-to-Back, Not Gapped

If `caption[N].end` < `caption[N+1].start` with a gap between them, the screen is blank during the gap which feels like the captions are buggy. Set `caption[N].end = caption[N+1].start - 0.05` so there's continuous coverage; the previous caption hangs through any micro-pause until the next one appears.

### 7. The Final Caption Should Linger

The last caption's `end` should extend 1-2s past the actual end of speech. The user finishes reading after the audio finishes — let it hang briefly. Don't extend it across an entire held title card (>3s lingering looks unintentional).

### 8. "Soft and Small" Means Alpha 0.85, Not Pure White

Captions in white@1.0 burn through every shot and feel like a TV news chyron. White@0.85 reads cleanly without dominating. White@0.7 starts to disappear over bright backgrounds — don't go below 0.8 unless the trailer has only dark backgrounds.

### 9. Verify by Extracting Frames, Not by Trusting Timings

Even with silence-detect-derived timings, verify by extracting a frame at each problematic caption's start time and reading the resulting image. ffmpeg sometimes off-by-ones on certain encoder/decoder paths; the frame check is the only ground truth.

## Quick Reference

| Step | Command |
|---|---|
| Ask user | "Burn in subtitles? (yes/no)" |
| Render VO | `npx tsx scripts/<project>/04-audio.ts --only=vo --force` |
| Measure VO | `ffprobe -v error -show_entries format=duration ...` |
| Detect phrase boundaries | `ffmpeg -af "silencedetect=noise=-30dB:d=0.18"` |
| Generate CAPTIONS array | `npx tsx .claude/skills/burn-in-subtitles/scripts/derive-captions.ts ...` |
| Paste into config.ts | manual |
| Re-assemble trailer | `npx tsx scripts/<project>/05-assemble.ts --force` |
| Verify spot frames | `ffmpeg -ss <caption.start> -i trailer-final.mp4 -frames:v 1` |

## See Also

- `.claude/skills/venice-api/SKILL.md` — Venice TTS endpoints and voice catalog
- `.claude/skills/venice-video-model-routing/SKILL.md` — model selection for the underlying video
- `CLAUDE.md` § "Learned Anti-Patterns" — broader harness lessons
