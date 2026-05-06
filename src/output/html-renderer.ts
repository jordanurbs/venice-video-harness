import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function saveStoryboardHtml(storyboard: unknown, outputPath: string): Promise<string> {
  const absolutePath = resolve(outputPath);
  const title =
    typeof storyboard === 'object' &&
    storyboard !== null &&
    'title' in storyboard &&
    typeof (storyboard as { title?: unknown }).title === 'string'
      ? (storyboard as { title: string }).title
      : 'Storyboard';

  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    `  <title>${escapeHtml(title)}</title>`,
    '  <style>body{font-family:system-ui;margin:24px;background:#111;color:#eee}pre{white-space:pre-wrap;background:#1b1b1b;padding:16px;border-radius:8px}</style>',
    '</head>',
    '<body>',
    `  <h1>${escapeHtml(title)}</h1>`,
    `  <pre>${escapeHtml(JSON.stringify(storyboard, null, 2) ?? '{}')}</pre>`,
    '</body>',
    '</html>',
  ].join('\n');

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, html, 'utf-8');
  return absolutePath;
}
