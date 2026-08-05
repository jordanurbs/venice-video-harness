// ---------------------------------------------------------------------------
// Pipeline status -- read the on-disk state machine and say what comes next.
//
// The production pipeline already encodes its own state as files: script.json,
// script-approved.json, qa-report.json, qa-approved.json, panels, clips, then
// episode-NNN-final.mp4. Nothing surfaced that, so knowing where an episode
// stood meant listing directories by hand and remembering the gate order.
//
// This reads those markers and reports the stage plus the exact next command.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getEpisodeDir, loadEpisodeScript, loadSeries } from '../series/manager.js';
import type { EpisodeScript, SeriesState } from '../series/types.js';

export interface EpisodeStatus {
  episode: number;
  title?: string;
  hasScript: boolean;
  shotCount: number;
  scriptApproved: boolean;
  qaReported: boolean;
  qaApproved: boolean;
  panelCount: number;
  videoCount: number;
  hasMusic: boolean;
  dialogueCount: number;
  hasFinalCut: boolean;
  /** Short stage name, e.g. 'storyboard', 'qa gate', 'rendering'. */
  stage: string;
  /** Literal command to run next, or undefined when the episode is done. */
  nextCommand?: string;
}

export interface ProjectStatus {
  projectDir: string;
  name: string;
  slug: string;
  aestheticSet: boolean;
  characterCount: number;
  lockedVoiceCount: number;
  locationCount: number;
  episodes: EpisodeStatus[];
  /** Command to run next at the project level (aesthetic, cast) if any. */
  nextCommand?: string;
}

function countMatching(dir: string, pattern: RegExp): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter(name => pattern.test(name)).length;
  } catch {
    return 0;
  }
}

/**
 * Determine an episode's stage and the command that advances it.
 * Mirrors the real gate order: script → approve → storyboard → QA → qa-approve
 * → videos → music → assemble.
 */
function classifyEpisode(
  series: SeriesState,
  episode: number,
  script: EpisodeScript | null,
  episodeDir: string,
): EpisodeStatus {
  const sceneDir = join(episodeDir, 'scene-001');
  const audioDir = join(episodeDir, 'audio');
  const padded = String(episode).padStart(3, '0');

  const status: EpisodeStatus = {
    episode,
    title: series.episodes.find(e => e.number === episode)?.title,
    hasScript: Boolean(script),
    shotCount: script?.shots?.length ?? 0,
    // Mirror the gate in `storyboard-episode`, which accepts either marker.
    // `approve-script` writes the artifact; `workshop --approve` instead sets
    // the script's own status, and checking only the file told every
    // workshop-driven project to re-approve a script it had already shot.
    scriptApproved: existsSync(join(episodeDir, 'script-approved.json'))
      || script?.status === 'approved',
    qaReported: existsSync(join(episodeDir, 'qa-report.json')),
    qaApproved: existsSync(join(episodeDir, 'qa-approved.json')),
    panelCount: countMatching(sceneDir, /^shot-\d+\.png$/),
    videoCount: countMatching(sceneDir, /^shot-\d+\.mp4$/),
    hasMusic: existsSync(join(audioDir, 'music.mp3')),
    dialogueCount: countMatching(audioDir, /^dialogue-shot-\d+\.mp3$/),
    hasFinalCut: existsSync(join(episodeDir, `episode-${padded}-final.mp4`)),
    stage: 'not started',
  };

  const ref = `-e ${episode}`;
  if (!status.hasScript) {
    status.stage = 'no script';
    status.nextCommand = `workshop-episode ${ref} --concept "<what happens>"`;
  } else if (!status.scriptApproved) {
    status.stage = 'script drafted';
    status.nextCommand = `approve-script ${ref}`;
  } else if (status.panelCount < status.shotCount) {
    status.stage = status.panelCount === 0
      ? 'ready to storyboard'
      : `storyboarding (${status.panelCount}/${status.shotCount} panels)`;
    status.nextCommand = `storyboard-episode ${ref}`;
  } else if (!status.qaReported) {
    status.stage = 'panels complete';
    status.nextCommand = `qa-storyboard ${ref}`;
  } else if (!status.qaApproved) {
    status.stage = 'at QA gate';
    status.nextCommand = `qa-approve ${ref}`;
  } else if (status.videoCount < status.shotCount) {
    status.stage = status.videoCount === 0
      ? 'ready to render'
      : `rendering (${status.videoCount}/${status.shotCount} clips)`;
    status.nextCommand = `generate-videos ${ref}`;
  } else if (!status.hasFinalCut) {
    status.stage = 'clips complete';
    status.nextCommand = `assemble-episode ${ref}`;
  } else {
    status.stage = 'complete';
  }

  return status;
}

