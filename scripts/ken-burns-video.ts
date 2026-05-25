#!/usr/bin/env tsx
/**
 * Ken-Burns-on-a-video helper.
 *
 * Applies a smooth slow zoom (e.g. 1.00x -> 1.12x over the clip duration)
 * to an existing video, PRESERVING every input frame's organic motion.
 *
 * Why this exists:
 *   The obvious choice for animated zoom in ffmpeg is the `zoompan` filter.
 *   On a *still image* input that's fine, but on a *video* input zoompan
 *   freezes the first input frame for `d=N` output frames — collapsing the
 *   entire clip onto its opening frame and producing a slideshow effect.
 *   The PNW field-guide v5 shot 1 hit this exact bug: a Seedance render
 *   with rain, drifting fog, and a crow flying across the upper right
 *   became a still photo with fake zoom motion.
 *
 *   The correct recipe is `scale=...:eval=frame` (recompute the scale on
 *   every frame) followed by a static `crop` back to the target resolution.
 *   eval=frame is what advances input frames normally while the output
 *   resolution grows over time.
 *
 * Usage:
 *   tsx scripts/ken-burns-video.ts \
 *     --in path/to/in.mp4 \
 *     --out path/to/out.mp4 \
 *     [--duration 8.5]      # seconds; defaults to source duration
 *     [--zoom-from 1.0]
 *     [--zoom-to 1.12]
 *     [--width 1920]
 *     [--height 1080]
 *     [--fps 30]
 *     [--crf 18]
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

interface Args {
  inputPath: string;
  outputPath: string;
  durationSec?: number;
  zoomFrom: number;
  zoomTo: number;
  width: number;
  height: number;
  fps: number;
  crf: number;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    zoomFrom: 1.0,
    zoomTo: 1.12,
    width: 1920,
    height: 1080,
    fps: 30,
    crf: 18,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--in': args.inputPath = next(); break;
      case '--out': args.outputPath = next(); break;
      case '--duration': args.durationSec = parseFloat(next()); break;
      case '--zoom-from': args.zoomFrom = parseFloat(next()); break;
      case '--zoom-to': args.zoomTo = parseFloat(next()); break;
      case '--width': args.width = parseInt(next(), 10); break;
      case '--height': args.height = parseInt(next(), 10); break;
      case '--fps': args.fps = parseInt(next(), 10); break;
      case '--crf': args.crf = parseInt(next(), 10); break;
      case '-h':
      case '--help':
        console.log(buildUsage());
        process.exit(0);
    }
  }
  if (!args.inputPath || !args.outputPath) {
    console.error('Missing required --in / --out');
    console.error(buildUsage());
    process.exit(2);
  }
  return args as Args;
}

function buildUsage(): string {
  return [
    'Usage: tsx scripts/ken-burns-video.ts --in <path> --out <path> [options]',
    '',
    'Options:',
    '  --duration <sec>     output duration (defaults to source duration)',
    '  --zoom-from <ratio>  starting zoom (default 1.0)',
    '  --zoom-to <ratio>    ending zoom (default 1.12)',
    '  --width <px>         output width (default 1920)',
    '  --height <px>        output height (default 1080)',
    '  --fps <n>            output frame rate (default 30)',
    '  --crf <n>            x264 CRF (default 18)',
  ].join('\n');
}

function probeDuration(path: string): number {
  const out = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path,
  ], { encoding: 'utf-8' });
  if (out.status !== 0) throw new Error(`ffprobe failed: ${out.stderr}`);
  return parseFloat(out.stdout.trim());
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  if (!existsSync(a.inputPath)) {
    console.error(`Input not found: ${a.inputPath}`);
    process.exit(2);
  }
  const sourceDur = probeDuration(a.inputPath);
  const dur = a.durationSec ?? sourceDur;
  if (!Number.isFinite(dur) || dur <= 0) {
    console.error(`Invalid duration: ${dur}`);
    process.exit(2);
  }

  // Per-frame zoom: rate = (zoomTo - zoomFrom) / duration
  // scale=w='W*(zoomFrom + rate*t)':h='H*(zoomFrom + rate*t)':eval=frame
  // followed by center-crop back to W:H.
  const rate = (a.zoomTo - a.zoomFrom) / dur;
  const vf = [
    `scale=w='${a.width}*(${a.zoomFrom.toFixed(4)}+${rate.toFixed(6)}*t)':h='${a.height}*(${a.zoomFrom.toFixed(4)}+${rate.toFixed(6)}*t)':eval=frame:flags=lanczos`,
    `crop=${a.width}:${a.height}:(iw-${a.width})/2:(ih-${a.height})/2`,
    'format=yuv420p',
    `fps=${a.fps}`,
  ].join(',');

  const ffmpegArgs = [
    '-y',
    '-i', a.inputPath,
    '-t', String(dur.toFixed(3)),
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', String(a.crf),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-t', String(dur.toFixed(3)),
    a.outputPath,
  ];

  console.log(`Ken Burns video: ${a.inputPath} -> ${a.outputPath}`);
  console.log(`  Duration: ${dur.toFixed(2)}s, zoom ${a.zoomFrom} -> ${a.zoomTo} (rate ${rate.toFixed(6)}/s)`);
  console.log(`  Output: ${a.width}x${a.height} @ ${a.fps}fps`);
  console.log(`  (Using scale=...:eval=frame + center-crop; NOT zoompan, which freezes on video inputs.)`);

  const result = spawnSync('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log('done.');
}

main();
