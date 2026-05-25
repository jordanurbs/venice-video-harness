#!/usr/bin/env node
// Tests for sniffImageFormat + writeImageBytesSmart (W2.9).
// Run with `node tests/test-image-bytes-sniff.mjs` after `npm run build`.

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sniffImageFormat, writeImageBytesSmart } from '../dist/venice/image-bytes.js';

let failed = 0;
function ok(label, cond) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed += 1; console.error(`  FAIL ${label}`); }
}

// PNG magic bytes (89 50 4E 47 0D 0A 1A 0A).
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
// JPEG magic (FF D8 FF E0).
const JPEG_HEAD = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]);
// WebP: 'RIFF' + 4 size bytes + 'WEBP'
const WEBP_HEAD = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
]);
// GIF: GIF89a
const GIF_HEAD = Buffer.from('GIF89a' + '\0\0', 'binary');
// AVIF: ftypavif at offset 4
const AVIF_HEAD = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from('ftypavif', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
]);

ok('PNG sniffed as png', sniffImageFormat(PNG_HEAD).format === 'png');
ok('JPEG sniffed as jpeg', sniffImageFormat(JPEG_HEAD).format === 'jpeg');
ok('WebP sniffed as webp', sniffImageFormat(WEBP_HEAD).format === 'webp');
ok('GIF sniffed as gif', sniffImageFormat(GIF_HEAD).format === 'gif');
ok('AVIF sniffed as avif', sniffImageFormat(AVIF_HEAD).format === 'avif');
ok('random sniffed as unknown',
  sniffImageFormat(Buffer.from('not-an-image-at-all')).format === 'unknown');

// writeImageBytesSmart: request .png but bytes are WebP -> writes .webp + warns.
{
  const dir = mkdtempSync(join(tmpdir(), 'img-sniff-'));
  const requested = join(dir, 'front.png');
  const final = await writeImageBytesSmart(WEBP_HEAD, requested);
  ok('WebP bytes named .png are rewritten to .webp', final.endsWith('.webp'));
  ok('Original .png path is NOT written', !existsSync(requested));
  ok('Final .webp path exists', existsSync(final));
  rmSync(dir, { recursive: true, force: true });
}

// writeImageBytesSmart: request .png and bytes are PNG -> writes .png.
{
  const dir = mkdtempSync(join(tmpdir(), 'img-sniff-'));
  const requested = join(dir, 'front.png');
  const final = await writeImageBytesSmart(PNG_HEAD, requested);
  ok('PNG bytes named .png stay at .png', final.endsWith('.png') && final === requested);
  rmSync(dir, { recursive: true, force: true });
}

// forceExt keeps the requested extension regardless.
{
  const dir = mkdtempSync(join(tmpdir(), 'img-sniff-'));
  const requested = join(dir, 'front.png');
  const final = await writeImageBytesSmart(WEBP_HEAD, requested, { forceExt: true });
  ok('forceExt keeps the requested .png', final === requested);
  rmSync(dir, { recursive: true, force: true });
}

if (failed > 0) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log('\nAll assertions passed.');