/**
 * Turn a shell-form suggestion (`qa-storyboard -e 3`) into one that also works
 * pasted into a plain terminal (`qa-storyboard -p "<dir>" -e 3`).
 *
 * Inside the shell `-p` defaults to the selection, so the short form is what
 * gets suggested there. Anywhere the project is not implied -- the treatment
 * page, a log someone reads tomorrow -- the command needs the directory or it
 * fails on a missing required option. A trailing `# comment` stays trailing.
 */
export function qualifyCommand(command: string, projectDir: string): string {
  if (/(^|\s)(-p|--project)(\s|=)/.test(command)) return command;
  const [body, ...comment] = command.split('#');
  const tokens = body.trimEnd().split(/\s+/);
  const head = tokens.shift() ?? command;
  const rest = tokens.length > 0 ? ` ${tokens.join(' ')}` : '';
  const suffix = comment.length > 0 ? `   #${comment.join('#')}` : '';
  return `${head} -p "${projectDir}"${rest}${suffix}`;
}

export async function collectProjectStatus(projectDir: string): Promise<ProjectStatus | null> {
  const series = await loadSeries(projectDir);
  if (!series) return null;

  const episodes: EpisodeStatus[] = [];
  for (const meta of series.episodes) {
    const episodeDir = getEpisodeDir(series, meta.number);
    const script = await loadEpisodeScript(series, meta.number);
    episodes.push(classifyEpisode(series, meta.number, script, episodeDir));
  }

  const characters = series.characters ?? [];
  const status: ProjectStatus = {
    projectDir,
    name: series.name,
    slug: series.slug,
    aestheticSet: Boolean(series.aesthetic),
    characterCount: characters.length,
    lockedVoiceCount: characters.filter(c => Boolean(c.voiceId)).length,
    locationCount: (series.locations ?? []).length,
    episodes,
  };

  // Project-level prerequisites gate everything downstream, so they take
  // precedence over any individual episode's next step.
  if (!status.aestheticSet) {
    status.nextCommand = 'explore-aesthetic   # then: set-aesthetic';
  } else if (status.characterCount === 0) {
    status.nextCommand = 'add-character --name "<NAME>" --gender <f|m>';
  } else if (episodes.length === 0) {
    status.nextCommand = 'new-episode -t "<title>"';
  } else {
    const unfinished = episodes.find(e => e.nextCommand);
    status.nextCommand = unfinished?.nextCommand;
  }

  return status;
}

export function formatProjectStatus(status: ProjectStatus, selectedEpisode?: number): string {
  const lines: string[] = [];
  lines.push(`${status.name}  (${status.slug})`);
  lines.push(`  ${status.projectDir}`);
  lines.push('');
  lines.push(`  aesthetic  ${status.aestheticSet ? 'set' : 'NOT SET'}`);
  lines.push(
    `  cast       ${status.characterCount} character(s), ${status.lockedVoiceCount} with a locked voice`,
  );
  lines.push(`  locations  ${status.locationCount}`);

  if (status.episodes.length === 0) {
    lines.push('  episodes   none yet');
  } else {
    lines.push('');
    lines.push('  episodes');
    for (const ep of status.episodes) {
      const marker = ep.episode === selectedEpisode ? '▸' : ' ';
      const title = ep.title ? ` ${ep.title}` : '';
      lines.push(`   ${marker} ${String(ep.episode).padStart(2, '0')}${title} — ${ep.stage}`);
      if (ep.shotCount > 0) {
        lines.push(
          `        ${ep.shotCount} shots · ${ep.panelCount} panels · ${ep.videoCount} clips`
          + `${ep.dialogueCount > 0 ? ` · ${ep.dialogueCount} dialogue` : ''}`
          + `${ep.hasMusic ? ' · music' : ''}`
          + `${ep.hasFinalCut ? ' · FINAL CUT' : ''}`,
        );
      }
    }
  }

  if (status.nextCommand) {
    lines.push('');
    lines.push(`  next  ${status.nextCommand}`);
  } else {
    lines.push('');
    lines.push('  next  nothing pending — every episode is assembled.');
  }

  return lines.join('\n');
}
