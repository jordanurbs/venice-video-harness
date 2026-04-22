#!/usr/bin/env tsx
/**
 * render-overlay.ts
 *
 * Composite one or more overlays onto a base video. Reads an overlay
 * manifest (`src/editing/overlays.ts → OverlayManifest`) and builds
 * the ffmpeg filter chain:
 *
 *   - ffmpeg-drawtext overlays → inline drawtext filters
 *   - remotion overlays → overlay= filters against pre-rendered assets
 *     (transparent WebM / MOV / PNG sequence)
 *
 * Archive-first: any existing output is renamed to `<stem>-v<N>.<ext>`
 * before the new composite lands.
 *
 * Usage:
 *   npx tsx scripts/render-overlay.ts --manifest output/<project>/overlays.json
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  readOverlayManifest,
  validateOverlayManifest,
  type Overlay,
  type OverlayManifest,
} from '../src/editing/overlays.js';

interface Args {
  manifest: string;
  dryRun: boolean;
  skipArchive: boolean;
  font: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string => {
    const idx = argv.indexOf(flag);
    if (idx === -1) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing required flag: ${flag}`);
    }
    const v = argv[idx + 1];
    if (!v) throw new Error(`Flag ${flag} has no value`);
    return v;
  };
  return {
    manifest: resolve(get('--manifest')),
    dryRun: argv.includes('--dry-run'),
    skipArchive: argv.includes('--skip-archive'),
    font: get('--font', '/Library/Fonts/Arial Unicode.ttf'),
  };
}

function archiveExisting(path: string): string | null {
  if (!existsSync(path)) return null;
  const ext = extname(path);
  const stem = basename(path, ext);
  const dir = dirname(path);
  let n = 1;
  let candidate = join(dir, `${stem}-v${n}${ext}`);
  while (existsSync(candidate)) {
    n += 1;
    candidate = join(dir, `${stem}-v${n}${ext}`);
  }
  renameSync(path, candidate);
  return candidate;
}

function anchorExpression(overlay: Overlay): { x: string; y: string } {
  // Expressions in terms of main width W, main height H, overlay width w, overlay height h.
  const ox = overlay.position.offsetXPx ?? 40;
  const oy = overlay.position.offsetYPx ?? 40;
  switch (overlay.position.anchor) {
    case 'top-left': return { x: String(ox), y: String(oy) };
    case 'top-center': return { x: `(W-w)/2`, y: String(oy) };
    case 'top-right': return { x: `W-w-${ox}`, y: String(oy) };
    case 'center': return { x: `(W-w)/2`, y: `(H-h)/2` };
    case 'bottom-left': return { x: String(ox), y: `H-h-${oy}` };
    case 'bottom-center': return { x: `(W-w)/2`, y: `H-h-${oy}` };
    case 'bottom-right': return { x: `W-w-${ox}`, y: `H-h-${oy}` };
  }
}

/** Build a drawtext filter for an overlay that was declared as ffmpeg-drawtext. */
function drawtextFilterFor(overlay: Overlay, font: string): string | null {
  const { x, y } = anchorExpression(overlay);
  const p = overlay.payload;
  const between = `enable='between(t,${overlay.startSec.toFixed(3)},${overlay.endSec.toFixed(3)})'`;

  if (p.kind === 'lower-third') {
    const line1 = p.name.replace(/:/g, '\\:').replace(/'/g, "\\'");
    const line2 = (p.title ?? '').replace(/:/g, '\\:').replace(/'/g, "\\'");
    // Render two stacked drawtext calls; they combine cleanly.
    const a = `drawtext=font='${font}':text='${line1}':fontsize=32:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14:x=${x}:y=${y}:${between}`;
    if (!line2) return a;
    const b = `drawtext=font='${font}':text='${line2}':fontsize=20:fontcolor=white@0.9:box=1:boxcolor=black@0.55:boxborderw=10:x=${x}:y=${y}+46:${between}`;
    return `${a},${b}`;
  }

  if (p.kind === 'title-card') {
    // For title cards, a simple drawtext centered with a semi-opaque band.
    const heading = p.heading.replace(/'/g, "\\'");
    const sub = (p.subheading ?? '').replace(/'/g, "\\'");
    const h = `drawtext=font='${font}':text='${heading}':fontsize=56:fontcolor=white:x=(W-tw)/2:y=(H-th)/2-40:${between}`;
    if (!sub) return h;
    const s = `drawtext=font='${font}':text='${sub}':fontsize=24:fontcolor=white@0.85:x=(W-tw)/2:y=(H-th)/2+30:${between}`;
    return `${h},${s}`;
  }

  if (p.kind === 'chapter-marker') {
    const chap = `Chapter ${p.chapterNumber}`.replace(/'/g, "\\'");
    const title = p.title.replace(/'/g, "\\'");
    const a = `drawtext=font='${font}':text='${chap}':fontsize=22:fontcolor=white@0.75:x=${x}:y=${y}:${between}`;
    const b = `drawtext=font='${font}':text='${title}':fontsize=34:fontcolor=white:x=${x}:y=${y}+32:${between}`;
    return `${a},${b}`;
  }

  if (p.kind === 'callout') {
    const text = p.text.replace(/'/g, "\\'");
    return `drawtext=font='${font}':text='${text}':fontsize=26:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=12:x=${x}:y=${y}:${between}`;
  }

  // Logo bug with drawtext — fall back to just the description as text.
  // Prefer overlay asset via remotion renderer instead.
  return null;
}

function buildFilterGraph(
  manifest: OverlayManifest,
  font: string,
): { graph: string; inputFiles: string[] } {
  const inputFiles: string[] = [manifest.baseVideo];
  const drawtextChunks: string[] = [];
  const overlayChunks: string[] = [];

  manifest.overlays.forEach((ov, i) => {
    if (ov.renderer === 'ffmpeg-drawtext') {
      const dt = drawtextFilterFor(ov, font);
      if (dt) drawtextChunks.push(dt);
      return;
    }

    if (ov.renderer === 'remotion') {
      if (!ov.assetPath) {
        throw new Error(
          `Overlay ${ov.id} renderer=remotion but assetPath is missing. ` +
            `Render the Remotion output first and set assetPath to the WebM/MOV.`,
        );
      }
      const assetIdx = inputFiles.length;
      inputFiles.push(ov.assetPath);
      const { x, y } = anchorExpression(ov);
      // Use `enable='between(...)'` on the overlay filter to gate visibility.
      const between = `enable='between(t,${ov.startSec.toFixed(3)},${ov.endSec.toFixed(3)})'`;
      const prev = i === 0 ? '[0:v]' : `[vov${i - 1}]`;
      const out = `[vov${i}]`;
      overlayChunks.push(
        `${prev}[${assetIdx}:v]overlay=x=${x}:y=${y}:${between}:format=auto${out}`,
      );
    }
  });

  // Order: overlays first (they carry the video stream through), then drawtext
  // on whatever the last overlay emitted (or the base if no overlays).
  const filters: string[] = [];
  filters.push(...overlayChunks);
  const lastVLabel =
    overlayChunks.length > 0 ? `[vov${overlayChunks.length - 1}]` : '[0:v]';
  if (drawtextChunks.length > 0) {
    filters.push(`${lastVLabel}${drawtextChunks.join(',')}[vout]`);
  } else {
    filters.push(`${lastVLabel}null[vout]`);
  }

  return { graph: filters.join(';'), inputFiles };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readOverlayManifest(args.manifest);

  const errs = validateOverlayManifest(manifest);
  if (errs.length > 0) {
    console.error('Overlay manifest validation failed:');
    for (const e of errs) console.error(`  [${e.overlayId}] ${e.message}`);
    process.exit(1);
  }

  if (!existsSync(manifest.baseVideo)) {
    throw new Error(`baseVideo not found: ${manifest.baseVideo}`);
  }

  const outputPath = resolve(manifest.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  let archived: string | null = null;
  if (!args.skipArchive) archived = archiveExisting(outputPath);

  const { graph, inputFiles } = buildFilterGraph(manifest, args.font);
  const inputArgs = inputFiles.flatMap((f) => ['-i', `"${f}"`]);

  const cmd = [
    'ffmpeg',
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    ...inputArgs,
    '-filter_complex', `"${graph}"`,
    '-map', '"[vout]"',
    '-map', '"0:a?"',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    `"${outputPath}"`,
  ].join(' ');

  if (args.dryRun) {
    console.log(cmd);
    if (archived) console.error(`[render-overlay] (dry-run) Would have archived to ${archived}`);
    return;
  }

  execSync(cmd, { stdio: 'inherit' });
  if (archived) {
    console.error(`[render-overlay] Archived prior output to ${archived}`);
  }
  console.error(`[render-overlay] Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
