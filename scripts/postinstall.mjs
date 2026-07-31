import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';

if (process.env.npm_config_global === 'true') {
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const globalPrefix = dirname(dirname(dirname(packageDir)));
  const binDir = join(globalPrefix, 'bin');
  const normalize = (entry) => {
    const absolute = resolve(entry);
    return existsSync(absolute) ? realpathSync(absolute) : absolute;
  };
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(normalize);
  const binOnPath = pathEntries.includes(normalize(binDir));

  if (!binOnPath && existsSync(binDir)) {
    console.log('');
    console.log("Venice Video installed, but npm's global executable directory is not on PATH.");
    console.log(`Add it for this shell:  export PATH="${binDir}:$PATH"`);
    console.log('Then add the same line to ~/.zshrc, ~/.bashrc, or your shell startup file.');
    console.log('Verify with: venice-video --version');
    console.log('');
  }
}
