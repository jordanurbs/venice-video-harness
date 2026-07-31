import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * The project and episode commands default to when `-p` / `-e` are omitted.
 * Set by `venice-video use`, and by `/use` inside the interactive shell.
 */
export interface SelectedContext {
  /** Absolute path to the selected project directory. */
  project?: string;
  episode?: number;
}

export interface UserConfig {
  apiKey?: string;
  workspace?: string;
  context?: SelectedContext;
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

export function getConfigDir(): string {
  const override = process.env.VENICE_VIDEO_CONFIG_DIR;
  if (override) return resolve(expandHome(override));
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'venice-video');
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'venice-video');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'venice-video');
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

export async function readUserConfig(): Promise<UserConfig> {
  try {
    const raw = await readFile(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('configuration root must be a JSON object');
    }
    return parsed as UserConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not read Venice Video config at ${getConfigPath()}: ${(error as Error).message}`);
  }
}

export async function writeUserConfig(config: UserConfig): Promise<void> {
  const configPath = getConfigPath();
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await rename(temporaryPath, configPath);
    if (platform() !== 'win32') await chmod(configPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function updateUserConfig(patch: Partial<UserConfig>): Promise<UserConfig> {
  const next = { ...(await readUserConfig()), ...patch };
  for (const key of Object.keys(next) as Array<keyof UserConfig>) {
    if (next[key] === undefined || next[key] === '') delete next[key];
  }
  await writeUserConfig(next);
  return next;
}

export async function hydrateEnvironmentFromUserConfig(): Promise<void> {
  if (process.env.VENICE_API_KEY) return;
  const stored = (await readUserConfig()).apiKey;
  if (stored) process.env.VENICE_API_KEY = stored;
}

export function getDefaultSetupWorkspace(): string {
  return join(homedir(), 'VeniceVideos');
}

export async function getWorkspaceDir(override?: string): Promise<string> {
  const config = await readUserConfig();
  const selected = override ?? process.env.VENICE_VIDEO_WORKSPACE ?? config.workspace ?? resolve('output');
  return resolve(expandHome(selected));
}

export function maskApiKey(apiKey?: string): string {
  if (!apiKey) return '(not configured)';
  if (apiKey.length <= 8) return '••••••••';
  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
}

export async function validateVeniceApiKey(apiKey: string): Promise<void> {
  const response = await fetch('https://api.venice.ai/api/v1/models?type=video', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json() as { error?: { message?: string } };
      detail = body.error?.message ? `: ${body.error.message}` : '';
    } catch { /* status is enough */ }
    throw new Error(`Venice rejected the API key (HTTP ${response.status})${detail}`);
  }
}
