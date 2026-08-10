#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { resolve, join, basename } from 'node:path';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { stdin } from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createSeries,
  saveSeries,
  loadSeries,
  listSeries,
  addCharacter,
  getCharacter,
  addEpisode,
  getEpisodeDir,
  getCharacterDir,
  getLocationDir,
  getLocation,
  addLocation,
  locationSlugify,
  saveEpisodeScript,
  loadEpisodeScript,
} from '../series/manager.js';
import type {
  SeriesState,
  MiniDramaCharacter,
  EpisodeScript,
  ShotScript,
  Location,
  VideoFamilyPreference,
} from '../series/types.js';
import {
  FEMALE_BASE_TRAITS,
  MALE_BASE_TRAITS,
  DEFAULT_ACTION_MODEL,
  DEFAULT_ATMOSPHERE_MODEL,
  DEFAULT_CHARACTER_CONSISTENCY_MODEL,
  DEFAULT_IMAGE_GENERATION_MODEL,
  DEFAULT_IMAGE_EDIT_MODEL,
  DEFAULT_LIP_SYNC_MODEL,
  resolveAutoEdit,
} from '../series/types.js';
import type { AestheticProfile } from '../storyboard/prompt-builder.js';
import { VeniceClient } from '../venice/client.js';
import { upscaleVideo, estimateUpscaleCostUsd } from '../venice/upscale.js';
import { generateImage, generateWithReferences } from '../venice/generate.js';
import { writeImageBytesSmart } from '../venice/image-bytes.js';
import { appendRecipePass } from '../venice/recipe.js';
import { getVeniceApiKey } from '../config.js';
import { printSkippableQuestionsNote, promptChoice, promptText } from '../interactive.js';
import {
  getConfigPath,
  getDefaultSetupWorkspace,
  getWorkspaceDir,
  maskApiKey,
  readUserConfig,
  updateUserConfig,
  validateVeniceApiKey,
} from '../user-config.js';
import { listVoices, filterVoices, auditionVoices } from '../venice/voices.js';
import {
  clearContext,
  MissingContextError,
  readContext,
  resolveProjectRef,
  setContext,
} from '../session/context.js';
import { OperationAbortedError } from '../venice/operation-context.js';
import { applyContextDefaults } from '../session/program-context.js';
import { collectProjectStatus, formatProjectStatus } from '../session/status.js';
import {
  clearPendingJob,
  isStale,
  listPendingJobs,
  prunePendingJobs,
} from '../venice/job-store.js';
import {
  generateDialogueForShots,
  generateSoundEffect,
  generateMusic,
  generateSeedAudio,
  DEFAULT_VENICE_MUSIC_MODEL,
  DEFAULT_VENICE_SEED_AUDIO_MODEL,
} from '../venice/audio.js';
import type { DialogueLine } from '../venice/audio.js';
import { getMusicModel } from '../venice/models.js';

import { buildImagePrompt, buildCharacterReferencePromptParts } from './prompt-builder.js';
import { generateEpisodeVideos } from './video-generator.js';
import { generateVoiceReference } from './voice-reference.js';
import { generateLocationReferences } from './location-generator.js';
import {
  ensureEpisodeStoryboardReferences,
  generateStoryboardReference,
} from './storyboard-reference-generator.js';
import { generateSubtitles, saveSrt } from './subtitle-generator.js';
import { fixPanel, refineWithReferences, refineStyleConsistency } from './panel-fixer.js';
import { multiEditImage, loadImageAsDataUri } from '../venice/multi-edit.js';
import type { MultiEditModel } from '../venice/types.js';
import { assembleEpisode, collectShotVideos } from './assembler.js';
import { buildGenerationPlan, saveGenerationPlan } from './generation-planner.js';
import {
  AUDIO_STRATEGY_CHOICES,
  INTELLIGENCE_CHOICES,
  RENDER_ROUTE_CHOICES,
  VIDEO_FAMILY_CHOICES,
  type RenderRoute,
} from './choices.js';
import {
  DEFAULT_INTELLIGENCE_MODEL,
  describeIntelligence,
  resolveIntelligence,
} from '../venice/text-models.js';
import { getProjectLanguage } from '../series/project-language.js';
import {
  approveWorkshop,
  generateWorkshop,
  getWorkshopPath,
  inventoryReferencePath,
  loadWorkshop,
  saveWorkshop,
  type WorkshopInputs,
} from './workshop.js';
import { hasTreatment, refreshTreatment } from './treatment.js';
import {
  PACKAGE_NAME,
  compareVersions,
  currentInstall,
  fetchPublishedVersion,
  isSessionActive,
  manualUpdateInstructions,
  npmInvocation,
  readInstalledVersion,
  runInstall,
} from '../update.js';
import { emitJson, failJson, jsonRequested } from '../agent/output.js';
import { formatGuide, guideAsJson } from '../agent/guide.js';
import { formatPipeline, pipelineAsJson } from '../agent/pipeline.js';
import { renderCapabilitiesManifest } from '../venice/capabilities-manifest.js';

// Read from package.json rather than a literal, which drifts on every release.
const packageVersion: string = (() => {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const program = new Command();
program
  .name('venice-video')
  .description('Standalone consistency-first video production with Venice AI')
  .version(packageVersion)
  .option('--workspace <dir>', 'Workspace containing Venice Video projects')
  .option('--json', 'Emit machine-readable JSON on stdout (supported by agent-facing commands)');

/** True when `--json` was passed globally or on the command itself. */
function wantsJson(localOpts?: { json?: unknown }): boolean {
  return jsonRequested(program.opts().json, localOpts?.json);
}

const VIDEO_FAMILIES: ReadonlySet<string> = new Set(VIDEO_FAMILY_CHOICES.map(c => c.value));
const RENDER_ROUTES: ReadonlySet<string> = new Set(RENDER_ROUTE_CHOICES.map(c => c.value));

/** Map the upfront render-route choice onto the `montageMode` toggle. */
function montageModeForRoute(route: RenderRoute | undefined): boolean | undefined {
  if (route === undefined) return undefined;
  return route !== 'standard';
}

/**
 * Which reasoning model this invocation should use.
 *
 * Precedence is explicit `--model` first, then the project's saved choice,
 * then the harness default. Projects created before 2.9.0 have no saved
 * choice and land on the default.
 */
function intelligenceFor(series: SeriesState, override?: string) {
  if (override) return resolveIntelligence(override);
  const saved = series.intelligence;
  if (saved?.model) return { model: saved.model, visionModel: saved.visionModel || saved.model };
  return resolveIntelligence(DEFAULT_INTELLIGENCE_MODEL);
}


function openInDefaultBrowser(path: string): boolean {
  if (process.env.VENICE_VIDEO_NO_OPEN === '1' || !process.stdout.isTTY) return false;
  const command = process.platform === 'darwin'
    ? { name: 'open', args: [path] }
    : process.platform === 'win32'
      ? { name: 'cmd', args: ['/c', 'start', '', path] }
      : { name: 'xdg-open', args: [path] };
  const result = spawnSync(command.name, command.args, { stdio: 'ignore' });
  return result.status === 0;
}

/**
 * Re-render the treatment page after a step that changed the episode, and
 * point the operator at it.
 *
 * Called at the end of every command that produces an artifact, so the browser
 * tab holding WORKSHOP.html is one reload away from showing the new panels,
 * clips and QA verdicts. Silent for projects that never ran the workshop.
 */
async function updateTreatment(series: SeriesState, episode?: number): Promise<void> {
  if (!hasTreatment(series)) return;
  const path = await refreshTreatment(series, { episode });
  if (path) console.log(`\nTreatment updated — reload ${path}`);
}

/**
 * True when this file is the process entry point. The program is only parsed in
 * that case, so `shell` (and tests) can import the same command tree without
 * argv being consumed at import time.
 *
 * `bin` points straight at this file, so the comparison is against argv[1] with
 * symlinks resolved. The basename fallback covers the tsx dev path (.ts entry
 * for a .js module specifier) -- getting this wrong would leave the CLI silently
 * doing nothing, so it errs toward "yes, run".
 */
function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return true;
  const canonical = (path: string): string => {
    try { return realpathSync(path); } catch { return resolve(path); }
  };
  const stripExtension = (path: string): string => basename(path).replace(/\.[cm]?[jt]s$/, '');
  const modulePath = canonical(fileURLToPath(moduleUrl));
  const entryPath = canonical(entry);
  return modulePath === entryPath || stripExtension(modulePath) === stripExtension(entryPath);
}

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const detail = stderr || stdout || `exit code ${result.status}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

/**
 * Merge the locations an episode script introduced into the series, and
 * generate reference images for any location that doesn't have them yet.
 * Locations referenced by a shot's `location` slug but absent from the
 * script's `locations[]` are synthesized as description-only stubs (from the
 * shot's description) so every tagged slug resolves. Logs generation cost.
 */
async function mergeAndGenerateEpisodeLocations(
  client: VeniceClient,
  series: SeriesState,
  script: EpisodeScript,
): Promise<void> {
  const scriptLocations = script.locations ?? [];

  // Synthesize stubs for slugs tagged on shots but not declared in locations[].
  const declaredSlugs = new Set(scriptLocations.map(l => l.slug));
  const taggedSlugs = new Set(
    script.shots.map(s => s.location).filter((s): s is string => Boolean(s)),
  );
  for (const slug of taggedSlugs) {
    if (declaredSlugs.has(slug)) continue;
    if (getLocation(series, slug)) continue; // already a series location
    const firstShot = script.shots.find(s => s.location === slug);
    scriptLocations.push({
      name: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      slug,
      description: firstShot?.description ?? `The ${slug.replace(/-/g, ' ')} location.`,
    } as Location);
  }

  if (scriptLocations.length === 0) return;

  const toGenerate: Location[] = [];
  for (const loc of scriptLocations) {
    const slug = loc.slug || locationSlugify(loc.name);
    const existing = getLocation(series, slug);
    const merged: Location = existing
      ? {
          ...existing,
          description: loc.description || existing.description,
          lightingNotes: loc.lightingNotes ?? existing.lightingNotes,
          // Locked geography is sticky: an existing anchor set wins so the
          // scene geography never silently rearranges between script parts.
          spatialAnchors: existing.spatialAnchors ?? loc.spatialAnchors,
        }
      : {
          name: loc.name,
          slug,
          description: loc.description,
          ...(loc.lightingNotes ? { lightingNotes: loc.lightingNotes } : {}),
          ...(loc.spatialAnchors ? { spatialAnchors: loc.spatialAnchors } : {}),
          seed: Math.abs([...slug].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)) % 999_999_999,
        };
    addLocation(series, merged);

    const dir = getLocationDir(series, slug);
    const hasRefs = ['wide.png', 'medium.png', 'detail.png'].some(f => existsSync(join(dir, f)));
    if (!hasRefs) toGenerate.push(merged);
  }

  if (toGenerate.length === 0) return;
  if (!series.aesthetic) {
    console.warn('  ⚠ Locations introduced but series aesthetic is not set — skipping reference generation.');
    return;
  }

  console.log(`\nGenerating reference images for ${toGenerate.length} new location(s) (~$${(toGenerate.length * 3 * 0.04).toFixed(2)} est. — 3 angles each)...`);
  for (const loc of toGenerate) {
    console.log(`  Location: ${loc.name} (${loc.slug})`);
    try {
      await generateLocationReferences(client, series, loc);
    } catch (err) {
      console.warn(`  ⚠ Location reference generation failed for ${loc.name}: ${(err as Error).message}`);
    }
  }
}

/**
 * Resolve the best on-disk location reference image for a shot, plus a prompt
 * note carrying the location's locked description + lighting. Closer shot
 * types prefer the medium angle; everything else prefers the wide establishing
 * angle. Returns undefined refPath when the shot has no location or no images.
 */
function resolveLocationRefForShot(
  series: SeriesState,
  shot: ShotScript,
): { location?: Location; refPath?: string; note: string } {
  if (!shot.location) return { note: '' };
  const location = getLocation(series, shot.location);
  if (!location) return { note: '' };
  const dir = getLocationDir(series, location.slug);
  const closer = shot.type === 'close-up' || shot.type === 'reaction' || shot.type === 'insert';
  const order = closer
    ? ['medium.png', 'wide.png', 'detail.png']
    : ['wide.png', 'medium.png', 'detail.png'];
  const refPath = order.map(f => join(dir, f)).find(p => existsSync(p));
  const note = ` Location: ${location.description}`
    + (location.lightingNotes ? ` Lighting: ${location.lightingNotes}.` : '')
    + (location.spatialAnchors ? ` Fixed layout (never rearrange): ${location.spatialAnchors}.` : '');
  return { location, refPath, note };
}

// ── setup / config / doctor / new ─────────────────────────────────────
program
  .command('setup')
  .description('Configure the Venice API key and default project workspace')
  .option('--api-key <key>', 'Venice API key (prefer the hidden prompt in an interactive terminal)')
  .option('--workspace <dir>', 'Default directory for Venice Video projects')
  .option('--skip-validation', 'Store the API key without contacting Venice', false)
  .action(async (opts: { apiKey?: string; workspace?: string; skipValidation: boolean }) => {
    const current = await readUserConfig();
    const apiKey = opts.apiKey
      ?? process.env.VENICE_API_KEY
      ?? await promptText('Venice API key', { hidden: true, required: true });
    const workspace = opts.workspace
      ?? program.opts().workspace
      ?? await promptText('Default project workspace', {
        defaultValue: current.workspace ?? getDefaultSetupWorkspace(),
        required: true,
      });

    if (!opts.skipValidation) {
      process.stdout.write('Validating API key... ');
      await validateVeniceApiKey(apiKey);
      console.log('ok');
    }
    const resolvedWorkspace = await getWorkspaceDir(workspace);
    await mkdir(resolvedWorkspace, { recursive: true });
    await updateUserConfig({ apiKey, workspace: resolvedWorkspace });
    process.env.VENICE_API_KEY = apiKey;

    console.log('Venice Video is configured.');
    console.log(`  API key: ${maskApiKey(apiKey)}`);
    console.log(`  Workspace: ${resolvedWorkspace}`);
    console.log(`  Config: ${getConfigPath()}`);
    console.log('\nNext: run `venice-video new`.');
  });

const configCommand = program.command('config').description('Show or change standalone CLI configuration');

configCommand
  .command('show')
  .description('Show configuration with the API key masked')
  .action(async () => {
    const config = await readUserConfig();
    console.log(`API key: ${maskApiKey(process.env.VENICE_API_KEY || config.apiKey)}`);
    console.log(`Workspace: ${await getWorkspaceDir()}`);
    console.log(`Config file: ${getConfigPath()}`);
  });

configCommand
  .command('set-workspace <dir>')
  .description('Set the default project workspace')
  .action(async (dir: string) => {
    const workspace = await getWorkspaceDir(dir);
    await mkdir(workspace, { recursive: true });
    await updateUserConfig({ workspace });
    console.log(`Workspace set to: ${workspace}`);
  });

configCommand
  .command('unset-api-key')
  .description('Remove the stored API key')
  .action(async () => {
    await updateUserConfig({ apiKey: undefined });
    console.log('Stored API key removed.');
  });

program
  .command('doctor')
  .description('Check API credentials and local media dependencies')
  .option('--json', 'Emit the check results as JSON')
  .action(async (opts: { json?: boolean }) => {
    const json = wantsJson(opts);
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
    const record = (name: string, ok: boolean, detail?: string) => {
      checks.push({ name, ok, detail });
      if (!json) console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
    };
    const checkCommand = (name: string) => {
      const result = spawnSync(name, ['-version'], { stdio: 'ignore' });
      record(name, result.status === 0);
    };

    record('node', true, process.versions.node);
    checkCommand('ffmpeg');
    checkCommand('ffprobe');
    try {
      const apiKey = await getVeniceApiKey();
      await validateVeniceApiKey(apiKey);
      record('venice-api-key', true, maskApiKey(apiKey));
    } catch (error) {
      record('venice-api-key', false, (error as Error).message);
    }
    record('workspace', true, await getWorkspaceDir(program.opts().workspace));

    const failed = checks.some(c => !c.ok);
    if (json) emitJson({ ok: !failed, checks });
    if (failed) process.exitCode = 1;
  });

program
  .command('agent-guide')
  .description('Print the core rules for driving this CLI from an agent (ships inside the binary)')
  .option('--json', 'Emit the guide as JSON')
  .action((opts: { json?: boolean }) => {
    if (wantsJson(opts)) emitJson(guideAsJson());
    else console.log(formatGuide());
  });

program
  .command('pipeline')
  .description('Describe the production pipeline: ordered stages, gates, and the command that advances each')
  .option('--json', 'Emit the pipeline as JSON')
  .action((opts: { json?: boolean }) => {
    if (wantsJson(opts)) emitJson(pipelineAsJson());
    else console.log(formatPipeline());
  });

program
  .command('capabilities')
  .description('Emit the probe-verified capability manifest (model specs, capability sets, budgets, routing defaults) as JSON — the machine-readable registry downstream clients sync against')
  .action(() => {
    // Always JSON — the manifest IS the output format.
    process.stdout.write(renderCapabilitiesManifest());
  });

program
  .command('update')
  .alias('upgrade')
  .description('Install the latest published version of the CLI')
  .option('--check', 'Report whether a newer version exists without installing it', false)
  .option('--tag <tag>', 'npm dist-tag to install', 'latest')
  .option('--force', 'Reinstall even when already on the target version', false)
  .option('--dry-run', 'Print the install command instead of running it', false)
  .action(async (opts: { check: boolean; tag: string; force: boolean; dryRun: boolean }) => {
    const install = currentInstall();
    console.log(`Installed  ${packageVersion}  (${install.packageDir})`);

    process.stdout.write(`Published  checking ${opts.tag}... `);
    let target: string;
    try {
      target = await fetchPublishedVersion(opts.tag);
    } catch (error) {
      console.log('failed');
      console.error(`Could not reach the npm registry: ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
    console.log(target);

    const difference = compareVersions(packageVersion, target);

    // --check only ever reports, so it ignores --force.
    if (opts.check) {
      if (difference === 0) console.log(`\nAlready on the latest ${opts.tag} release.`);
      else if (difference > 0) console.log(`\nThis build is ahead of ${opts.tag} (${target}).`);
      else console.log(`\n${target} is available. Install it with: venice-video update`);
      return;
    }

    if (difference === 0 && !opts.force) {
      console.log(`\nAlready on the latest ${opts.tag} release.`);
      return;
    }
    if (difference > 0 && !opts.force) {
      // An unpublished dev build, or a dist-tag that was rolled back. Installing
      // would be a downgrade, so make that the operator's explicit choice.
      console.log(`\nThis build is ahead of ${opts.tag}. Use --force to install ${target} anyway.`);
      return;
    }

    // Deferred before anything else that writes: this process is running the
    // very files an install would replace.
    if (isSessionActive() && !opts.dryRun) {
      console.log(
        '\nThe interactive shell runs this package in-process, so installing over it now'
        + '\nwould leave one session running two versions. Exit the shell (Ctrl-D), then:'
        + '\n\n  venice-video update',
      );
      process.exitCode = 1;
      return;
    }

    if (install.kind !== 'npm-global') {
      console.log('');
      for (const line of manualUpdateInstructions(install)) console.log(line);
      process.exitCode = 1;
      return;
    }

    const spec = `${PACKAGE_NAME}@${target}`;
    const invocation = npmInvocation(install, spec);
    if (opts.dryRun) {
      console.log(`\nWould run:\n  ${[invocation.command, ...invocation.args].join(' ')}`);
      return;
    }

    console.log(`\nInstalling ${spec} into ${install.prefix}\n`);
    const status = runInstall(invocation);
    if (status !== 0) {
      console.error(`\nnpm exited ${status}. The previous version is still installed.`);
      process.exitCode = status;
      return;
    }

    const installed = readInstalledVersion(install.packageDir);
    if (installed && compareVersions(installed, target) !== 0) {
      console.error(
        `\nnpm reported success but ${install.packageDir} still holds ${installed}. `
        + 'Check whether another venice-video is earlier on your PATH: command -v venice-video',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`\nUpdated to ${installed ?? target}. Restart venice-video to pick it up.`);
  });

program
  .command('new')
  .description('Create a project with an interactive wizard; Film is the general-purpose option')
  .option('--type <type>', 'film | series | product-video | music-video | screenplay')
  .option('--route <route>', 'Render route: montage (advanced, for editors) | standard (beginner, more automated)')
  .option('-n, --name <name>', 'Project name')
  .option('--concept <concept>', 'Project concept or premise')
  .option('-g, --genre <genre>', 'Genre')
  .option('--setting <setting>', 'General setting description')
  .option('--audio-strategy <strategy>', 'native | lip-sync | narrator-vo')
  .option('--video-family <family>', 'auto | seedance | wan-3-0 | happyhorse | minimax-h3 | grok-imagine | kling-o3')
  .option('--intelligence <model>', `Reasoning model for workshop, script, and QA (default: ${DEFAULT_INTELLIGENCE_MODEL})`)
  .action(async (opts: {
    type?: string; route?: string; name?: string; concept?: string; genre?: string; setting?: string;
    audioStrategy?: string; videoFamily?: string; intelligence?: string;
  }) => {
    if (!stdin.isTTY && (!opts.type || !opts.name || !opts.concept)) {
      throw new Error('`venice-video new` needs an interactive terminal, or pass --type, --name, and --concept.');
    }
    if (stdin.isTTY) printSkippableQuestionsNote('the harness');
    const types = ['film', 'series', 'product-video', 'music-video', 'screenplay'] as const;
    const type = (opts.type ?? await promptChoice('What are you making?', [
      { label: 'Film', value: 'film', description: 'A film of any length; multi-shot and continuity-first' },
      { label: 'Series', value: 'series', description: 'Recurring episodes, characters, and locations' },
      { label: 'Product video', value: 'product-video', description: 'Branded launch, demo, or campaign film' },
      { label: 'Music video', value: 'music-video', description: 'Music-led visual production' },
      { label: 'Screenplay', value: 'screenplay', description: 'Start from a Fountain or PDF screenplay' },
    ])) as typeof types[number];
    if (!types.includes(type)) throw new Error(`--type must be one of: ${types.join(', ')}`);

    // Render route, asked up front: montage (advanced, cuts every clip inside
    // the generation for later editing) vs standard (beginner, more automated
    // per-shot planning but more prone to consistency drift). Maps to
    // videoDefaults.montageMode. Non-TTY without --route keeps the harness
    // default (montage-first).
    const renderRoute = (opts.route ?? (stdin.isTTY
      ? await promptChoice('Render route — how do you want to produce and edit this?', RENDER_ROUTE_CHOICES)
      : undefined)) as RenderRoute | undefined;
    if (renderRoute && !RENDER_ROUTES.has(renderRoute)) {
      throw new Error(`--route must be one of: ${[...RENDER_ROUTES].join(', ')}`);
    }
    const montageMode = montageModeForRoute(renderRoute);

    const name = opts.name ?? await promptText('Project name', { required: true });
    const concept = opts.concept ?? await promptText('Concept or premise', { required: true });
    const genre = opts.genre ?? (stdin.isTTY
      ? await promptText('Genre', { defaultValue: 'drama', required: true })
      : 'drama');
    const setting = opts.setting ?? (stdin.isTTY
      ? await promptText('Setting', { defaultValue: '', required: false })
      : '');
    const audioStrategy = (opts.audioStrategy ?? (stdin.isTTY ? await promptChoice('Audio strategy', AUDIO_STRATEGY_CHOICES) : 'native')) as 'native' | 'lip-sync' | 'narrator-vo';
    const videoFamily = (opts.videoFamily ?? (stdin.isTTY
      ? await promptChoice('Video model family', VIDEO_FAMILY_CHOICES)
      : 'auto')) as VideoFamilyPreference;
    if (!VIDEO_FAMILIES.has(videoFamily)) {
      throw new Error(`--video-family must be one of: ${[...VIDEO_FAMILIES].join(', ')}`);
    }
    const intelligenceModel = opts.intelligence ?? (stdin.isTTY
      ? await promptChoice(
        'Intelligence model — develops the story, writes the script, and reads the panels back during QA',
        INTELLIGENCE_CHOICES,
        INTELLIGENCE_CHOICES.findIndex(choice => choice.value === DEFAULT_INTELLIGENCE_MODEL),
      )
      : DEFAULT_INTELLIGENCE_MODEL);

    const workspace = await getWorkspaceDir(program.opts().workspace);
    await mkdir(workspace, { recursive: true });
    const series = createSeries(name, concept, genre, setting, {
      audioStrategy,
      videoFamilyPreference: videoFamily,
      montageMode,
      intelligenceModel,
      workspace,
      projectType: type,
    });
    await saveSeries(series);
    console.log(`\n${type === 'film' ? 'Film' : 'Project'} created: ${series.outputDir}`);
    console.log(`Render route: ${series.videoDefaults.montageMode === false ? 'standard (per-shot, more automated)' : 'montage (single-pass per scene, cut for editing)'}`);
    console.log(`Reference-first defaults: ${series.videoDefaults.characterConsistencyModel}`);
    console.log(`Intelligence: ${describeIntelligence(intelligenceModel)}`);
    const language = getProjectLanguage(series);
    console.log(`Next: venice-video workshop -p "${series.outputDir}"`);
  });

// ── workshop ─────────────────────────────────────────────────────────
program
  .command('workshop')
  .description('Develop the complete project: story, aesthetic, cast, locations, script, and production plan')
  .requiredOption('-p, --project <dir>', 'Project output directory')
  .option('--outcome <text>', 'Intended audience response or next action')
  .option('--objective <text>', '[Deprecated alias] Same as --outcome')
  .option('--duration <duration>', 'Target runtime, e.g. "8 minutes" or "90 seconds"')
  .option('--audience <text>', 'Intended audience')
  .option('--must-include <text>', 'Required story, visual, character, or product elements')
  .option('--avoid <text>', 'Things the project must avoid')
  .option('--references <path>', 'Reference file or directory path (you can drag it into the terminal)')
  .option('--delivery <target>', 'standard | 4k delivery master')
  .option('--feedback <text>', 'Revision feedback for the existing workshop')
  .option('--model <model>', "Override the project's intelligence model for this run")
  .option('--approve', 'Approve the current workshop and materialize its production state', false)
  .option('--status', 'Show current workshop status without generating', false)
  .action(async (opts: {
    project: string; outcome?: string; objective?: string; duration?: string; audience?: string;
    mustInclude?: string; avoid?: string; references?: string; delivery?: string; feedback?: string;
    model: string; approve: boolean; status: boolean;
  }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Project not found.'); process.exit(1); }
    const language = getProjectLanguage(series);
    const existing = await loadWorkshop(series);

    if (opts.status) {
      console.log(`${language.projectNoun} workshop: ${existing?.status ?? 'not started'}`);
      if (existing) {
        console.log(`  Revision: ${existing.revision}`);
        console.log(`  Logline: ${existing.logline}`);
        console.log(`  Script: ${existing.script.title} · ${existing.script.totalDuration} · ${existing.script.shots.length} shots`);
        console.log(`  Open questions: ${existing.productionNotes.openQuestions.length}`);
        console.log(`  Delivery: ${existing.productionNotes.delivery === '4k' ? '4K master after assembly' : 'Standard master'}`);
        console.log(`  Files: ${getWorkshopPath(series)} · ${join(series.outputDir, 'WORKSHOP.html')} · ${join(series.outputDir, 'WORKSHOP.md')}`);
      } else {
        console.log(`  Start: venice-video workshop -p "${series.outputDir}"`);
      }
      return;
    }

    if (opts.approve) {
      if (!existing) throw new Error('No workshop draft exists. Run `venice-video workshop` first.');
      await approveWorkshop(series, existing);
      await refreshTreatment(series, { episode: existing.script.episode });
      console.log(`${language.projectNoun} workshop approved.`);
      console.log('  Aesthetic, characters, locations, and script are now production state.');
      const approvedHtmlPath = join(series.outputDir, 'WORKSHOP.html');
      console.log(`  Review the approved workshop: ${approvedHtmlPath}`);
      if (openInDefaultBrowser(approvedHtmlPath)) console.log('  Opened workshop in your default browser.');
      console.log('  The workshop remains your control center:');
      console.log(`    venice-video workshop -p "${series.outputDir}" --status`);
      console.log(`    venice-video workshop -p "${series.outputDir}" --feedback "..."`);
      console.log(`  When ready to create images: venice-video storyboard-episode -p "${series.outputDir}" -e 1`);
      return;
    }

    if (opts.delivery && !['standard', '4k'].includes(opts.delivery)) {
      throw new Error('--delivery must be standard or 4k');
    }
    const previousInputs = existing?.inputs;
    if (stdin.isTTY) printSkippableQuestionsNote();
    const ask = async (label: string, value: string | undefined, fallback = '') =>
      value ?? (stdin.isTTY ? await promptText(label, { defaultValue: fallback, required: false }) : fallback);
    const inputs: WorkshopInputs = {
      objective: await ask(
        `${language.outcomeQuestion}\n${language.outcomeHelp}\nYour answer`,
        opts.outcome ?? opts.objective,
        previousInputs?.objective ?? '',
      ),
      targetDuration: await ask('Target runtime', opts.duration, previousInputs?.targetDuration ?? language.defaultDuration),
      audience: await ask(language.audienceQuestion, opts.audience, previousInputs?.audience ?? ''),
      mustInclude: await ask('What must be included?', opts.mustInclude, previousInputs?.mustInclude ?? ''),
      avoid: await ask('What should it avoid?', opts.avoid, previousInputs?.avoid ?? ''),
      references: await ask(
        'Reference files (drag a file or folder in from Finder)',
        opts.references,
        previousInputs?.references ?? '',
      ),
      delivery: (opts.delivery ?? (stdin.isTTY
        ? await promptChoice('Final delivery', [
            { label: 'Standard master', value: 'standard', description: 'Keep the assembled resolution' },
            { label: '4K master', value: '4k', description: 'Upscale the approved final cut after assembly' },
          ], previousInputs?.delivery === '4k' ? 1 : 0)
        : previousInputs?.delivery ?? 'standard')) as 'standard' | '4k',
    };

    if (inputs.references.trim()) {
      inputs.referenceSources = await inventoryReferencePath(inputs.references);
      console.log(`Reference inventory: ${inputs.referenceSources.length} file(s)`);
      const counts = inputs.referenceSources.reduce<Record<string, number>>((acc, source) => {
        acc[source.kind] = (acc[source.kind] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`  ${Object.entries(counts).map(([kind, count]) => `${kind}: ${count}`).join(' · ')}`);
    } else {
      inputs.referenceSources = [];
      console.log('No references supplied — the workshop will propose creative choices from your concept.');
    }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const intelligence = intelligenceFor(series, opts.model);
    console.log(`${existing ? 'Revising' : 'Developing'} the complete ${language.projectNounLower} workshop...`);
    console.log(`Intelligence: ${describeIntelligence(intelligence.model)}`);
    const draft = await generateWorkshop(client, series, inputs, intelligence.model, existing, opts.feedback);
    await saveWorkshop(series, draft);

    console.log(`Workshop draft ready — revision ${draft.revision}.`);
    console.log(`  Logline: ${draft.logline}`);
    console.log(`  Structure: ${draft.structure.length} movements`);
    console.log(`  Cast: ${draft.characters.length} characters`);
    console.log(`  Locations: ${draft.locations.length}`);
    console.log(`  Script: ${draft.script.title} · ${draft.script.totalDuration} · ${draft.script.shots.length} shots`);
    console.log(`  Open questions: ${draft.productionNotes.openQuestions.length}`);
    console.log(`  Delivery: ${draft.productionNotes.delivery === '4k' ? '4K master after assembly' : 'Standard master'}`);
    const htmlPath = join(series.outputDir, 'WORKSHOP.html');
    console.log(`  Review: ${htmlPath}`);
    if (openInDefaultBrowser(htmlPath)) console.log('  Opened workshop in your default browser.');
    else console.log('  Open the HTML file above in your browser.');
    console.log('  Keep the tab open — every production step rewrites this page with');
    console.log('  the new panels, clips and QA verdicts. Reload to see progress.');
    console.log(`  Revise: venice-video workshop -p "${series.outputDir}" --feedback "..."`);
    console.log(`  Approve: venice-video workshop -p "${series.outputDir}" --approve`);
  });

// ── new-series ────────────────────────────────────────────────────────
program
  .command('new-series')
  .description('Create a new mini-drama series')
  .requiredOption('-n, --name <name>', 'Series name')
  .requiredOption('--concept <concept>', 'Series concept/premise')
  .option('-g, --genre <genre>', 'Genre', 'drama')
  .option('--setting <setting>', 'General setting description', '')
  // ── Upfront questionnaire (production-audit follow-up) ──
  // These two flags let the operator answer the "what kind of show is this?"
  // questions at series-creation time, eliminating three classes of bugs we
  // hit producing the PNW field-guide. The MCP's pipeline skill prompts for
  // them before calling `series.new`.
  .option(
    '--audio-strategy <strategy>',
    'How dialogue reaches the final mix: ' +
    '"native" (selected model speaks in-frame; Seedance/HappyHorse use voice-donor references when available), ' +
    '"lip-sync" (exact mode: Venice speech is passed to the model as an audio file and the mouth follows it — in-family on Seedance 2.x and MiniMax H3, via Wan 2.7 elsewhere), ' +
    '"narrator-vo" (NARRATOR voice-over only; auto-mutes the model audio so a competing AI narrator can\'t fight the TTS).',
  )
  .option(
    '--video-family <family>',
    'Preferred video model family: ' +
    'auto (default Seedance 2.0), seedance, wan-3-0, happyhorse, minimax-h3, grok-imagine, kling-o3. ' +
    'Swaps actionModel/atmosphereModel/characterConsistencyModel to that family. ' +
    'lipSyncModel is only used for the explicit exact lip-sync strategy. ' +
    'Omit it on an interactive terminal and you will be asked.',
  )
  .option(
    '--route <route>',
    'Render route: "montage" (advanced/editor — one single-pass Seedance 2.5 generation per scene, auto-cut into a media library for later editing; strongest continuity) or ' +
    '"standard" (beginner — 2.0-era per-shot / short multi-shot planning, more automated but more prone to consistency drift). ' +
    'Omit it on an interactive terminal and you will be asked; omit it without a TTY to keep the montage-first default.',
  )
  .option(
    '--intelligence <model>',
    'Reasoning model that develops the story, writes the script, and reads panels back during QA. ' +
    `Defaults to ${DEFAULT_INTELLIGENCE_MODEL}. A text-only choice pairs with a vision model from the same privacy tier.`,
  )
  .action(async (opts: {
    name: string; concept: string; genre: string; setting: string;
    audioStrategy?: string; videoFamily?: string; route?: string; intelligence?: string;
  }) => {
    const allowedAudio = new Set(['native', 'lip-sync', 'narrator-vo']);
    if (opts.audioStrategy && !allowedAudio.has(opts.audioStrategy)) {
      console.error(`--audio-strategy must be one of: ${[...allowedAudio].join(', ')}`);
      process.exit(2);
    }
    if (opts.videoFamily && !VIDEO_FAMILIES.has(opts.videoFamily)) {
      console.error(`--video-family must be one of: ${[...VIDEO_FAMILIES].join(', ')}`);
      process.exit(2);
    }
    if (opts.route && !RENDER_ROUTES.has(opts.route)) {
      console.error(`--route must be one of: ${[...RENDER_ROUTES].join(', ')}`);
      process.exit(2);
    }
    // Ask on a real terminal; stay silent for the MCP and CI, which spawn this
    // command without a TTY and rely on the harness defaults when the flag is
    // absent.
    const videoFamily = opts.videoFamily
      ?? (stdin.isTTY ? await promptChoice('Video model family', VIDEO_FAMILY_CHOICES) : undefined);
    const renderRoute = (opts.route
      ?? (stdin.isTTY ? await promptChoice('Render route', RENDER_ROUTE_CHOICES) : undefined)) as RenderRoute | undefined;

    const series = createSeries(opts.name, opts.concept, opts.genre, opts.setting, {
      workspace: await getWorkspaceDir(program.opts().workspace),
      audioStrategy: opts.audioStrategy as 'native' | 'lip-sync' | 'narrator-vo' | undefined,
      videoFamilyPreference: videoFamily as VideoFamilyPreference | undefined,
      montageMode: montageModeForRoute(renderRoute),
      intelligenceModel: opts.intelligence,
    });
    await saveSeries(series);

    console.log(`\nSeries created: ${series.name}`);
    console.log(`  Slug: ${series.slug}`);
    console.log(`  Genre: ${series.genre}`);
    console.log(`  Concept: ${series.concept}`);
    console.log(`  Output: ${series.outputDir}`);
    console.log(`  Render route: ${series.videoDefaults.montageMode === false ? 'standard (per-shot, more automated)' : 'montage (single-pass per scene, cut for editing)'}`);
    if (series.videoDefaults.audioStrategy) {
      console.log(`  Audio strategy: ${series.videoDefaults.audioStrategy}`);
    }
    if (series.videoDefaults.videoFamilyPreference) {
      console.log(`  Video family: ${series.videoDefaults.videoFamilyPreference}`);
      console.log(`    actionModel: ${series.videoDefaults.actionModel}`);
      console.log(`    characterConsistencyModel: ${series.videoDefaults.characterConsistencyModel}`);
    }
    console.log(`\nNext: venice-video workshop -p "${series.outputDir}"`);
  });

// ── new-script / new-episode ─────────────────────────────────────────
async function scaffoldScript(opts: { project: string; title: string }): Promise<void> {
  const series = await loadSeries(resolve(opts.project));
  if (!series) { console.error('Project not found.'); process.exit(1); }

  const language = getProjectLanguage(series);
  const episode = addEpisode(series, opts.title);
  const episodeDir = getEpisodeDir(series, episode.number);
  const sceneDir = join(episodeDir, 'scene-001');
  const audioDir = join(episodeDir, 'audio');
  await mkdir(sceneDir, { recursive: true });
  await mkdir(audioDir, { recursive: true });

  const templateScript = {
    episode: episode.number,
    title: opts.title,
    seriesName: series.name,
    totalDuration: language.defaultDuration,
    shots: [],
  };
  await writeFile(
    join(episodeDir, 'script.json'),
    JSON.stringify(templateScript, null, 2),
    'utf-8',
  );
  await saveSeries(series);

  console.log(`\n${language.scriptNoun} created: "${opts.title}"`);
  console.log(`  ${language.segmentNoun}: ${episode.number}`);
  console.log(`  Directory: ${episodeDir}`);
  console.log(`  Script: ${join(episodeDir, 'script.json')} (empty template — workshop your shots)`);
  console.log(`\nContinue the complete creative process: venice-video workshop -p "${series.outputDir}"`);
}

program
  .command('new-script')
  .description('Create a script container using Film or Series terminology')
  .requiredOption('-p, --project <dir>', 'Project output directory')
  .requiredOption('-t, --title <title>', 'Script title')
  .action(scaffoldScript);

program
  .command('new-episode')
  .description('[Compatibility alias] Create the next script container')
  .requiredOption('-p, --project <dir>', 'Project output directory')
  .requiredOption('-t, --title <title>', 'Script title')
  .action(scaffoldScript);

// ── list-series ───────────────────────────────────────────────────────
program
  .command('list-series')
  .description('List all mini-drama series')
  .action(async () => {
    const all = await listSeries(await getWorkspaceDir(program.opts().workspace));
    if (all.length === 0) {
      console.log('No projects found. Create one with: venice-video new');
      return;
    }
    console.log('Venice Video projects:');
    for (const s of all) {
      console.log(`  ${s.name} (${s.slug}) -> ${s.dir}`);
    }
  });

// ── explore-aesthetic ─────────────────────────────────────────────────
program
  .command('explore-aesthetic')
  .description('Generate aesthetic comparison samples for a series')
  .requiredOption('-p, --project <dir>', 'Project output directory')
  .option('--count <n>', 'Number of aesthetic variants', '5')
  .action(async (opts: { project: string; count: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Project not found.'); process.exit(1); }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const count = parseInt(opts.count);

    const samplesDir = join(series.outputDir, 'aesthetic-samples');
    await mkdir(samplesDir, { recursive: true });

    const sceneDescription = series.setting || series.concept;

    const aestheticStyles = [
      { name: 'anime-noir', style: 'Dark anime noir', palette: 'high contrast shadows with neon accents', lighting: 'dramatic rim lighting, hard shadows', lens: 'wide-angle with depth', film: 'digital anime rendering with grain' },
      { name: 'manhwa-realism', style: 'Korean manhwa semi-realism', palette: 'rich saturated colors, warm skin tones', lighting: 'soft cinematic lighting with bokeh', lens: 'portrait lens shallow depth of field', film: 'digital illustration with painterly finish' },
      { name: 'retro-anime', style: '90s anime cel-shaded', palette: 'vintage warm tones, sunset palette', lighting: 'flat cel-shading with dramatic highlights', lens: 'standard composition', film: '35mm anime film grain' },
      { name: 'hyper-stylized', style: 'Hyper-stylized digital illustration', palette: 'vibrant pop colors with dark contrasts', lighting: 'dramatic chiaroscuro with color splashes', lens: 'dynamic angles and foreshortening', film: 'clean digital with subtle texture' },
      { name: 'webtoon-drama', style: 'Webtoon drama illustration', palette: 'moody desaturated with selective color', lighting: 'atmospheric with volumetric light', lens: 'cinematic wide and close alternation', film: 'soft digital brushwork' },
      { name: 'neo-baroque', style: 'Neo-baroque dramatic illustration', palette: 'deep golds, crimsons, and midnight blues', lighting: 'Caravaggio-inspired chiaroscuro', lens: 'classical composition', film: 'oil painting texture overlay' },
      { name: 'cyberpunk-anime', style: 'Cyberpunk anime', palette: 'electric blue, magenta, toxic green on black', lighting: 'neon glow with rain reflections', lens: 'dutch angles, extreme perspective', film: 'digital with chromatic aberration' },
    ];

    const selected = aestheticStyles.slice(0, count);

    console.log(`Generating ${selected.length} aesthetic samples...`);
    console.log(`Scene: ${sceneDescription}\n`);

    for (const aes of selected) {
      const prompt = `${sceneDescription}. ${aes.style}, ${aes.palette}, ${aes.lighting}, ${aes.lens}, ${aes.film}. Beautiful elegant woman with hourglass figure and handsome man, dramatic scene.`;

      try {
        const response = await generateImage(client, {
          prompt,
          negative_prompt: 'deformed, blurry, bad anatomy, low quality, text, watermark',
          resolution: '1K',
          aspect_ratio: '9:16',
          steps: 30,
          cfg_scale: 7,
          safe_mode: false,
          hide_watermark: true,
        });

        if (response.images?.[0]) {
          const imgBuffer = Buffer.from(response.images[0].b64_json, 'base64');
          const imgPath = await writeImageBytesSmart(imgBuffer, join(samplesDir, `${aes.name}.png`));
          console.log(`  ${aes.name}: ${imgPath}`);
        }
      } catch (err) {
        console.warn(`  Failed: ${aes.name} - ${err}`);
      }
    }

    const html = generateCompareHtml(selected, series.name);
    const htmlPath = join(samplesDir, 'compare.html');
    await writeFile(htmlPath, html, 'utf-8');
    console.log(`\nComparison page: ${htmlPath}`);
    console.log(`Pick a style and run: set-aesthetic -p ${series.outputDir} --style "..." --palette "..." ...`);
  });

// ── set-aesthetic ─────────────────────────────────────────────────────
program
  .command('set-aesthetic')
  .description('Lock the visual aesthetic for the series')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('--style <style>', 'Visual style')
  .requiredOption('--palette <palette>', 'Color palette')
  .requiredOption('--lighting <lighting>', 'Lighting approach')
  .option('--lens <lens>', 'Lens characteristics', 'cinematic depth of field')
  .option('--film <film>', 'Film stock/texture', 'digital illustration')
  .action(async (opts: { project: string; style: string; palette: string; lighting: string; lens: string; film: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const aesthetic: AestheticProfile = {
      style: opts.style,
      palette: opts.palette,
      lighting: opts.lighting,
      lensCharacteristics: opts.lens,
      filmStock: opts.film,
    };

    series.aesthetic = aesthetic;
    await saveSeries(series);

    console.log('Aesthetic locked:');
    Object.entries(aesthetic).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
    console.log(`\nNext: add-character -p ${series.outputDir} --name "CHARACTER" --gender female`);
  });

// ── add-character ─────────────────────────────────────────────────────
program
  .command('add-character')
  .description('Add and generate reference images for a character')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('--name <name>', 'Character name')
  .requiredOption('--gender <gender>', 'Gender (male/female/other)')
  .option('--age <age>', 'Age description', 'mid 20s')
  .option('--description <desc>', 'Physical description')
  .option('--wardrobe <wardrobe>', 'Default wardrobe', 'stylish contextual attire')
  .option('--voice-desc <voiceDesc>', 'Voice description (pitch, timbre, accent, cadence)')
  .option('--base-traits <traits>', 'Custom base traits override (e.g. "tabby cat, feline, four legs")')
  .option('--skip-images', 'Skip reference image generation', false)
  // Override-prompt path: read positive / negative prompts (and optionally
  // model / cfg / aspect) from a JSON file and use them verbatim, bypassing
  // buildCharacterReferencePromptParts entirely. Lets operators rescue a
  // character whose default-prompt outputs keep failing (the LEGISLATOR-as-bird
  // and FOUNDER-identity-drift episodes during the PNW field-guide all needed
  // this). When the file omits a field, the default builder fills it.
  // File shape (any subset valid):
  //   {
  //     "angles": {
  //       "front":         { "positive": "...", "negative": "..." },
  //       "three-quarter": { ... },
  //       "profile":       { ... },
  //       "full-body":     { ... }
  //     },
  //     "shared": { "model": "seedream-v5-lite", "cfg_scale": 9,
  //                 "aspect_ratio": "1:1", "resolution": "1K", "seed": 42 }
  //   }
  .option('--override-prompt <path>', 'Path to a JSON file containing per-angle prompt overrides (see header comment in cli.ts add-character)')
  .action(async (opts: {
    project: string; name: string; gender: string; age: string;
    description?: string; wardrobe: string; voiceDesc?: string; baseTraits?: string; skipImages: boolean;
    overridePrompt?: string;
  }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const baseTraits = opts.baseTraits ?? (opts.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS);
    const physicalDesc = opts.description || `${opts.age}, ${baseTraits}`;

    const defaultVoice = opts.gender === 'female'
      ? 'smooth, confident feminine voice, medium pitch, clear diction, measured pacing'
      : 'deep, resonant masculine voice, low pitch, authoritative tone, steady cadence';
    const voiceDescription = opts.voiceDesc || defaultVoice;

    const seed = Math.abs([...opts.name].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)) % 999_999_999;

    const character: MiniDramaCharacter = {
      name: opts.name.toUpperCase(),
      gender: opts.gender as 'male' | 'female' | 'other',
      age: opts.age,
      description: physicalDesc,
      fullDescription: `${opts.name}, ${opts.age}, ${physicalDesc}`,
      wardrobe: opts.wardrobe,
      voiceDescription,
      ...(opts.baseTraits ? { baseTraits: opts.baseTraits } : {}),
      locked: false,
      seed,
    };

    addCharacter(series, character);

    if (!opts.skipImages && series.aesthetic) {
      const apiKey = await getVeniceApiKey();
      const client = new VeniceClient(apiKey);
      const charDir = getCharacterDir(series, character.name);
      await mkdir(charDir, { recursive: true });

      // Optional operator override: read positive/negative prompts (and a
      // small set of shared params) from a JSON file. Lets the operator
      // rescue a character whose default-prompt outputs keep failing.
      type OverrideFile = {
        angles?: Record<string, { positive?: string; negative?: string }>;
        shared?: {
          model?: string;
          cfg_scale?: number;
          aspect_ratio?: string;
          resolution?: string;
          seed?: number;
        };
      };
      let override: OverrideFile = {};
      if (opts.overridePrompt) {
        try {
          const raw = await readFile(resolve(opts.overridePrompt), 'utf-8');
          override = JSON.parse(raw) as OverrideFile;
          console.log(`  Using prompt overrides from ${opts.overridePrompt}`);
        } catch (err) {
          console.warn(`  Failed to read --override-prompt ${opts.overridePrompt}: ${(err as Error).message}`);
        }
      }
      const sharedModel = override.shared?.model ?? DEFAULT_IMAGE_GENERATION_MODEL;
      const sharedCfg = override.shared?.cfg_scale ?? 10;
      const sharedAspect = override.shared?.aspect_ratio ?? '1:1';
      const sharedResolution = override.shared?.resolution ?? '1K';
      const sharedSeed = override.shared?.seed ?? seed;

      const angles: ('front' | 'three-quarter' | 'profile' | 'full-body')[] = ['front', 'three-quarter', 'profile', 'full-body'];
      const filenames = ['front.png', 'three-quarter.png', 'profile.png', 'full-body.png'];

      console.log(`Generating reference images for ${character.name}...`);

      for (let i = 0; i < angles.length; i++) {
        const angle = angles[i];
        const angleOverride = override.angles?.[angle];

        // Default prompt build (still used when override.angles[angle].positive
        // is missing). structured prompt keeps the positive prompt under the
        // model's silent-reject ceiling and pushes style-reminder cues
        // into negative_prompt.
        const { positive: defaultPositive, negativeAdditions } =
          buildCharacterReferencePromptParts(character, series.aesthetic, angle, {
            model: sharedModel,
            negativePromptStrategy: series.videoDefaults.imageDefaults?.negativePromptStrategy ?? 'auto',
          });
        const prompt = angleOverride?.positive ?? defaultPositive;
        const baseNegatives = [
          'deformed', 'blurry', 'bad anatomy', 'low quality',
          'multiple people', 'watermark',
          'character reference sheet', 'comic panels', 'panel borders',
        ];
        const negativePrompt = angleOverride?.negative
          ?? [...baseNegatives, ...negativeAdditions].join(', ');

        try {
          const response = await generateImage(client, {
            model: sharedModel,
            prompt,
            negative_prompt: negativePrompt,
            resolution: sharedResolution,
            aspect_ratio: sharedAspect,
            steps: 30,
            cfg_scale: sharedCfg,
            seed: sharedSeed,
            safe_mode: false,
            hide_watermark: true,
          });

          if (response.images?.[0]) {
            const imgBuffer = Buffer.from(response.images[0].b64_json, 'base64');
            const finalPath = await writeImageBytesSmart(imgBuffer, join(charDir, filenames[i]));
            console.log(`  ${angle}: saved -> ${basename(finalPath)}`);

            // Sidecar: capture the resolved prompt + params for this angle so
            // operators can hand-edit and re-run with --override-prompt.
            const returnedSeed = (response.images[0] as { seed?: number }).seed;
            const sidecarPath = join(charDir, `${angle}.prompt.json`);
            const sidecar = {
              character: character.name,
              angle,
              model: sharedModel,
              prompt,
              negative_prompt: negativePrompt,
              cfg_scale: sharedCfg,
              aspect_ratio: sharedAspect,
              resolution: sharedResolution,
              seed: sharedSeed,
              returnedSeed,
              overrideSource: opts.overridePrompt ?? null,
              generatedAt: new Date().toISOString(),
            };
            await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf-8');

            // Recipe sidecar (same info, unified format used by every asset
            // in the project — panels, videos, and refs all carry one).
            await appendRecipePass(finalPath, {
              kind: 'generate',
              role: 'identity',
              model: sharedModel,
              label: `character reference (${character.name}, ${angle})`,
              prompt,
              negativePrompt,
              seed: sharedSeed,
              cfgScale: sharedCfg,
              aspectRatio: sharedAspect,
              resolution: sharedResolution,
              extra: returnedSeed !== undefined ? { returnedSeed } : undefined,
            }, { provenance: 'generate', hasFace: true });
          }
        } catch (err) {
          console.warn(`  ${angle}: failed - ${err}`);
        }
      }

      character.locked = true;
      await writeFile(
        join(charDir, 'character.json'),
        JSON.stringify(character, null, 2),
        'utf-8',
      );
    }

    await saveSeries(series);
    console.log(`\nCharacter added: ${character.name}`);
    console.log(`Next: audition-voices -p ${series.outputDir} --character "${character.name}"`);
  });

// ── audition-voices ───────────────────────────────────────────────────
program
  .command('audition-voices')
  .description('Generate Venice TTS voice samples for a character')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-c, --character <name>', 'Character name')
  .option('--sample-text <text>', 'Sample line for audition')
  .option('--count <n>', 'Number of voice candidates', '5')
  .action(async (opts: { project: string; character: string; sampleText?: string; count: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const char = getCharacter(series, opts.character);
    if (!char) { console.error(`Character "${opts.character}" not found.`); process.exit(1); }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);

    const sampleText = opts.sampleText || `You crossed the line tonight. I expected better from you.`;

    console.log(`Loading Venice voice catalog...`);
    const allVoices = await listVoices();
    const gender = char.gender === 'other' ? undefined : char.gender;
    const filtered = filterVoices(allVoices, gender);

    const candidates = filtered.slice(0, parseInt(opts.count));
    console.log(`Found ${filtered.length} matching voices, auditioning ${candidates.length}...`);

    const charDir = getCharacterDir(series, char.name);
    const samplesDir = join(charDir, 'voice-samples');

    const results = await auditionVoices(client, candidates, sampleText, samplesDir);

    console.log(`\nVoice samples saved to: ${samplesDir}`);
    console.log('Listen and pick a voice, then run:');
    console.log(`  lock-character -p ${series.outputDir} -c "${char.name}" --voice-id <VOICE_ID>`);
    console.log('\nAvailable voices:');
    for (const r of results) {
      console.log(`  ${r.voiceName}: ${r.voiceId}`);
    }
  });

// ── lock-character ────────────────────────────────────────────────────
program
  .command('lock-character')
  .description('Finalize a character with selected voice')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-c, --character <name>', 'Character name')
  .requiredOption('--voice-id <id>', 'Venice voice ID')
  .option('--voice-name <name>', 'Display name for the voice')
  .option('--voice-reference <file>', 'Path to an operator-supplied voice-donor clip (wav/mp3, normalized to 2-15s) used as reference_audio_urls on Seedance/HappyHorse R2V shots')
  .action(async (opts: { project: string; character: string; voiceId: string; voiceName?: string; voiceReference?: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const char = getCharacter(series, opts.character);
    if (!char) { console.error(`Character "${opts.character}" not found.`); process.exit(1); }

    char.voiceId = opts.voiceId;
    char.voiceName = opts.voiceName || opts.voiceId;
    char.locked = true;

    if (opts.voiceReference) {
      const apiKey = await getVeniceApiKey();
      const client = new VeniceClient(apiKey);
      const { relPath, model } = await generateVoiceReference(client, series, char, { file: opts.voiceReference });
      char.voiceReferencePath = relPath;
      char.voiceReferenceModel = model;
      console.log(`  Voice reference imported: ${relPath} (${model})`);
    }

    const charDir = getCharacterDir(series, char.name);
    if (existsSync(charDir)) {
      await writeFile(
        join(charDir, 'character.json'),
        JSON.stringify(char, null, 2),
        'utf-8',
      );
    }

    await saveSeries(series);
    console.log(`Character locked: ${char.name}`);
    console.log(`  Voice: ${char.voiceName} (${char.voiceId})`);
  });

// ── generate-voice-reference ──────────────────────────────────────────
program
  .command('generate-voice-reference')
  .description('Generate (or import) a voice-donor reference clip for a character, used as reference_audio_urls (@AudioN) on Seedance/HappyHorse R2V shots')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-c, --character <name>', 'Character name')
  .option('--text <text>', 'Spoken text to render (defaults to a neutral sample steered by voiceDescription)')
  .option('--voice <voice>', 'Named seed-audio voice (defaults to describe-in-prompt steering via voiceDescription)')
  .option('--speed <speed>', 'Playback speed 0.5-2', parseFloat)
  .option('--file <file>', 'Import an operator-supplied clip verbatim instead of generating')
  .option('--model <model>', 'Override the seed-audio model id')
  .action(async (opts: { project: string; character: string; text?: string; voice?: string; speed?: number; file?: string; model?: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const char = getCharacter(series, opts.character);
    if (!char) { console.error(`Character "${opts.character}" not found.`); process.exit(1); }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);

    const { relPath, model } = await generateVoiceReference(client, series, char, {
      text: opts.text,
      voice: opts.voice,
      speed: opts.speed,
      file: opts.file,
      model: opts.model,
    });
    char.voiceReferencePath = relPath;
    char.voiceReferenceModel = model;

    const charDir = getCharacterDir(series, char.name);
    if (existsSync(charDir)) {
      await writeFile(join(charDir, 'character.json'), JSON.stringify(char, null, 2), 'utf-8');
    }
    await saveSeries(series);
    console.log(`\nVoice reference set for ${char.name}: ${relPath} (${model})`);
  });

// ── add-location ──────────────────────────────────────────────────────
program
  .command('add-location')
  .description('Add and generate reference images for a location (wide / medium / detail)')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('--name <name>', 'Location name')
  .requiredOption('--description <desc>', 'Locked prose description of the environment')
  .option('--lighting <notes>', 'Lighting notes carried into every panel prompt for this location')
  .option(
    '--spatial-anchors <text>',
    'Locked geography: 3-5 named landmarks and their fixed relative positions (e.g. "bar counter along the back wall; entrance door opposite it; neon window left of the door"). Carried into every panel/plate/video prompt so blocking language resolves to the same layout in every shot.',
  )
  .option('--model <model>', 'Image-generation model for the reference angles (default nano-banana-pro)')
  .option('--skip-images', 'Skip reference image generation', false)
  .action(async (opts: { project: string; name: string; description: string; lighting?: string; spatialAnchors?: string; model?: string; skipImages: boolean }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const slug = locationSlugify(opts.name);
    const seed = Math.abs([...opts.name].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)) % 999_999_999;

    const location: Location = {
      name: opts.name,
      slug,
      description: opts.description,
      ...(opts.lighting ? { lightingNotes: opts.lighting } : {}),
      ...(opts.spatialAnchors ? { spatialAnchors: opts.spatialAnchors } : {}),
      seed,
      ...(opts.model ? { referenceModel: opts.model } : {}),
    };

    addLocation(series, location);

    if (!opts.skipImages && series.aesthetic) {
      const apiKey = await getVeniceApiKey();
      const client = new VeniceClient(apiKey);
      console.log(`Generating reference images for location "${location.name}"...`);
      const { generated, skipped } = await generateLocationReferences(client, series, location, {
        model: opts.model,
      });
      console.log(`  Generated ${generated.length} angle(s)${skipped.length ? `, skipped ${skipped.length} existing` : ''}`);
    }

    await saveSeries(series);
    console.log(`\nLocation added: ${location.name} (${slug})`);
  });

// ── generate-location-references ──────────────────────────────────────
program
  .command('generate-location-references')
  .description('Generate (or regenerate) reference images for an existing location')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-l, --location <slugOrName>', 'Location slug or name')
  .option('--model <model>', 'Override the image-generation model')
  .option('--force', 'Regenerate angles that already exist (archives prior versions)', false)
  .action(async (opts: { project: string; location: string; model?: string; force: boolean }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const location = getLocation(series, opts.location);
    if (!location) { console.error(`Location "${opts.location}" not found.`); process.exit(1); }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const { generated, skipped } = await generateLocationReferences(client, series, location, {
      model: opts.model,
      force: opts.force,
    });
    console.log(`\nLocation references for ${location.name}: generated ${generated.length}, skipped ${skipped.length}`);
  });

// ── generate-storyboard-refs ──────────────────────────────────────────
program
  .command('generate-storyboard-refs')
  .description('Plan + generate composed storyboard blocking plates (multi-character beats) for an episode')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--slug <slug>', 'Regenerate only this plate (must already be planned in script.json)')
  .option('--model <model>', 'Override the image-generation model')
  .option('--force', 'Regenerate plates that already exist (archives prior versions)', false)
  .action(async (opts: { project: string; episode: number; slug?: string; model?: string; force: boolean }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);

    if (opts.slug) {
      const ref = (script.storyboardRefs ?? []).find(r => r.slug === opts.slug);
      if (!ref) { console.error(`Storyboard ref "${opts.slug}" not planned in this episode.`); process.exit(1); }
      const result = await generateStoryboardReference(client, series, ref, {
        model: opts.model, force: opts.force,
      });
      console.log(`\nStoryboard plate ${result.skipped ? 'reused' : 'generated'}: ${result.path}`);
    } else {
      const { generated, skipped } = await ensureEpisodeStoryboardReferences(client, series, script, {
        model: opts.model, force: opts.force,
      });
      console.log(`\nStoryboard plates: generated ${generated.length}, reused ${skipped.length}`);
      for (const ref of script.storyboardRefs ?? []) {
        console.log(`  ${ref.slug}: shots ${ref.shotIds.join(', ')} — ${ref.characters.join(' + ')}${ref.location ? ` @ ${ref.location}` : ''}`);
      }
    }

    await saveEpisodeScript(series, script);
    await saveSeries(series);
  });

// ── workshop-episode ──────────────────────────────────────────────────
program
  .command('workshop-script')
  .alias('workshop-episode')
  .description('Generate a Film- or Series-aware script draft using Venice LLM')
  .requiredOption('-p, --project <dir>', 'Project output directory')
  .option('-e, --episode <number>', 'Script part number (compatibility flag)', parseInt)
  .option('--part <number>', 'Script part number', parseInt)
  .requiredOption('--concept <text>', 'Film/part concept, including target duration when relevant')
  .option('--model <model>', "Override the project's intelligence model for this run")
  .action(async (opts: { project: string; episode: number; part?: number; concept: string; model: string }) => {
    opts.episode = opts.part ?? opts.episode ?? 1;
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Project not found.'); process.exit(1); }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);

    // Gather series-level reference docs (*.md in series root)
    const seriesDir = series.outputDir;
    const mdFiles = readdirSync(seriesDir)
      .filter((f: string) => f.endsWith('.md'))
      .sort();
    let referenceContext = '';
    for (const f of mdFiles) {
      const content = await readFile(join(seriesDir, f), 'utf-8');
      referenceContext += `\n--- ${f} ---\n${content}\n`;
    }

    const language = getProjectLanguage(series);

    // Gather prior script-part summaries for continuity
    let priorEpisodes = '';
    for (const ep of series.episodes) {
      const script = await loadEpisodeScript(series, ep.number);
      if (script && script.shots.length > 0) {
        const dialogueLines = script.shots
          .filter(s => s.dialogue)
          .map(s => `  ${s.dialogue!.character}: "${s.dialogue!.line}"`)
          .join('\n');
        priorEpisodes += `\n${language.segmentNoun} ${ep.number} ("${ep.title}"): ${script.shots.length} shots, ${script.totalDuration}\n`;
        if (dialogueLines) priorEpisodes += `Key dialogue:\n${dialogueLines}\n`;
      }
    }

    // Build character summaries
    const charSummaries = series.characters.map(c => {
      const baseTraits = c.baseTraits ?? (c.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS);
      return `${c.name} (${c.gender}, ${c.age}): ${baseTraits}. ${c.fullDescription}. Wardrobe: ${c.wardrobe}. Voice: ${c.voiceDescription}`;
    }).join('\n');

    // Build aesthetic summary
    const aestheticStr = series.aesthetic
      ? `Style: ${series.aesthetic.style}\nPalette: ${series.aesthetic.palette}\nLighting: ${series.aesthetic.lighting}\nLens: ${series.aesthetic.lensCharacteristics}\nFilm: ${series.aesthetic.filmStock}`
      : 'No aesthetic locked yet.';

    // Build location summary (existing first-class Location entities). The LLM
    // is asked to reuse these slugs and only introduce new ones when needed.
    const locationSummaries = (series.locations ?? []).length > 0
      ? (series.locations ?? []).map(l => `${l.slug}: ${l.name} — ${l.description}${l.lightingNotes ? ` (lighting: ${l.lightingNotes})` : ''}${l.spatialAnchors ? ` (fixed layout: ${l.spatialAnchors})` : ''}`).join('\n')
      : 'None defined yet.';

    const systemPrompt = `You are a screenwriter for the ${language.projectNounLower} "${series.name}".

PROJECT CONCEPT: ${series.concept}
GENRE: ${series.genre}
SETTING: ${series.setting}

AESTHETIC:
${aestheticStr}

CHARACTERS:
${charSummaries}

LOCATIONS (existing, reuse these slugs):
${locationSummaries}

PRIOR ${language.segmentNoun.toUpperCase()} MATERIAL:
${priorEpisodes || 'None yet.'}

PROJECT REFERENCE DOCUMENTS:
${referenceContext || 'None available.'}

DIRECT THE SCENE, DON'T DECORATE IT (CRITICAL):
For every shot, first decide what the beat is DOING — the turn, the point of view, the power, the subtext — and name ONE intention. Then derive camera, lens, light, blocking, performance, and sound from that single intention. Do NOT stack empty "cinematic / epic / beautiful / dramatic / masterpiece / 4k" adjectives — they give the model nothing to serve. A reveal is not framed, lit, blocked, or performed like a goodbye; write the specific answer, not the generic one. Hold ONE directorial voice across every shot of the ${language.containerNounLower}.
- Decorated (reject): "epic cinematic close-up of a woman reading a letter, emotional, beautiful lighting".
- Directed (write like this): "Medium close-up, eye-level; she lowers the letter and her hands go still as a slow push-in arrives; soft window light keeps her face plain; near-silence with one chair scrape — the realization lands in the stilled hands, not a word."
Direct INTENTION / CAMERA / LIGHT / BLOCKING / PERFORMANCE / SOUND only. Do NOT write exhaustive physical character descriptions or reference-image tags into "description" — identity is locked downstream by R2V character references. Name the character and direct what they DO.
When a take is close but wrong, the fix is one variable at a time (camera OR light OR motion OR framing), not a fresh pile of adjectives. When continuing a story, direct the next beat from what actually ended on screen, not from the original plan.

${language.namingGuidance}

Your task is to write a complete ${language.scriptNounLower} as a JSON object. Follow the exact format below. The script must:
- ${language.targetDurationGuidance}
- ${language.openingGuidance}
- ${language.endingGuidance}
- ${language.structureGuidance}
- ${language.closingShotGuidance}
- Give each shot ONE intention and derive its craft from it (see DIRECT THE SCENE above)
- Include specific delivery cues for all dialogue (see VOICE DIRECTION below)
- Use the correct videoModel ("action" for movement/dialogue, "atmosphere" for establishing/static)

SHOT DURATION — PREFER FEWER, LONGER SHOTS (CRITICAL):
The video models (Seedance 2.0, HappyHorse 1.1, Wan 2.7) all support up to 15 seconds in a single generation, and 15s is the strong default. Wan 3.0 goes to 30s. For a 60-second sequence, prefer 4 shots at ~15s each over 10 shots at ~6s. Reasons:
1. Identity stays locked longer — every new shot is a fresh generation where character likeness can drift.
2. Motion has room to breathe — short shots cut before gestures/expressions complete, which is one of the main "AI video looks twitchy" tells.
3. Cost is lower — fewer generations for the sequence.
4. Fewer transitions to police for continuity.
Only use shorts (3-8s) for *deliberate* short beats: hard cuts, sight gags, single-frame reactions, the closing title card. Default everything else to 12-15s.
- duration must be one of: "3s","4s","5s","6s","7s","8s","9s","10s","11s","12s","13s","14s","15s" (HappyHorse goes down to 3s; Seedance from 4s).
- Aim for this script part to contain roughly (target_seconds / 13) shots ± 1.

VOICE DIRECTION — NATIVE MODEL DIALOGUE IS PREFERRED:
The recommended native pipeline uses Seedance or HappyHorse with character voice-donor references for in-character speech. Rendering Venice speech first and passing it to the model as an audio file is reserved for the explicit Exact lip-sync strategy. Therefore every dialogue shot's "delivery" cue must be RICH — direct the voice like you're talking to a voice actor: timbre, accent, pacing, emotional register, breath placement, signature delivery quirks. Two-word "delivery": "angry" cues produce flat results; "delivery": "deliberate, half-volume drawl with a beat before the punchline; warm not bitter; breath audible before 'audacity'" produces in-character results.

NO MUSIC / NO SFX FROM THE VIDEO MODEL:
Every shot "description" MUST end with the literal phrase: "No background music, no sound effects, no soundtrack, dry recording." The harness adds music and ambient/SFX in post via separate Venice audio calls; baked-in music or SFX from the video model fights the assembler's mix. The "sfx" field in the schema below describes what the harness should generate in post — it does NOT instruct the video model to produce sound effects.

LOCATIONS — TAG EVERY SHOT WITH A LOCATION:
Define the physical place(s) this ${language.containerNounLower} uses as first-class locations, and tag every shot with the location it plays in. Locations anchor the environment across shots (consistent architecture, set dressing, and lighting) the same way character references anchor identity.
- Emit a top-level "locations" array. Each entry: {"name": "<Display Name>", "slug": "<kebab-case-slug>", "description": "<locked prose description of the environment — architecture, materials, set dressing, scale>", "lightingNotes": "<the established lighting for this place>", "spatialAnchors": "<the locked geography: 3-5 named landmarks and their FIXED positions relative to each other, e.g. 'bar counter along the back wall; entrance door opposite it; window with neon sign left of the door as seen from the counter'>"}.
- REUSE the existing location slugs listed above when the scene is in a place already defined; only introduce a new location entry when the place is genuinely new.
- Give every shot a "location" field set to the slug of the location it plays in.
- ${language.locationGuidance}

SPATIAL BLOCKING — EVERY MULTI-SUBJECT SHOT GETS A "blocking" FIELD (CRITICAL):
Video models drift spatially between separately generated shots: characters swap sides, distances change, and props teleport unless every prompt states the geometry explicitly. For every shot with 1+ characters (and for object-driven inserts), write a "blocking" field: 1-2 sentences of CONCRETE geometry stating, for each character/key object:
- WHERE they are relative to the location's named spatialAnchors ("at the bar counter", "in the doorway"),
- WHERE they are in the frame (screen left / center / screen right; foreground / midground / background),
- WHICH WAY they face and where their eyeline goes ("facing right toward the door", "looking down at the letter").
Example: "MARA at the bar counter, screen left, facing right; JAX in the doorway, background screen right, facing her. The neon window is behind MARA's shoulder."
Continuity rules for blocking across consecutive shots in the same scene:
- Characters KEEP their screen side and relative positions from the previous shot unless someone visibly moves — and if they move, the movement is the shot's action, written into the description.
- Preserve screen direction and eyelines (180-degree rule): if A looks right at B in one shot, A keeps looking right and B keeps looking left in the coverage that follows.
- Reference the SAME named anchors from the location's spatialAnchors so "by the window" means the same window in every shot.
- Establishing shots re-state the full geography; close-ups still name what's behind/beside the subject so backgrounds match the master.

IMPORTANT: Every shot MUST include an "environment" field. This tells the pipeline when to adapt the project's aesthetic for bright daytime scenes. Values:
- "DAY_INTERIOR" -- bright indoor scene (café, office, apartment in daylight)
- "DAY_EXTERIOR" -- bright outdoor scene (street, park in daylight)
- "NIGHT_INTERIOR" -- indoor scene at night (club, bar, dimly lit room)
- "NIGHT_EXTERIOR" -- outdoor nighttime scene (street at night, rooftop at night)

Respond with ONLY valid JSON matching this exact schema (no markdown, no code fences, no explanation):
{
  "episode": <internal part number; keep this field name for compatibility>,
  "title": "<title>",
  "seriesName": "${series.name}",
  "totalDuration": "<estimated total>",
  "status": "draft",
  "locations": [
    {"name": "<Display Name>", "slug": "<kebab-case-slug>", "description": "<locked environment description>", "lightingNotes": "<established lighting>", "spatialAnchors": "<locked geography: named landmarks and their fixed relative positions>"}
  ],
  "shots": [
    {
      "shotNumber": 1,
      "type": "establishing|dialogue|action|reaction|close-up|insert",
      "environment": "DAY_INTERIOR|DAY_EXTERIOR|NIGHT_INTERIOR|NIGHT_EXTERIOR",
      "location": "<slug of a location defined in the top-level locations array>",
      "duration": "3s|4s|...|15s (PREFER 15s; use shorts only for deliberate quick beats)",
      "videoModel": "action|atmosphere",
      "description": "<full visual description, ending with 'No background music, no sound effects, no soundtrack, dry recording.'>",
      "blocking": "<concrete geometry: each character/object's position relative to named location anchors, frame side, depth, and facing/eyeline — consistent with adjacent shots in the scene>",
      "panelDescription": "<optional single-frame description if description has sequential action>",
      "characters": ["<CHARACTER_NAME>"],
      "dialogue": {"character": "<NAME>", "line": "<text>", "delivery": "<rich voice-director cue: timbre, accent, pacing, emotion, breath, signature quirks>"} or null,
      "sfx": "<sound effects to GENERATE IN POST via Venice SFX>" or null,
      "cameraMovement": "<camera direction>",
      "transition": "CUT|FADE|DISSOLVE|MATCH CUT|SMASH CUT"
    }
  ]
}`;

    const userPrompt = `Write ${language.segmentNoun} ${opts.episode} of the ${language.projectNounLower} with this concept: ${opts.concept}`;

    console.log(`Workshop: Generating ${language.scriptNounLower} draft (${language.segmentNoun} ${opts.episode})...`);
    console.log(`  Concept: ${opts.concept}`);
    const intelligence = intelligenceFor(series, opts.model);
    console.log(`  Model: ${describeIntelligence(intelligence.model)}`);
    console.log(`  Reference docs: ${mdFiles.length} (${mdFiles.join(', ') || 'none'})`);
    console.log(`  Prior ${language.segmentNounLower} parts: ${series.episodes.length}\n`);

    try {
      let script: EpisodeScript;
      try {
        script = await client.chatJson<EpisodeScript>({
          model: intelligence.model,
          systemPrompt,
          userPrompt,
          maxTokens: 8000,
          temperature: 0.7,
          label: `${language.scriptNounLower} draft`,
        });
      } catch (parseErr) {
        const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
        console.error(`Could not get a usable ${language.scriptNounLower} out of ${intelligence.model}.`);
        console.error(message);
        const dumpPath = join(getEpisodeDir(series, opts.episode), 'workshop-raw-response.txt');
        await mkdir(getEpisodeDir(series, opts.episode), { recursive: true });
        await writeFile(dumpPath, message, 'utf-8');
        console.error(`\nDetail saved to: ${dumpPath}`);
        process.exit(1);
      }

      script.episode = opts.episode;
      script.seriesName = series.name;
      script.status = 'draft';

      if (!script.shots || script.shots.length === 0) {
        console.error('LLM returned a script with no shots. Try again or adjust the concept.');
        process.exit(1);
      }

      // Ensure this internal script part exists in series.json
      if (!series.episodes.find(ep => ep.number === opts.episode)) {
        addEpisode(series, script.title || `${language.segmentNoun} ${opts.episode}`);
      }

      // Merge any locations the LLM introduced into the series, then generate
      // reference images for locations that don't have them yet. Locations
      // tagged on shots but missing from the script's locations[] are also
      // synthesized as stubs so every referenced slug resolves.
      await mergeAndGenerateEpisodeLocations(client, series, script);

      // Plan storyboard blocking plates per scene beat (multi-character runs
      // in the same location) and generate them now so the operator can QA
      // the blocking alongside the script draft. Assignments land on
      // shot.storyboardRef; plates go to storyboards/<slug>.png.
      try {
        const { generated, skipped } = await ensureEpisodeStoryboardReferences(client, series, script);
        if (generated.length > 0 || skipped.length > 0) {
          console.log(`  Storyboard blocking plates: ${generated.length} generated, ${skipped.length} reused.`);
        }
      } catch (err) {
        console.warn(`  ⚠ Storyboard plate pass failed: ${(err as Error).message}`);
      }

      const savedPath = await saveEpisodeScript(series, script);
      await saveSeries(series);

      const totalDurationSec = script.shots.reduce((sum, s) => {
        const match = s.duration?.match(/(\d+)/);
        return sum + (match ? parseInt(match[1], 10) : 5);
      }, 0);

      console.log(`Draft saved: ${savedPath}`);
      console.log(`  Title: "${script.title}"`);
      console.log(`  Shots: ${script.shots.length}`);
      console.log(`  Duration: ~${totalDurationSec}s`);
      console.log(`  Status: draft`);

      // Post-condition advisory: the new system prompt asks for 15s-leaning
      // shots, but LLMs sometimes ignore that and produce many shorts. We
      // surface it so the user (and the MCP) sees the warning instead of
      // silently shipping a draft with 10x 6s beats.
      const shotsUnder8s = script.shots.filter((s) => {
        const m = s.duration?.match(/(\d+)\s*s/);
        return m ? parseInt(m[1], 10) < 8 : false;
      });
      if (script.shots.length > Math.max(6, Math.ceil(totalDurationSec / 13)) && shotsUnder8s.length >= 3) {
        console.warn(
          `  ⚠ The draft has ${script.shots.length} shots for ~${totalDurationSec}s ` +
            `(${shotsUnder8s.length} are under 8s). Recommended target: ~${Math.max(2, Math.round(totalDurationSec / 13))} shots ` +
            `with most at 12-15s. Edit script.json before approving or re-run workshop with stronger guidance in the concept.`,
        );
      }
      const shotsWithoutAudioNegative = script.shots.filter(
        (s) => !s.description || !/no\s+(music|background music|soundtrack|sound effects|sfx)/i.test(s.description),
      );
      if (shotsWithoutAudioNegative.length > 0) {
        console.warn(
          `  ⚠ ${shotsWithoutAudioNegative.length} shot(s) are missing the no-music/no-SFX negative in their description. ` +
            `The video model may bake music or sound effects into the dialogue track. ` +
            `The harness will still suppress these via its NEGATIVE_PROMPT, but the script LLM should also include them per the workshop instructions.`,
        );
      }

      // Spatial-consistency advisory (rule 49): character shots without an
      // authored "blocking" field re-infer placement per generation, which is
      // where side-swaps and teleporting props come from.
      const shotsMissingBlocking = script.shots.filter(
        (s) => s.characters.length > 0 && !s.blocking,
      );
      if (shotsMissingBlocking.length > 0) {
        console.warn(
          `  ⚠ ${shotsMissingBlocking.length} character shot(s) have no "blocking" field ` +
            `(shots ${shotsMissingBlocking.map(s => s.shotNumber).join(', ')}). ` +
            `Without explicit geometry (who is where, relative to which location anchor, facing which way), ` +
            `placement is re-inferred per generation and spatial continuity drifts between shots. ` +
            `Add blocking to script.json before approving, or re-run workshop.`,
        );
      }
      const locationsMissingAnchors = (script.locations ?? []).filter(l => !l.spatialAnchors);
      if (locationsMissingAnchors.length > 0) {
        console.warn(
          `  ⚠ ${locationsMissingAnchors.length} location(s) have no "spatialAnchors" ` +
            `(${locationsMissingAnchors.map(l => l.slug).join(', ')}). ` +
            `Locked landmark geography is what lets shot blocking say "by the window" and mean the same window every time.`,
        );
      }

      const dialogueShots = script.shots.filter(s => s.dialogue);
      if (dialogueShots.length > 0) {
        console.log(`\nDialogue preview:`);
        for (const s of dialogueShots) {
          console.log(`  Shot ${s.shotNumber}: ${s.dialogue!.character}: "${s.dialogue!.line}"`);
        }
      }

      console.log(`\nReview the script, iterate as needed, then approve:`);
      console.log(`  approve-script -p ${series.outputDir} -e ${opts.episode}`);
    } catch (err) {
      console.error(`Workshop failed: ${err}`);
      process.exit(1);
    }
  });

// ── storyboard-episode ────────────────────────────────────────────────
program
  .command('storyboard-episode')
  .description('Generate storyboard panel images from an episode script')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--no-refine', 'Skip the multi-edit refinement pass (refinement is ON by default)')
  .option('--edit-model <model>', 'Model for multi-edit refinement (default: nano-banana-2-edit)', DEFAULT_IMAGE_EDIT_MODEL)
  .option('--cfg-scale <number>', 'Prompt adherence (1-10, higher = stricter)', parseFloat)
  .option('--debug', 'Save prompt payloads as shot-NNN.prompt.json for debugging', false)
  .option('--skip-approval', 'Skip script approval check', false)
  .option('--force', 'Regenerate all panels, ignoring any that already exist', false)
  .action(async (opts: { project: string; episode: number; refine: boolean; editModel: string; cfgScale?: number; debug: boolean; skipApproval: boolean; force: boolean }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    if (!series.aesthetic) { console.error('Set aesthetic first.'); process.exit(1); }

    const episodeDir = getEpisodeDir(series, opts.episode);
    const scriptApprovedPath = join(episodeDir, 'script-approved.json');
    if (!opts.skipApproval && script.status !== 'approved' && !existsSync(scriptApprovedPath)) {
      console.error('Blocked: the script has not been approved, and approval is a human decision.');
      console.error(`  Clear it with:  approve-script -p ${series.outputDir} -e ${opts.episode}`);
      console.error('  --skip-approval only bypasses this check; it does not approve the script and is not the fix.');
      process.exit(1);
    }

    const cfgScale = opts.cfgScale ?? 10;
    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const sceneDir = join(episodeDir, 'scene-001');
    await mkdir(sceneDir, { recursive: true });

    console.log(`Generating storyboard for Episode ${opts.episode}: ${script.title}`);
    console.log(`${script.shots.length} shots to generate`);
    console.log(`  cfg_scale: ${cfgScale} | seed: ${series.aestheticSeed ?? 'random'} | refine: ${opts.refine}\n`);

    // ── Pass 1: Generate base panels ──────────────────────────────────
    console.log('Pass 1: Generating base panels...\n');

    const newlyGenerated = new Set<number>();
    const totalShots = script.shots.length;
    let generatedCount = 0;
    let skippedCount = 0;
    const pass1Start = Date.now();
    const shotTimes: number[] = [];

    for (let shotIdx = 0; shotIdx < totalShots; shotIdx++) {
      const shot = script.shots[shotIdx];
      const shotNum = String(shot.shotNumber).padStart(3, '0');
      const imgPath = join(sceneDir, `shot-${shotNum}.png`);
      const progress = `[${shotIdx + 1}/${totalShots}]`;

      if (existsSync(imgPath) && !opts.force) {
        skippedCount++;
        console.log(`  ${progress} Shot ${shotNum}: already exists, skipping`);
        continue;
      }

      // Archive existing panel before overwriting (--force mode)
      if (existsSync(imgPath) && opts.force) {
        const archivePath = imgPath.replace(/\.png$/, `-force-archive-${Date.now()}.png`);
        const { rename: renameFile } = await import('node:fs/promises');
        await renameFile(imgPath, archivePath);
      }

      const imagePrompt = buildImagePrompt(shot, series);

      // Fold in the shot's location: inject its locked description + lighting
      // into the panel prompt (anti-pattern 7) and use its reference image as
      // an environment anchor alongside character faces.
      const locInfo = resolveLocationRefForShot(series, shot);
      const effectivePrompt = imagePrompt.prompt + locInfo.note;

      if (opts.debug) {
        const debugPath = join(sceneDir, `shot-${shotNum}.prompt.json`);
        await writeFile(debugPath, JSON.stringify({
          shotNumber: shot.shotNumber,
          type: shot.type,
          characters: shot.characters,
          location: shot.location ?? null,
          locationRef: locInfo.refPath ?? null,
          prompt: effectivePrompt,
          negativePrompt: imagePrompt.negativePrompt,
          seed: imagePrompt.seed,
          cfgScale,
          generatedAt: new Date().toISOString(),
        }, null, 2), 'utf-8');
      }

      const shotStart = Date.now();

      try {
        const storyboardAR = series.storyboardAspectRatio ?? '16:9';
        let imgBuffer: Buffer;

        // For character shots, use generateWithReferences for identity anchoring.
        // Panels used to force seedream-v5-lite whenever a character was present,
        // because Seedance 2.0 rejected face-bearing images from other families.
        // Venice removed that restriction (2026-07), so ALL panels — character
        // and faceless alike — use the operator's imageDefaults.generationModel
        // (default nano-banana-2), the higher-quality general default.
        const hasChars = shot.characters && shot.characters.length > 0;
        const panelModel = series.videoDefaults.imageDefaults?.generationModel
          ?? DEFAULT_IMAGE_GENERATION_MODEL;

        const charRefPaths: string[] = [];
        if (hasChars) {
          const charRefs = shot.characters
            .map(name => {
              const char = series.characters.find(c => c.name.toUpperCase() === name.toUpperCase());
              if (!char) return null;
              const charDir = getCharacterDir(series, char.name);
              const frontPath = join(charDir, 'front.png');
              if (!existsSync(frontPath)) return null;
              charRefPaths.push(frontPath);
              return {
                name: char.name,
                role: char.description.slice(0, 80),
                base64Image: readFileSync(frontPath).toString('base64'),
              };
            })
            .filter(Boolean) as import('../venice/types.js').CharacterReference[];

          // Location environment reference: appended AFTER the face refs so it
          // never consumes a face slot (faceSlots stays = character count).
          // generateWithReferences concatenates all refs; the extra one is used
          // as a general environment/style anchor.
          const charRefsWithLocation = [...charRefs];
          let locationPromptSuffix = '';
          if (locInfo.refPath) {
            charRefsWithLocation.push({
              name: 'LOCATION',
              role: 'environment reference — setting, architecture, lighting',
              base64Image: readFileSync(locInfo.refPath).toString('base64'),
            } as import('../venice/types.js').CharacterReference);
            charRefPaths.push(locInfo.refPath);
            locationPromptSuffix = ` The final reference image is the location environment — match its setting, architecture, and lighting; it is not a character.`;
          }

          if (charRefs.length > 0) {
            const result = await generateWithReferences(client, {
              model: panelModel,
              prompt: effectivePrompt + locationPromptSuffix,
              negative_prompt: imagePrompt.negativePrompt,
              resolution: '1K',
              aspect_ratio: storyboardAR,
              steps: 30,
              cfg_scale: cfgScale,
              seed: imagePrompt.seed,
              safe_mode: false,
              hide_watermark: true,
              referenceImages: charRefsWithLocation,
              faceSlots: Math.min(charRefs.length, 2),
            });
            imgBuffer = Buffer.from(result.base64, 'base64');
          } else {
            const response = await generateImage(client, {
              model: panelModel,
              prompt: effectivePrompt,
              negative_prompt: imagePrompt.negativePrompt,
              resolution: '1K',
              aspect_ratio: storyboardAR,
              steps: 30,
              cfg_scale: cfgScale,
              seed: imagePrompt.seed,
              safe_mode: false,
              hide_watermark: true,
            });
            imgBuffer = Buffer.from(response.images[0].b64_json, 'base64');
          }
        } else if (locInfo.refPath) {
          // No characters, but a location ref exists — anchor the establishing
          // panel to the location environment via generateWithReferences
          // (faceSlots 0 → the ref is a pure environment/style anchor).
          charRefPaths.push(locInfo.refPath);
          const result = await generateWithReferences(client, {
            model: panelModel,
            prompt: effectivePrompt + ` This reference image is the location environment — match its setting, architecture, and lighting.`,
            negative_prompt: imagePrompt.negativePrompt,
            resolution: '1K',
            aspect_ratio: storyboardAR,
            steps: 30,
            cfg_scale: cfgScale,
            seed: imagePrompt.seed,
            safe_mode: false,
            hide_watermark: true,
            referenceImages: [{
              name: 'LOCATION',
              role: 'environment reference',
              base64Image: readFileSync(locInfo.refPath).toString('base64'),
            } as import('../venice/types.js').CharacterReference],
            faceSlots: 0,
          });
          imgBuffer = Buffer.from(result.base64, 'base64');
        } else {
          const response = await generateImage(client, {
            model: panelModel,
            prompt: effectivePrompt,
            negative_prompt: imagePrompt.negativePrompt,
            resolution: '1K',
            aspect_ratio: storyboardAR,
            steps: 30,
            cfg_scale: cfgScale,
            seed: imagePrompt.seed,
            safe_mode: false,
            hide_watermark: true,
          });
          imgBuffer = Buffer.from(response.images[0].b64_json, 'base64');
        }

        if (imgBuffer) {
          await writeFile(imgPath, imgBuffer);

          // Venice can return WebP internally disguised as PNG -- convert immediately.
          try {
            const isWebp =
              imgBuffer.length >= 12 &&
              imgBuffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
              imgBuffer.subarray(8, 12).toString('ascii') === 'WEBP';
            if (isWebp) {
              const tmpPath = imgPath.replace(/\.png$/, '-webp-conv.png');
              runCommand('ffmpeg', ['-i', imgPath, '-y', tmpPath]);
              const { renameSync } = await import('node:fs');
              renameSync(tmpPath, imgPath);
            }
          } catch { /* conversion is best-effort */ }

          // Record provenance + recipe — `panelModel` was chosen above based
          // on whether this shot has characters. `hasFace` is true when the
          // shot has named (non-silhouette) characters; Seedance only
          // gates face-bearing images. The recipe entry makes this pass
          // replayable by a finishing agent (model/prompt/seed/cfg/refs).
          await appendRecipePass(imgPath, {
            kind: 'generate',
            role: 'content',
            model: panelModel,
            label: 'base panel',
            prompt: effectivePrompt,
            negativePrompt: imagePrompt.negativePrompt,
            seed: imagePrompt.seed,
            cfgScale,
            aspectRatio: storyboardAR,
            resolution: '1K',
            referenceImagePaths: charRefPaths.length > 0 ? charRefPaths : undefined,
          }, { provenance: 'generate', hasFace: hasChars });

          newlyGenerated.add(shot.shotNumber);
          generatedCount++;
          const elapsed = ((Date.now() - shotStart) / 1000).toFixed(1);
          shotTimes.push(Date.now() - shotStart);
          const avgTime = shotTimes.reduce((a, b) => a + b, 0) / shotTimes.length;
          const remaining = totalShots - shotIdx - 1 - skippedCount;
          const eta = remaining > 0 ? ` | ETA ~${Math.ceil((avgTime * remaining) / 60000)}min` : '';
          console.log(`  ${progress} Shot ${shotNum}: saved (${elapsed}s${eta})`);
        }
      } catch (err) {
        console.warn(`  ${progress} Shot ${shotNum}: FAILED - ${err}`);
      }
    }

    const pass1Elapsed = ((Date.now() - pass1Start) / 1000).toFixed(0);
    console.log(`\nPass 1 complete: ${generatedCount} generated, ${skippedCount} skipped (${pass1Elapsed}s total)`);


    // ── Pass 2: Refine with multi-edit ────────────────────────────────
    if (opts.refine) {
      const editModel = opts.editModel as MultiEditModel;
      console.log(`\nPass 2: Refining with multi-edit (${editModel})...`);

      // Save a snapshot of the first character shot BEFORE refinement to use as style anchor.
      // Post-refinement panels can inherit layout artifacts from character reference sheets,
      // which would contaminate non-character shots during style-matching.
      const firstCharShot = script.shots.find(s => s.characters.length > 0);
      let styleAnchorPath: string | undefined;
      if (firstCharShot) {
        const firstCharShotPath = join(sceneDir, `shot-${String(firstCharShot.shotNumber).padStart(3, '0')}.png`);
        if (existsSync(firstCharShotPath)) {
          styleAnchorPath = join(sceneDir, '.style-anchor.png');
          await copyFile(firstCharShotPath, styleAnchorPath);
        }
      }

      const charShots = script.shots.filter(s => s.characters.length > 0);
      const nonCharShots = script.shots.filter(s => s.characters.length === 0);
      const refinableShots = [...charShots, ...nonCharShots];
      const totalRefinable = refinableShots.length;
      let refineIdx = 0;
      const pass2Start = Date.now();

      for (const shot of charShots) {
        refineIdx++;
        const shotNum = String(shot.shotNumber).padStart(3, '0');
        const imgPath = join(sceneDir, `shot-${shotNum}.png`);
        const progress = `[${refineIdx}/${totalRefinable}]`;
        if (!existsSync(imgPath)) continue;

        if (shot.skipRefine) {
          console.log(`  ${progress} Shot ${shotNum}: refinement disabled (skipRefine), skipping`);
          continue;
        }

        const preFixPath = join(sceneDir, `shot-${shotNum}-pre-fix.png`);
        if (existsSync(preFixPath) && !newlyGenerated.has(shot.shotNumber)) {
          console.log(`  ${progress} Shot ${shotNum}: already refined, skipping`);
          continue;
        }

        const refStart = Date.now();
        try {
          const locRef = resolveLocationRefForShot(series, shot).refPath;
          await refineWithReferences(client, series, imgPath, shot, editModel, locRef);
          const elapsed = ((Date.now() - refStart) / 1000).toFixed(1);
          console.log(`  ${progress} Shot ${shotNum}: character-refined (${elapsed}s)`);
        } catch (err) {
          console.warn(`  ${progress} Shot ${shotNum}: refinement FAILED - ${err}`);
        }
      }

      for (const shot of nonCharShots) {
        refineIdx++;
        const shotNum = String(shot.shotNumber).padStart(3, '0');
        const imgPath = join(sceneDir, `shot-${shotNum}.png`);
        const progress = `[${refineIdx}/${totalRefinable}]`;
        if (!existsSync(imgPath)) continue;

        if (shot.skipRefine) {
          console.log(`  ${progress} Shot ${shotNum}: refinement disabled (skipRefine), skipping`);
          continue;
        }

        const preStylePath = join(sceneDir, `shot-${shotNum}-pre-style.png`);
        if (existsSync(preStylePath) && !newlyGenerated.has(shot.shotNumber)) {
          console.log(`  ${progress} Shot ${shotNum}: already style-matched, skipping`);
          continue;
        }

        // Prefer the shot's location reference as the environment/style anchor
        // (keeps every shot in a place looking like that place); fall back to
        // the episode's character-shot style anchor when there's no location.
        const locRef = resolveLocationRefForShot(series, shot).refPath;
        const anchorForShot = locRef ?? styleAnchorPath;
        if (anchorForShot && existsSync(anchorForShot)) {
          const refStart = Date.now();
          try {
            const aestheticStr = [
              series.aesthetic!.style,
              series.aesthetic!.palette,
              series.aesthetic!.lighting,
            ].join(', ');
            await refineStyleConsistency(client, imgPath, anchorForShot, aestheticStr, editModel, shot.environment);
            const elapsed = ((Date.now() - refStart) / 1000).toFixed(1);
            console.log(`  ${progress} Shot ${shotNum}: style-refined (${elapsed}s${locRef ? ', location anchor' : ''})`);
          } catch (err) {
            console.warn(`  ${progress} Shot ${shotNum}: refinement FAILED - ${err}`);
          }
        }
      }

      const pass2Elapsed = ((Date.now() - pass2Start) / 1000).toFixed(0);
      console.log(`\nPass 2 complete (${pass2Elapsed}s total)`);

      // NOTE: the style anchor (.style-anchor.png) is intentionally KEPT on
      // disk. Recipe sidecars reference it as the style-match input, and any
      // finishing pass that needs to match the episode look (new shots,
      // regens, polish edits) should anchor against the same file.
    }

    // ── Pass 3: Scene-ref injection for shots with sceneImagePaths ────────
    // buildImagePrompt() is text-only and cannot embed reference images.
    // For shots that have sceneImagePaths (e.g. Venice logo on the monolith),
    // we run a dedicated multi-edit pass that injects the logo/scene image
    // as a reference so the model visually integrates it into the panel.
    const scenePropShots = script.shots.filter(
      s => s.sceneImagePaths && s.sceneImagePaths.length > 0,
    );

    if (scenePropShots.length > 0) {
      const sceneEditModel = opts.editModel as MultiEditModel;
      console.log(`\nPass 3: Injecting scene references into ${scenePropShots.length} shots...`);
      const pass3Start = Date.now();

      for (let idx = 0; idx < scenePropShots.length; idx++) {
        const shot = scenePropShots[idx];
        const shotNum = String(shot.shotNumber).padStart(3, '0');
        const imgPath = join(sceneDir, `shot-${shotNum}.png`);
        const progress = `[${idx + 1}/${scenePropShots.length}]`;
        if (!existsSync(imgPath)) {
          console.log(`  ${progress} Shot ${shotNum}: panel missing, skipping`);
          continue;
        }

        // Load all scene ref images that actually exist on disk
        const sceneRefUris: string[] = [];
        const sceneRefPaths: string[] = [];
        for (const refPath of shot.sceneImagePaths!.slice(0, 2)) {
          if (existsSync(refPath)) {
            sceneRefUris.push(await loadImageAsDataUri(refPath));
            sceneRefPaths.push(refPath);
          } else {
            console.warn(`  ${progress} Shot ${shotNum}: scene ref not found: ${refPath}`);
          }
        }
        if (sceneRefUris.length === 0) {
          console.log(`  ${progress} Shot ${shotNum}: no valid scene refs, skipping`);
          continue;
        }

        const panelDataUri = await loadImageAsDataUri(imgPath);
        const defaultSceneRefPrompt =
          `Integrate the visual elements from the reference image(s) into this scene. ` +
          `Preserve the scene composition, characters, lighting, and cinematic framing exactly. ` +
          `Do not change the overall image. Do not add text, speech bubbles, or panel borders.`;
        const sceneRefPrompt = shot.sceneRefDescription
          ? `${shot.sceneRefDescription} Preserve the scene composition, characters, lighting, and cinematic framing exactly. Do not add text, speech bubbles, or panel borders.`
          : defaultSceneRefPrompt;

        const refStart = Date.now();
        try {
          const resultBuffer = await multiEditImage(client, {
            model: sceneEditModel,
            prompt: sceneRefPrompt,
            baseImage: panelDataUri,
            referenceImages: sceneRefUris,
          });
          // Archive original before overwriting
          const archivePath = imgPath.replace(/\.png$/, '-pre-scene-ref.png');
          if (existsSync(imgPath)) {
            const { rename } = await import('node:fs/promises');
            await rename(imgPath, archivePath);
          }
          await writeFile(imgPath, resultBuffer);
          await appendRecipePass(imgPath, {
            kind: 'multi-edit',
            role: 'content',
            model: sceneEditModel,
            label: 'scene-ref injection',
            prompt: sceneRefPrompt,
            referenceImagePaths: sceneRefPaths,
            archivedPrevious: archivePath,
          }, { provenance: 'edit', hasFace: shot.characters.length > 0 });
          const elapsed = ((Date.now() - refStart) / 1000).toFixed(1);
          console.log(`  ${progress} Shot ${shotNum}: scene-ref injected (${elapsed}s)`);
        } catch (err) {
          console.warn(`  ${progress} Shot ${shotNum}: scene-ref injection FAILED - ${err}`);
        }
      }

      const pass3Elapsed = ((Date.now() - pass3Start) / 1000).toFixed(0);
      console.log(`\nPass 3 complete (${pass3Elapsed}s total)`);
    }

    const ep = series.episodes.find(e => e.number === opts.episode);
    if (ep) ep.status = 'storyboarded';
    await saveSeries(series);

    console.log(`\nStoryboard complete. ${script.shots.length} panels in: ${sceneDir}`);
    console.log(`\nQA review comes next. A vision model compares every panel against the character`);
    console.log(`references and flags identity, wardrobe, setting and framing drift.`);
    console.log(`\nNext: qa-storyboard -p ${series.outputDir} -e ${opts.episode}`);
    console.log(`Then: qa-approve -p ${series.outputDir} -e ${opts.episode}`);
    await updateTreatment(series, opts.episode);
  });

// ── fix-panel ─────────────────────────────────────────────────────────
program
  .command('fix-panel')
  .description('Fix character appearance in a panel using multi-edit with character references')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .requiredOption('-s, --shot <number>', 'Shot number to fix', parseInt)
  .option('-c, --characters <names>', 'Character names to fix (comma-separated)')
  .option('--edit-model <model>', 'Multi-edit model (default: nano-banana-2-edit)', DEFAULT_IMAGE_EDIT_MODEL)
  .option('--prompt <prompt>', 'Custom edit prompt (overrides auto-generated)')
  .action(async (opts: {
    project: string; episode: number; shot: number;
    characters?: string; editModel: string; prompt?: string;
  }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    const shot = script.shots.find(s => s.shotNumber === opts.shot);
    if (!shot) { console.error(`Shot ${opts.shot} not found in script.`); process.exit(1); }

    const episodeDir = getEpisodeDir(series, opts.episode);
    const shotNum = String(opts.shot).padStart(3, '0');
    const panelPath = join(episodeDir, 'scene-001', `shot-${shotNum}.png`);

    if (!existsSync(panelPath)) {
      console.error(`Panel not found: ${panelPath}`);
      process.exit(1);
    }

    const charNames = opts.characters
      ? opts.characters.split(',').map(s => s.trim())
      : shot.characters;

    if (charNames.length === 0) {
      console.error('No characters specified and shot has no characters.');
      process.exit(1);
    }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);

    console.log(`Fixing shot ${shotNum} with character references: ${charNames.join(', ')}`);

    await fixPanel(
      client,
      series,
      panelPath,
      charNames,
      opts.editModel as MultiEditModel,
      opts.prompt,
      shot.episodeWardrobe,
      shot.environment,
    );

    console.log(`\nPanel fixed. Review: ${panelPath}`);
    console.log(`Original archived as: shot-${shotNum}-pre-fix.png`);
    await updateTreatment(series, opts.episode);
  });

// ── insert-shot ─────────────────────────────────────────────
// Splices a new shot into an existing script with a suffix-letter id
// (3 -> 3b -> 3c) so the order of the original numeric shotNumbers is
// preserved. Writes the new script and prints the next steps for the
// user to run.
//
// Doing this in one go would require re-rendering panels + videos +
// re-deriving the assembly's filter graph + re-emitting the FCPXML.
// Each of those is a separate existing command. Following the harness'
// "natural-language interface; commands compose" pattern, this command
// only does the script-editing work and tells the user what to run next.
program
  .command('insert-shot')
  .description('Insert a new shot into an episode script with a suffix-letter id')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .requiredOption('--after <shotId>', 'Shot id (number or suffixed string) to insert after')
  .requiredOption('--description <text>', 'Description for the new shot (drives panel + video prompt)')
  .option('--type <type>', 'Shot type', 'action')
  .option(
    '--duration <duration>',
    'Shot duration (e.g. 15s). DEFAULT is 15s — the native max on Seedance 2.0 (4-15s) and HappyHorse 1.1 (3-15s). Prefer 15s and stitch fewer long clips (2x15s for a 30s beat) over many short clips: identity stays locked longer, transitions are fewer, cost is lower, and motion has room to breathe. Only drop below 15s for genuine quick beats (sight gag, hard cut, deliberate stinger).',
    '15s',
  )
  .option('--motion <motion>', 'Motion intensity: low | medium | high', 'medium')
  .option('--characters <names>', 'Character names (comma-separated)', '')
  .option('--location <slug>', 'Location slug the shot plays in (defaults to the anchor shot\'s location)')
  .option(
    '--blocking <text>',
    'Explicit spatial blocking: each character/object\'s position relative to the location\'s named anchors, frame side, depth, and facing/eyeline. Defaults to the anchor shot\'s blocking (same geography) when characters overlap.',
  )
  .option('--dialogue <line>', 'Dialogue line (omit for action/insert shots)')
  .option('--speaker <name>', 'Dialogue speaker name')
  .option('--transition <name>', 'Transition into the next shot', 'CUT')
  .action(async (opts: {
    project: string; episode: number; after: string; description: string;
    type: string; duration: string; motion: string;
    characters: string; location?: string; blocking?: string;
    dialogue?: string; speaker?: string; transition: string;
  }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }
    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    // Resolve the insertion anchor. `--after 3` and `--after "3b"` both work.
    const afterNumeric = parseInt(opts.after, 10);
    const afterSuffix = opts.after.slice(String(afterNumeric).length);
    const anchorIdx = script.shots.findIndex(s =>
      s.shotNumber === afterNumeric && (s.shotIdSuffix ?? '') === afterSuffix,
    );
    if (anchorIdx < 0) {
      console.error(`Shot ${opts.after} not found in episode ${opts.episode}.`);
      process.exit(1);
    }

    // Find the next free suffix letter for this shotNumber. The first
    // insert after shot N gets suffix "b" (shot N stays unsuffixed = "a").
    const usedSuffixes = new Set(
      script.shots
        .filter(s => s.shotNumber === afterNumeric)
        .map(s => s.shotIdSuffix ?? ''),
    );
    let candidate = '';
    for (const letter of 'bcdefghijklmnopqrstuvwxyz') {
      if (!usedSuffixes.has(letter)) { candidate = letter; break; }
    }
    if (!candidate) {
      console.error(`No free suffix letters left for shotNumber ${afterNumeric}.`);
      process.exit(1);
    }

    const characters = opts.characters
      ? opts.characters.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const dialogue = opts.dialogue
      ? { character: opts.speaker ?? characters[0] ?? 'NARRATOR', line: opts.dialogue }
      : null;

    const motion = (opts.motion as 'low' | 'medium' | 'high');
    const validMotions = new Set(['low', 'medium', 'high']);
    if (!validMotions.has(motion)) {
      console.error(`--motion must be one of: low | medium | high`);
      process.exit(1);
    }

    // Spatial continuity (rule 49): a spliced shot inherits the anchor shot's
    // location by default, and — when it covers the same characters in the
    // same place — the anchor's blocking too, so the new coverage keeps the
    // scene's established geography instead of re-inferring placement.
    const anchorShot = script.shots[anchorIdx];
    const location = opts.location ?? anchorShot.location;
    let blocking = opts.blocking;
    if (!blocking && anchorShot.blocking && location === anchorShot.location
      && characters.some(c => anchorShot.characters.map(n => n.toUpperCase()).includes(c.toUpperCase()))) {
      blocking = anchorShot.blocking;
      console.log(`  Inherited blocking from shot ${opts.after}: "${blocking}"`);
      console.log('  (override with --blocking if the staging changes in this shot)');
    }
    if (characters.length > 0 && !blocking) {
      console.warn(
        '  ⚠ No --blocking supplied and none inheritable. Without explicit geometry ' +
        '(who is where, relative to which location anchor, facing which way), placement ' +
        'is re-inferred at generation time and spatial continuity can drift.',
      );
    }

    const newShot = {
      shotNumber: afterNumeric,
      shotIdSuffix: candidate,
      type: opts.type as 'establishing' | 'dialogue' | 'action' | 'reaction' | 'insert' | 'close-up',
      duration: opts.duration,
      videoModel: 'action' as const,
      description: opts.description,
      ...(location ? { location } : {}),
      ...(blocking ? { blocking } : {}),
      characters,
      dialogue,
      sfx: null,
      cameraMovement: 'static',
      transition: opts.transition,
      motion,
    };

    // Archive the pre-insert script so we can rollback.
    const episodeDir = getEpisodeDir(series, opts.episode);
    const archivePath = join(episodeDir, `script-pre-insert-${Date.now()}.json`);
    await writeFile(archivePath, JSON.stringify(script, null, 2), 'utf-8');

    // Splice the new shot in directly after the anchor.
    script.shots.splice(anchorIdx + 1, 0, newShot);
    await saveEpisodeScript(series, script);

    const newId = `${afterNumeric}${candidate}`;
    console.log(`Inserted shot ${newId} after shot ${opts.after} in episode ${opts.episode}.`);
    console.log(`  Archived previous script: ${basename(archivePath)}`);
    console.log(`  Shots now: ${script.shots.length}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Generate panel for the new shot:`);
    console.log(`     storyboard-episode -p ${series.outputDir} -e ${opts.episode}`);
    console.log(`     (existing panels are skipped unless --force; only the new shot will render)`);
    console.log(`  2. Re-render the video for the new shot:`);
    console.log(`     generate-videos -p ${series.outputDir} -e ${opts.episode}`);
    console.log(`  3. Re-assemble the episode:`);
    console.log(`     assemble-episode -p ${series.outputDir} -e ${opts.episode}`);
    if (dialogue) {
      console.log(`  4. (Dialogue shot) generate the TTS line for shot ${newId} before re-assembling.`);
    }
    await updateTreatment(series, opts.episode);
  });

// ── approve-script ───────────────────────────────────────────────────
program
  .command('approve-script')
  .description('Mark an episode script as approved, unblocking storyboard generation')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--notes <notes>', 'Approval notes')
  .action(async (opts: { project: string; episode: number; notes?: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    script.status = 'approved';
    await saveEpisodeScript(series, script);

    const episodeDir = getEpisodeDir(series, opts.episode);
    const artifactPath = join(episodeDir, 'script-approved.json');
    const artifact = {
      episode: opts.episode,
      approvedAt: new Date().toISOString(),
      notes: opts.notes || 'Script reviewed and approved.',
      shotCount: script.shots.length,
      totalDuration: script.totalDuration,
    };
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2), 'utf-8');

    const ep = series.episodes.find(e => e.number === opts.episode);
    if (ep) ep.status = 'scripted';
    await saveSeries(series);

    console.log(`Script approved for Episode ${opts.episode}: "${script.title}"`);
    console.log(`  Artifact: ${artifactPath}`);
    console.log(`  Shots: ${script.shots.length} | Duration: ${script.totalDuration}`);
    console.log(`\nStoryboard generation is now unblocked.`);
    console.log(`  Run: storyboard-episode -p ${series.outputDir} -e ${opts.episode}`);
    await updateTreatment(series, opts.episode);
  });

// ── qa-storyboard ─────────────────────────────────────────────────────
program
  .command('qa-storyboard')
  .description('Analyze storyboard panels for character/setting consistency using vision')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--model <model>', "Override the project's vision model for this run")
  .option('--shots <range>', 'Specific shots to check (e.g. "3,5,7" or "3-7")')
  .action(async (opts: { project: string; episode: number; model?: string; shots?: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const episodeDir = getEpisodeDir(series, opts.episode);
    const sceneDir = join(episodeDir, 'scene-001');

    let shotsToCheck = script.shots;
    if (opts.shots) {
      const nums = new Set<number>();
      for (const part of opts.shots.split(',')) {
        if (part.includes('-')) {
          const [a, b] = part.split('-').map(Number);
          for (let i = a; i <= b; i++) nums.add(i);
        } else {
          nums.add(Number(part));
        }
      }
      shotsToCheck = script.shots.filter(s => nums.has(s.shotNumber));
    }

    // An explicit --model here names the panel reader directly, so it is used
    // verbatim -- substituting a "safer" vision model would silently ignore
    // the flag. Without one, fall back to the project's paired vision model.
    const qaModel = opts.model ?? intelligenceFor(series).visionModel;
    console.log(`QA Storyboard: Episode ${opts.episode} (${shotsToCheck.length} shots, model: ${qaModel})\n`);

    type QaVerdict = 'PASS' | 'FLAG-CRITICAL' | 'FLAG-MODERATE' | 'FLAG-LOW';
    interface ShotQaResult {
      shotNumber: number;
      type: string;
      characters: string[];
      verdict: QaVerdict;
      issues: string[];
      notes: string;
      /** The vision call itself failed, so this shot was never actually read. */
      errored?: boolean;
    }

    const results: ShotQaResult[] = [];
    const { readFileSync: readFs } = await import('node:fs');
    const toDataUri = (p: string) => `data:image/png;base64,${readFs(p).toString('base64')}`;

    const systemPrompt = `You are a visual QA analyst for an animated mini-drama series. Your job is to compare storyboard panels against character reference images, the series aesthetic, and adjacent panels to check for consistency issues.

For each panel, evaluate:
1. CHARACTER CONSISTENCY: Do characters match their reference images? Check hair color/style, facial features, body type, wardrobe, skin tone.
2. SETTING CONTINUITY: Does the environment match the shot description? Time of day, weather, location details.
3. COMPOSITION: Does the framing match the intended shot type and camera description?
4. SPATIAL CONTINUITY: Does the panel match the shot's stated blocking — is each character/object on the stated frame side, at the stated depth, facing the stated direction, positioned correctly relative to the named location landmarks? When a previous panel from the same location is provided, verify characters keep their screen sides and relative positions, eyelines/screen direction are preserved (180-degree rule), and landmarks have not moved, mirrored, or rearranged.

Respond ONLY in this exact JSON format (no markdown, no code fences):
{"verdict":"PASS|FLAG-CRITICAL|FLAG-MODERATE|FLAG-LOW","issues":["issue 1","issue 2"],"notes":"brief overall assessment"}

Verdict rules:
- PASS: Panel matches references, description, blocking, and spatial continuity well
- FLAG-CRITICAL: Major character identity mismatch (wrong hair color, wrong gender presentation, missing character) OR a spatial flip that breaks the scene (characters swapped sides, geography mirrored/rearranged vs the previous panel)
- FLAG-MODERATE: Noticeable wardrobe or feature deviation, wrong composition, character on the wrong side of frame vs the stated blocking, moved/relocated landmark
- FLAG-LOW: Minor stylistic drift or small placement deviation, acceptable for production`;

    for (let i = 0; i < shotsToCheck.length; i++) {
      const shot = shotsToCheck[i];
      const shotNum = String(shot.shotNumber).padStart(3, '0');
      const panelPath = join(sceneDir, `shot-${shotNum}.png`);

      if (!existsSync(panelPath)) {
        results.push({
          shotNumber: shot.shotNumber, type: shot.type, characters: shot.characters,
          verdict: 'FLAG-CRITICAL', issues: ['Panel file missing'], notes: 'No panel generated',
        });
        console.log(`  [${i + 1}/${shotsToCheck.length}] Shot ${shotNum}: MISSING`);
        continue;
      }

      const images: string[] = [toDataUri(panelPath)];

      for (const charName of shot.characters.slice(0, 2)) {
        const charDir = getCharacterDir(series, charName);
        const frontPath = join(charDir, 'front.png');
        if (existsSync(frontPath)) {
          images.push(toDataUri(frontPath));
        }
      }

      // Spatial continuity: attach the nearest PRIOR panel from the same
      // location (when one exists) so the vision model can verify screen
      // sides, eyelines, and landmark geography against actual coverage
      // instead of prose alone.
      let prevPanelNote = '';
      if (shot.location) {
        const prior = [...script.shots]
          .filter(s => s.location === shot.location && s.shotNumber < shot.shotNumber)
          .sort((a, b) => b.shotNumber - a.shotNumber)[0];
        if (prior) {
          const priorPath = join(sceneDir, `shot-${String(prior.shotNumber).padStart(3, '0')}.png`);
          if (existsSync(priorPath)) {
            images.push(toDataUri(priorPath));
            prevPanelNote = `The FINAL image is the previous panel in the same location (shot ${prior.shotNumber}`
              + (prior.blocking ? `, blocking: ${prior.blocking}` : '')
              + '). Check spatial continuity against it: same screen sides, preserved eyelines, unmoved landmarks.';
          }
        }
      }

      const charDescs = shot.characters.map(name => {
        const char = series.characters.find(c => c.name.toUpperCase() === name.toUpperCase());
        return char ? `${char.name}: ${char.description}, wearing ${shot.episodeWardrobe?.[name.toUpperCase()] ?? char.wardrobe}` : name;
      });

      const shotLocation = shot.location ? getLocation(series, shot.location) : undefined;

      const userPrompt = [
        `Analyze this storyboard panel (image 1) for shot ${shot.shotNumber}.`,
        `Shot type: ${shot.type}. Camera: ${shot.cameraMovement}.`,
        `Description: ${shot.panelDescription ?? shot.description}`,
        shot.blocking ? `Stated blocking: ${shot.blocking}` : '',
        shotLocation?.spatialAnchors ? `Location landmarks (fixed layout): ${shotLocation.spatialAnchors}` : '',
        shot.characters.length > 0
          ? `Characters in shot: ${charDescs.join('; ')}. Reference images follow the panel.`
          : 'No characters expected in this shot. Verify the scene is empty of people.',
        prevPanelNote,
      ].filter(Boolean).join('\n');

      try {
        const parsed = await client.chatJson<{ verdict: QaVerdict; issues: string[]; notes: string }>({
          model: qaModel,
          systemPrompt,
          userPrompt,
          images,
          maxTokens: 4000,
          temperature: 0.3,
          label: `shot ${shotNum} QA`,
        });

        results.push({
          shotNumber: shot.shotNumber, type: shot.type, characters: shot.characters,
          ...parsed,
        });

        const icon = parsed.verdict === 'PASS' ? '✓' : parsed.verdict === 'FLAG-CRITICAL' ? '✗' : '⚠';
        console.log(`  [${i + 1}/${shotsToCheck.length}] Shot ${shotNum}: ${icon} ${parsed.verdict}${parsed.issues.length > 0 ? ' -- ' + parsed.issues[0] : ''}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        results.push({
          shotNumber: shot.shotNumber, type: shot.type, characters: shot.characters,
          verdict: 'FLAG-LOW', issues: [`QA analysis failed: ${reason}`], notes: 'Vision API error',
          errored: true,
        });
        console.warn(`  [${i + 1}/${shotsToCheck.length}] Shot ${shotNum}: QA failed - ${reason}`);
      }
    }

    // A shot the model never managed to look at is not a low-severity finding,
    // it is an unchecked shot. Counting it as FLAG-LOW alone once let a whole
    // storyboard read as "no critical issues" when every call had failed.
    const erroredCount = results.filter(r => r.errored).length;

    // Persist QA report
    const report = {
      episode: opts.episode,
      model: qaModel,
      analyzedAt: new Date().toISOString(),
      summary: {
        total: results.length,
        pass: results.filter(r => r.verdict === 'PASS').length,
        flagCritical: results.filter(r => r.verdict === 'FLAG-CRITICAL').length,
        flagModerate: results.filter(r => r.verdict === 'FLAG-MODERATE').length,
        flagLow: results.filter(r => r.verdict === 'FLAG-LOW').length,
        errored: erroredCount,
      },
      results,
    };

    const reportPath = join(episodeDir, 'qa-report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`QA Report: ${report.summary.pass} PASS, ${report.summary.flagCritical} CRITICAL, ${report.summary.flagModerate} MODERATE, ${report.summary.flagLow} LOW`);
    console.log(`Report saved: ${reportPath}`);

    if (erroredCount > 0) {
      console.log(`\n${erroredCount} of ${results.length} shot(s) were never checked — ${qaModel} could not read them:`);
      for (const r of results.filter(shot => shot.errored)) {
        console.log(`  Shot ${String(r.shotNumber).padStart(3, '0')}: ${r.issues.join(', ')}`);
      }
      console.log(`\nThose shots are unverified, not approved. Fix the model and re-run:`);
      console.log(`  qa-storyboard -p ${series.outputDir} -e ${opts.episode}`);
    }

    if (report.summary.flagCritical > 0) {
      console.log(`\n${report.summary.flagCritical} critical issue(s) found. Fix panels before proceeding.`);
      const criticalShots = results.filter(r => r.verdict === 'FLAG-CRITICAL');
      for (const r of criticalShots) {
        console.log(`  Shot ${String(r.shotNumber).padStart(3, '0')}: ${r.issues.join(', ')}`);
      }
    } else if (erroredCount === 0) {
      console.log(`\nNo critical issues. Run: qa-approve -p ${series.outputDir} -e ${opts.episode}`);
    }
    await updateTreatment(series, opts.episode);
  });

// ── qa-approve ────────────────────────────────────────────────────────
program
  .command('qa-approve')
  .description('Mark storyboard panels as QA-approved, unblocking video generation')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--notes <notes>', 'QA approval notes')
  .action(async (opts: { project: string; episode: number; notes?: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const episodeDir = getEpisodeDir(series, opts.episode);
    const qaPath = join(episodeDir, 'qa-approved.json');

    const artifact = {
      episode: opts.episode,
      approvedAt: new Date().toISOString(),
      notes: opts.notes || 'Panels reviewed and approved.',
    };

    await writeFile(qaPath, JSON.stringify(artifact, null, 2), 'utf-8');
    console.log(`QA approved for Episode ${opts.episode}.`);
    console.log(`  Artifact: ${qaPath}`);
    console.log(`\nVideo generation is now unblocked. Run: generate-videos -p ${series.outputDir} -e ${opts.episode}`);
    await updateTreatment(series, opts.episode);
  });

// ── generate-videos ───────────────────────────────────────────────────
program
  .command('generate-videos')
  .description('Generate video clips from storyboard panels (with native audio)')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--skip-qa', 'Skip QA approval check', false)
  .option('--no-seedance-keyframe', 'Disable the automatic Seedance R2V keyframe pipeline that anchors identity for keyframe-only lip-sync models (see AGENTS.md rule 32).')
  .option('--no-montage', 'Disable montage-first planning for this run (fall back to 2.0-era per-shot / 15s multi-shot units).')
  .option('--auto-edit', 'After cutting montage renders, let the harness assemble the edit automatically (overrides videoDefaults.autoEdit for this run).')
  .option('--no-auto-edit', 'Provide the montage cuts in the media library only; do not auto-assemble.')
  .action(async (opts: { project: string; episode: number; skipQa: boolean; seedanceKeyframe: boolean; montage: boolean; autoEdit?: boolean }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    const episodeDir = getEpisodeDir(series, opts.episode);
    const qaPath = join(episodeDir, 'qa-approved.json');
    if (!opts.skipQa && !existsSync(qaPath)) {
      console.error('Blocked: rendering is billed at queue time and the QA gate has not been cleared by a human.');
      console.error(`  Review:  qa-storyboard -p ${series.outputDir} -e ${opts.episode}`);
      console.error(`  Clear it with:  qa-approve -p ${series.outputDir} -e ${opts.episode}`);
      console.error('  --skip-qa only bypasses this check; it does not clear QA and is not the fix.');
      process.exit(1);
    }

    // commander's --no-<flag> negates the camelCase option. When the user
    // passes --no-seedance-keyframe we flip the series-level default for
    // this run only (no persisted change to series.json).
    if (opts.seedanceKeyframe === false) {
      series.videoDefaults = { ...series.videoDefaults, seedanceKeyframeForWan: false };
      console.log('Seedance R2V keyframe pipeline DISABLED for this run.\n');
    }
    if (opts.montage === false) {
      series.videoDefaults = { ...series.videoDefaults, montageMode: false };
      console.log('Montage-first planning DISABLED for this run (2.0-era per-shot units).\n');
    }
    // --auto-edit / --no-auto-edit override videoDefaults.autoEdit per run.
    if (opts.autoEdit !== undefined) {
      series.videoDefaults = { ...series.videoDefaults, autoEdit: opts.autoEdit };
    }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const sceneDir = join(episodeDir, 'scene-001');
    const generationPlan = buildGenerationPlan(script, series);

    console.log(`Generating videos for Episode ${opts.episode}: ${script.title}`);
    const ccModel = series.videoDefaults.characterConsistencyModel ?? DEFAULT_CHARACTER_CONSISTENCY_MODEL;
    console.log(`Models: action=${series.videoDefaults.actionModel}, atmosphere=${series.videoDefaults.atmosphereModel}, character-consistency=${ccModel}\n`);
    console.log(`Generation units: ${generationPlan.units.length}`);
    const montageUnits = generationPlan.units.filter(unit => unit.unitType === 'montage');
    if (montageUnits.length > 0) {
      const models = Array.from(new Set(montageUnits.map(u => u.model))).join(', ');
      const beatCount = montageUnits.reduce((sum, u) => sum + u.shotNumbers.length, 0);
      console.log(`Montage units: ${montageUnits.length} (${models}) — ${beatCount} beats in single-pass generations, cut per-beat after render`);
      console.log(`Auto-edit: ${resolveAutoEdit(series.videoDefaults) ? 'ON — assembling automatically after the cut' : 'OFF — cuts land in media-library/scene-NN/ for hand editing'}`);
    }
    const multiUnits = generationPlan.units.filter(
      unit => unit.unitType === 'multishot' || unit.unitType === 'kling-multishot',
    );
    if (multiUnits.length > 0) {
      const models = Array.from(new Set(multiUnits.map(u => u.model))).join(', ');
      console.log(`Native multi-shot units: ${multiUnits.length} (${models})`);
    }
    const seedanceKeyframeCount = generationPlan.units.filter(unit => unit.useSeedanceKeyframe).length;
    if (seedanceKeyframeCount > 0) {
      const lipSync = series.videoDefaults.lipSyncModel ?? DEFAULT_LIP_SYNC_MODEL;
      console.log(`Seedance R2V keyframe → ${lipSync} units: ${seedanceKeyframeCount} (~$0.85 each; AGENTS.md rule 32)`);
    }
    console.log('');

    // Fold the series-level audioStrategy into the episode's audioMix when
    // the user hasn't explicitly set suppressModelNarration. 'narrator-vo'
    // tells Seedance `audio: false` for every dialogue shot at queue time so
    // the model can't generate a competing narrator under the Venice TTS.
    const effectiveAudioMix = (() => {
      const mix = { ...(script.audioMix ?? {}) };
      if (mix.suppressModelNarration === undefined && series.videoDefaults.audioStrategy === 'narrator-vo') {
        mix.suppressModelNarration = true;
      }
      return mix;
    })();

    // Storyboard blocking plates (per scene beat): plan beats for the
    // episode, generate any plates missing on disk, and persist the
    // storyboardRef assignments so the video prompts can bind them as
    // @ImageN composition references. Best-effort — a failure just means
    // the shots render without a blocking plate.
    try {
      const { generated, skipped } = await ensureEpisodeStoryboardReferences(client, series, script);
      if (generated.length > 0 || skipped.length > 0) {
        console.log(`Storyboard blocking plates: ${generated.length} generated, ${skipped.length} reused.\n`);
        await saveEpisodeScript(series, script);
      }
    } catch (err) {
      console.warn(`⚠ Storyboard plate pass failed: ${(err as Error).message}\n`);
    }

    const { videoPaths, plan } = await generateEpisodeVideos(client, series, script.shots, sceneDir, generationPlan, effectiveAudioMix);
    await saveGenerationPlan(episodeDir, plan);

    const ep = series.episodes.find(e => e.number === opts.episode);
    if (ep) ep.status = 'produced';
    await saveSeries(series);

    console.log(`\nGenerated ${videoPaths.length} video clips.`);
    console.log(`Generation plan saved to: ${join(episodeDir, 'generation-plan.json')}`);

    const hadMontage = plan.units.some(unit => unit.unitType === 'montage');
    const mediaLibraryDir = join(episodeDir, 'media-library');
    if (hadMontage && existsSync(mediaLibraryDir)) {
      console.log(`Media library: ${mediaLibraryDir} (per-scene cuts + uncut masters + manifest.json)`);
    }

    if (hadMontage && resolveAutoEdit(series.videoDefaults)) {
      // Auto-edit lane: the cut per-shot clips are already at their
      // canonical paths, so the standard assembler produces the edit.
      console.log('\nAuto-edit is ON — assembling the episode from the montage cuts...\n');
      await updateTreatment(series, opts.episode);
      await program.parseAsync(['', '', 'assemble-episode', '-p', opts.project, '-e', String(opts.episode)]);
      return;
    }

    if (hadMontage) {
      console.log('\nAuto-edit is OFF — the montage cuts are in the media library, organized by scene and shot.');
      console.log('Cut them by hand (or in the Venice Video Creator), or run:');
      console.log(`  assemble-episode -p ${series.outputDir} -e ${opts.episode}`);
    } else {
      console.log(`Next: assemble-episode -p ${series.outputDir} -e ${opts.episode}`);
    }
    await updateTreatment(series, opts.episode);
  });

// ── override-audio ────────────────────────────────────────────────────
program
  .command('override-audio')
  .description('Replace dialogue/SFX with Venice audio models (optional, post video-gen)')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--dialogue', 'Override dialogue with Venice TTS', false)
  .option('--sfx', 'Generate SFX overrides', false)
  .action(async (opts: { project: string; episode: number; dialogue: boolean; sfx: boolean }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const episodeDir = getEpisodeDir(series, opts.episode);
    const audioDir = join(episodeDir, 'audio');
    await mkdir(audioDir, { recursive: true });

    if (opts.dialogue) {
      console.log('Generating dialogue with locked character voices...');
      const lines: DialogueLine[] = script.shots
        .filter(s => s.dialogue)
        .map(s => {
          const char = getCharacter(series, s.dialogue!.character);
          return {
            shotNumber: s.shotNumber,
            character: s.dialogue!.character,
            voiceId: char?.voiceId || '',
            text: s.dialogue!.line,
            voicePrompt: char?.voiceDescription,
          };
        })
        .filter(l => l.voiceId);

      if (lines.length === 0) {
        console.warn('  No characters have locked voices. Run audition-voices first.');
      } else {
        await generateDialogueForShots(client, lines, audioDir);
        console.log(`  Generated ${lines.length} dialogue lines (mapped to shot numbers).`);
      }
    }

    if (opts.sfx) {
      console.log('Generating SFX overrides...');
      const sfxShots = script.shots.filter(s => s.sfx);
      for (let i = 0; i < sfxShots.length; i++) {
        const shot = sfxShots[i];
        const outputPath = join(audioDir, `sfx-${String(i + 1).padStart(3, '0')}.mp3`);
        try {
          await generateSoundEffect(
            client,
            {
              text: shot.sfx!,
              durationSeconds: parseShotDurationSeconds(shot.duration),
            },
            outputPath,
          );
          console.log(`  SFX: "${shot.sfx!.slice(0, 40)}" -> ${outputPath}`);
        } catch (err) {
          console.warn(`  SFX failed: ${err}`);
        }
      }
    }

    console.log(`\nAudio overrides saved to: ${audioDir}`);
    await updateTreatment(series, opts.episode);
  });

// ── generate-music ────────────────────────────────────────────────────
program
  .command('generate-music')
  .description('Generate background music track via Venice audio')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--prompt <prompt>', 'Music style/mood description')
  .option('--duration <value>', 'Duration in seconds, or milliseconds for backward compatibility', '60')
  .option('--model <id>', `Venice music model (default ${DEFAULT_VENICE_MUSIC_MODEL})`)
  .option('--voice <voice>', 'Voice id for voice-enabled models (e.g. seed-audio-1-0)')
  .option('--speed <value>', 'Playback speed for speed-enabled models (e.g. 0.5-2 for seed-audio-1-0)', parseFloat)
  .action(async (opts: {
    project: string; episode: number; prompt?: string; duration: string;
    model?: string; voice?: string; speed?: number;
  }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    if (opts.model && !getMusicModel(opts.model)) {
      console.error(`Unknown music model: ${opts.model}. Run \`inspect models --category music\` for options.`);
      process.exit(1);
    }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const episodeDir = getEpisodeDir(series, opts.episode);
    const audioDir = join(episodeDir, 'audio');
    await mkdir(audioDir, { recursive: true });

    const musicPrompt = opts.prompt || `Dramatic ${series.genre} background music, tension and emotion, cinematic`;
    const outputPath = join(audioDir, 'music.mp3');
    const durationSeconds = normalizeAudioDurationSeconds(opts.duration, 60);

    console.log(`Generating music: "${musicPrompt}" (${durationSeconds}s)${opts.model ? ` via ${opts.model}` : ''}`);
    await generateMusic(client, {
      prompt: musicPrompt,
      durationSeconds,
      modelId: opts.model,
      voice: opts.voice,
      speed: opts.speed,
    }, outputPath);

    console.log(`Music saved: ${outputPath}`);
    await updateTreatment(series, opts.episode);
  });

// ── generate-audio (Seed Audio 1.0 expressive speech / prompt-driven audio) ──
program
  .command('generate-audio')
  .description('Generate expressive speech / prompt-driven audio via Venice (default: Seed Audio 1.0)')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .requiredOption('--prompt <prompt>', 'Text/script to speak, or an audio description (<=2048 chars for seed-audio-1-0)')
  .option('--out <filename>', 'Output filename written under the episode audio dir', 'seed-audio.mp3')
  .option('--model <id>', `Venice audio model (default ${DEFAULT_VENICE_SEED_AUDIO_MODEL})`, DEFAULT_VENICE_SEED_AUDIO_MODEL)
  .option('--voice <voice>', 'Voice id (default: model default; seed-audio uses "Describe in prompt")')
  .option('--speed <value>', 'Playback speed 0.5-2 (default 1)', parseFloat)
  .option('--duration <value>', 'Duration in seconds (default: model default)', parseFloat)
  .action(async (opts: {
    project: string; episode: number; prompt: string; out: string;
    model: string; voice?: string; speed?: number; duration?: number;
  }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const spec = getMusicModel(opts.model);
    if (!spec) {
      console.error(`Unknown audio model: ${opts.model}. Run \`inspect models --category music\` for options.`);
      process.exit(1);
    }

    const apiKey = await getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const episodeDir = getEpisodeDir(series, opts.episode);
    const audioDir = join(episodeDir, 'audio');
    await mkdir(audioDir, { recursive: true });

    const outputPath = join(audioDir, opts.out);
    const voiceLabel = opts.voice ?? spec.defaultVoice ?? 'model default';
    console.log(`Generating audio via ${opts.model} [voice: ${voiceLabel}]: "${opts.prompt.slice(0, 60)}${opts.prompt.length > 60 ? '…' : ''}"`);

    await generateSeedAudio(client, {
      prompt: opts.prompt,
      modelId: opts.model,
      voice: opts.voice,
      speed: opts.speed,
      durationSeconds: opts.duration,
    }, outputPath);

    console.log(`Audio saved: ${outputPath}`);
  });

// ── validate-episode ─────────────────────────────────────────────────
program
  .command('validate-episode')
  .description('Check shot numbering, file integrity, and generation plan consistency')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .action(async (opts: { project: string; episode: number }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    const episodeDir = getEpisodeDir(series, opts.episode);
    const sceneDir = join(episodeDir, 'scene-001');

    let issues = 0;
    const warn = (msg: string) => { issues++; console.log(`  ⚠ ${msg}`); };
    const ok = (msg: string) => { console.log(`  ✓ ${msg}`); };

    console.log(`Validating Episode ${opts.episode}: ${script.title}\n`);

    // 1. Check shot numbering is sequential starting from 1
    console.log('Shot numbering:');
    const shotNumbers = script.shots.map(s => s.shotNumber);
    const expectedNumbers = script.shots.map((_, i) => i + 1);
    const numberingOk = shotNumbers.every((n, i) => n === expectedNumbers[i]);
    if (numberingOk) {
      ok(`Sequential 1-${shotNumbers.length}`);
    } else {
      warn(`Non-sequential: [${shotNumbers.join(',')}] (expected [${expectedNumbers.join(',')}])`);
    }

    const dupes = shotNumbers.filter((n, i) => shotNumbers.indexOf(n) !== i);
    if (dupes.length > 0) {
      warn(`Duplicate shot numbers: ${dupes.join(', ')}`);
    }

    // 2. Check panel files exist for every shot
    console.log('\nPanel files:');
    let missingPanels = 0;
    let orphanPanels = 0;
    for (const shot of script.shots) {
      const panelPath = join(sceneDir, `shot-${String(shot.shotNumber).padStart(3, '0')}.png`);
      if (!existsSync(panelPath)) {
        warn(`Missing panel: shot-${String(shot.shotNumber).padStart(3, '0')}.png`);
        missingPanels++;
      }
    }
    if (missingPanels === 0) ok(`All ${script.shots.length} panels present`);

    // Check for orphan panel files (panels with no matching shot in script)
    if (existsSync(sceneDir)) {
      const panelFiles = readdirSync(sceneDir).filter((f: string) => /^shot-\d{3}\.png$/.test(f));
      for (const f of panelFiles) {
        const num = parseInt(f.match(/shot-(\d{3})\.png/)![1], 10);
        if (!shotNumbers.includes(num)) {
          warn(`Orphan panel: ${f} (not in script)`);
          orphanPanels++;
        }
      }
      if (orphanPanels === 0 && panelFiles.length > 0) ok('No orphan panels');
    }

    // 3. Check video files
    console.log('\nVideo files:');
    let missingVideos = 0;
    let orphanVideos = 0;
    for (const shot of script.shots) {
      const videoPath = join(sceneDir, `shot-${String(shot.shotNumber).padStart(3, '0')}.mp4`);
      if (!existsSync(videoPath)) {
        missingVideos++;
      }
    }
    if (missingVideos === 0) {
      ok(`All ${script.shots.length} videos present`);
    } else if (missingVideos === script.shots.length) {
      ok(`No videos generated yet (expected pre-video-gen)`);
    } else {
      warn(`${missingVideos}/${script.shots.length} videos missing`);
    }

    if (existsSync(sceneDir)) {
      const videoFiles = readdirSync(sceneDir).filter((f: string) => /^shot-\d{3}\.mp4$/.test(f));
      for (const f of videoFiles) {
        const num = parseInt(f.match(/shot-(\d{3})\.mp4/)![1], 10);
        if (!shotNumbers.includes(num)) {
          warn(`Orphan video: ${f} (not in script)`);
          orphanVideos++;
        }
      }
      if (orphanVideos === 0 && videoFiles.length > 0) ok('No orphan videos');
    }

    // 4. Check generation plan consistency
    console.log('\nGeneration plan:');
    const { loadGenerationPlan } = await import('./generation-planner.js');
    const plan = await loadGenerationPlan(episodeDir);
    if (!plan) {
      ok('No generation plan yet (expected pre-video-gen)');
    } else {
      const planShotNumbers = plan.units.flatMap(u => u.shotNumbers).sort((a, b) => a - b);
      const scriptShotNumbers = [...shotNumbers].sort((a, b) => a - b);
      const planCoversAll = JSON.stringify(planShotNumbers) === JSON.stringify(scriptShotNumbers);
      if (planCoversAll) {
        ok(`Plan covers all ${scriptShotNumbers.length} shots (${plan.units.length} units)`);
      } else {
        const inPlanNotScript = planShotNumbers.filter(n => !scriptShotNumbers.includes(n));
        const inScriptNotPlan = scriptShotNumbers.filter(n => !planShotNumbers.includes(n));
        if (inPlanNotScript.length > 0) warn(`In plan but not script: [${inPlanNotScript.join(',')}]`);
        if (inScriptNotPlan.length > 0) warn(`In script but not plan: [${inScriptNotPlan.join(',')}]`);
      }
    }

    // 5. Check script field completeness
    console.log('\nScript completeness:');
    const missingDuration = script.shots.filter(s => !s.duration);
    const missingType = script.shots.filter(s => !s.type);
    const missingDesc = script.shots.filter(s => !s.description);
    const missingTransition = script.shots.filter(s => !s.transition);
    const missingCamera = script.shots.filter(s => !s.cameraMovement);

    if (missingDuration.length > 0) warn(`${missingDuration.length} shots missing duration`);
    if (missingType.length > 0) warn(`${missingType.length} shots missing type`);
    if (missingDesc.length > 0) warn(`${missingDesc.length} shots missing description`);
    if (missingTransition.length > 0) warn(`${missingTransition.length} shots missing transition`);
    if (missingCamera.length > 0) warn(`${missingCamera.length} shots missing cameraMovement`);
    if (missingDuration.length + missingType.length + missingDesc.length + missingTransition.length + missingCamera.length === 0) {
      ok('All required fields present');
    }

    // 6. Check character references
    console.log('\nCharacter references:');
    const allCharNames = Array.from(new Set(script.shots.flatMap(s => s.characters.map(c => c.toUpperCase()))));
    for (const name of allCharNames) {
      const char = series.characters.find(c => c.name.toUpperCase() === name);
      if (!char) {
        warn(`Character "${name}" in script but not in series.json`);
      } else if (!char.locked) {
        warn(`Character "${name}" not locked`);
      }
    }
    if (allCharNames.every(name => {
      const char = series.characters.find(c => c.name.toUpperCase() === name);
      return char && char.locked;
    })) {
      ok(`All ${allCharNames.length} characters locked`);
    }

    console.log(`\n${'─'.repeat(50)}`);
    if (issues === 0) {
      console.log(`Validation PASSED — no issues found.`);
    } else {
      console.log(`Validation found ${issues} issue(s). Fix before proceeding.`);
    }
  });

// ── validate-video-outputs ────────────────────────────────────────────
program
  .command('validate-video-outputs')
  .description('Post-generation QA: check aspect ratios, R2V usage, and durations')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .action(async (opts: { project: string; episode: number }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    const episodeDir = getEpisodeDir(series, opts.episode);
    const sceneDir = join(episodeDir, 'scene-001');
    const expectedAR = series.storyboardAspectRatio ?? '16:9';

    let issues = 0;
    const warn = (msg: string) => { issues++; console.log(`  ⚠ ${msg}`); };
    const ok = (msg: string) => { console.log(`  ✓ ${msg}`); };

    console.log(`Validating Video Outputs — Episode ${opts.episode}: ${script.title}`);
    console.log(`Expected aspect ratio: ${expectedAR}\n`);

    // 1. Aspect ratio check via ffprobe
    console.log('Aspect ratio:');
    let arIssues = 0;
    for (const shot of script.shots) {
      const videoPath = join(sceneDir, `shot-${String(shot.shotNumber).padStart(3, '0')}.mp4`);
      if (!existsSync(videoPath)) continue;

      try {
        const dims = runCommand('ffprobe', [
          '-v',
          'quiet',
          '-show_entries',
          'stream=width,height',
          '-of',
          'csv=p=0',
          videoPath,
        ]).trim().split('\n')[0];
        const [w, h] = dims.split(',').map(Number);

        if (expectedAR === '16:9' && h > w) {
          warn(`Shot ${shot.shotNumber}: ${w}x${h} is PORTRAIT but series expects landscape (16:9)`);
          arIssues++;
        } else if (expectedAR === '9:16' && w > h) {
          warn(`Shot ${shot.shotNumber}: ${w}x${h} is LANDSCAPE but series expects portrait (9:16)`);
          arIssues++;
        }
      } catch {
        warn(`Shot ${shot.shotNumber}: failed to probe dimensions`);
        arIssues++;
      }
    }
    if (arIssues === 0) ok('All video aspect ratios match series setting');

    // 2. R2V model usage — flag character shots that used non-R2V models
    console.log('\nR2V model enforcement:');
    let r2vIssues = 0;
    for (const shot of script.shots) {
      if (shot.characters.length === 0) continue;

      const metaPath = join(sceneDir, `shot-${String(shot.shotNumber).padStart(3, '0')}.video.json`);
      if (!existsSync(metaPath)) continue;

      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        const model = meta.video?.model || meta.model || '';
        if (!model.includes('reference-to-video')) {
          warn(`Shot ${shot.shotNumber}: has characters [${shot.characters.join(', ')}] but used model "${model}" (not R2V)`);
          r2vIssues++;
        }
      } catch {
        warn(`Shot ${shot.shotNumber}: could not parse video metadata`);
        r2vIssues++;
      }
    }
    if (r2vIssues === 0) ok('All character shots use R2V models');

    // 3. Duration check
    console.log('\nDuration accuracy:');
    let durIssues = 0;
    const DURATION_TOLERANCE_SEC = 3;
    for (const shot of script.shots) {
      const videoPath = join(sceneDir, `shot-${String(shot.shotNumber).padStart(3, '0')}.mp4`);
      if (!existsSync(videoPath)) continue;

      try {
        const actualDur = parseFloat(
          runCommand('ffprobe', [
            '-v',
            'quiet',
            '-show_entries',
            'format=duration',
            '-of',
            'csv=p=0',
            videoPath,
          ]).trim(),
        );
        const requestedDur = parseInt(shot.duration, 10);
        const diff = Math.abs(actualDur - requestedDur);
        if (diff > DURATION_TOLERANCE_SEC) {
          warn(`Shot ${shot.shotNumber}: actual ${actualDur.toFixed(1)}s vs requested ${requestedDur}s (diff ${diff.toFixed(1)}s)`);
          durIssues++;
        }
      } catch {
        warn(`Shot ${shot.shotNumber}: failed to probe duration`);
        durIssues++;
      }
    }
    if (durIssues === 0) ok(`All durations within ${DURATION_TOLERANCE_SEC}s tolerance`);

    console.log(`\n${'─'.repeat(50)}`);
    if (issues === 0) {
      console.log('Video output validation PASSED — no issues found.');
    } else {
      console.log(`Video output validation found ${issues} issue(s). Review and re-render affected shots.`);
    }
  });

// ── assemble-episode ──────────────────────────────────────────────────
program
  .command('assemble-episode')
  .description('Stitch video clips + (optional) Venice dialogue replacement + music + subtitles')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--no-subtitles', 'Skip subtitle burn-in')
  .option('--no-music', 'Skip background music mixing')
  .option('--no-ambient', 'Skip ambient bed mixing')
  .option('--ambient-volume <vol>', 'Ambient bed volume (0-1)', '0.3')
  // Default is OFF. Native model dialogue (Seedance / Wan 2.7 / HappyHorse)
  // is preferred until Venice ships better TTS voice options. Pass
  // --dialogue-replace to opt in (typically when you've also run
  // `override-audio --dialogue` to produce dialogue-shot-NNN.mp3 files).
  // --no-dialogue-replace is kept as an explicit alias so scripts that
  // already pass it don't break (it's now a no-op since the default is
  // already false).
  .option('--dialogue-replace', 'Replace native model dialogue with Venice TTS (off by default; flip on only when override-audio --dialogue has produced dialogue-shot-NNN.mp3 files)', false)
  .option('--no-dialogue-replace', 'Explicitly disable Venice TTS dialogue replacement (now the default — kept for backward compatibility with older scripts)')
  // Default is intentionally unset; resolved below to `0` when
  // --dialogue-replace is on (so model-generated narration / dialogue can't
  // fight the Venice TTS) and `1.0` otherwise. Pass the flag explicitly to
  // override either default — for example, --native-volume 0.2 keeps a soft
  // ambient bed under the TTS for shots whose model audio is just room tone.
  // Per-shot `shot.nativeAudio: 'mute' | 'duck' | 'keep'` always wins.
  .option('--native-volume <vol>', 'Native audio volume in the final mix (0-1). Default: 0 with --dialogue-replace, 1.0 otherwise. Per-shot shot.nativeAudio overrides this default.')
  .action(async (opts: {
    project: string; episode: number; subtitles: boolean; music: boolean;
    ambient: boolean; ambientVolume: string;
    dialogueReplace: boolean; nativeVolume?: string;
  }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    const episodeDir = getEpisodeDir(series, opts.episode);
    const sceneDir = join(episodeDir, 'scene-001');
    const audioDir = join(episodeDir, 'audio');

    const videoFiles = await collectShotVideos(sceneDir);
    if (videoFiles.length === 0) {
      console.error('No video clips found. Run generate-videos first.');
      process.exit(1);
    }

    console.log(`Assembling Episode ${opts.episode}: ${script.title}`);
    console.log(`  ${videoFiles.length} video clips`);

    const hasDialogueFiles = existsSync(audioDir) &&
      readdirSync(audioDir).some((f: string) => f.startsWith('dialogue-shot-'));
    // Default is now OFF — native model dialogue is the recommended path.
    // Only replace when the user explicitly opts in via --dialogue-replace
    // AND the TTS files exist.
    // Series-level audio strategy (set at series-creation time via the
    // upfront questionnaire) sets the default for --dialogue-replace:
    //   - 'native'      : false (model audio plays as-is)
    //   - 'lip-sync'    : true  (Venice TTS replaces native; lip-sync is
    //                            handled by routing dialogue shots to Wan 2.7
    //                            via videoDefaults.lipSyncModel)
    //   - 'narrator-vo' : true  (Venice TTS owns the dialogue lane; Seedance
    //                            was already told audio:false at queue time
    //                            via audioMix.suppressModelNarration, so this
    //                            ensures the final mix actually plays the TTS)
    // Operator flag (--dialogue-replace / --no-dialogue-replace) always wins.
    const seriesAudioStrategy = series.videoDefaults.audioStrategy;
    const strategyImpliesReplace =
      seriesAudioStrategy === 'lip-sync' || seriesAudioStrategy === 'narrator-vo';
    const dialogueReplaceFlagPassed = opts.dialogueReplace === true;
    const effectiveDialogueReplace = dialogueReplaceFlagPassed || strategyImpliesReplace;
    const useDialogueReplace = effectiveDialogueReplace && hasDialogueFiles;

    // Resolve --native-volume default: 0 with --dialogue-replace (Venice TTS
    // owns the dialogue lane; let nothing compete), 1.0 otherwise. An
    // explicit operator flag always wins.
    const nativeVolumeDefault = useDialogueReplace ? 0 : 1.0;
    const nativeVolume = opts.nativeVolume !== undefined
      ? parseFloat(opts.nativeVolume)
      : nativeVolumeDefault;

    if (useDialogueReplace) {
      const explicit = opts.nativeVolume !== undefined ? ' (operator override)' : ' (default)';
      console.log(`  Dialogue replacement: ON (Venice TTS; native audio at ${Math.round(nativeVolume * 100)}%${explicit})`);
    } else if (opts.dialogueReplace === true && !hasDialogueFiles) {
      console.log(`  Dialogue replacement: OFF (--dialogue-replace was set but no dialogue-shot-NNN.mp3 files exist -- run override-audio --dialogue first)`);
    } else {
      console.log(`  Dialogue replacement: OFF (default — using native model dialogue at ${Math.round(nativeVolume * 100)}% volume)`);
    }

    // Collect per-shot trim/flip metadata from script
    const shotTrims = script.shots
      .filter(s => s.trimStart || s.trimEnd || s.flip)
      .map(s => ({ shotNumber: s.shotNumber, trimStart: s.trimStart, trimEnd: s.trimEnd, flip: s.flip }));
    if (shotTrims.length > 0) {
      console.log(`  Trim/flip metadata: ${shotTrims.length} shots`);
    }

    const endingTitleShot = [...script.shots].reverse().find(s => s.titleOverlay?.text?.trim());
    if (endingTitleShot?.titleOverlay?.text) {
      console.log(`  Ending title overlay: "${endingTitleShot.titleOverlay.text}"`);
    }

    let srtPath: string | undefined;
    if (opts.subtitles !== false) {
      const subtitles = generateSubtitles(script.shots, sceneDir);
      if (subtitles.length > 0) {
        srtPath = join(episodeDir, 'subtitles.srt');
        await saveSrt(subtitles, srtPath);
        console.log(`  Generated ${subtitles.length} subtitle entries`);
      }
    }

    const musicPath = join(audioDir, 'music.mp3');
    const hasMusic = opts.music !== false && existsSync(musicPath);

    const ambientLayerNames = [
      'ambient-rain-heavy.mp3',
      'ambient-rain.mp3',
      'ambient-crowd.mp3',
      'ambient-quiet-night.mp3',
    ];
    const ambientPaths = ambientLayerNames
      .map(name => join(audioDir, name))
      .filter(p => existsSync(p));
    const ambientPath = ambientPaths[0];
    const hasAmbient = opts.ambient !== false && ambientPaths.length > 0;
    if (hasAmbient) {
      console.log(`  Ambient beds: ${ambientPaths.length} layer(s) found (${Math.round(parseFloat(opts.ambientVolume) * 100)}% volume)`);
      for (const p of ambientPaths) {
        console.log(`    - ${p.split('/').pop()}`);
      }
      if (ambientPaths.length > 1) {
        console.log(`  Note: assemble-episode uses only the first ambient layer. For multi-layer mixing, use: npx tsx scripts/mix-episode-audio.ts`);
      }
    } else if (opts.ambient !== false) {
      console.log(`  Ambient bed: OFF (no ambient bed found in audio/)`);
    }

    const epNum = String(opts.episode).padStart(3, '0');
    const outputPath = join(episodeDir, `episode-${epNum}-final.mp4`);

    // Resolve audio paths for each music cue so the assembler picks up
    // either spec.audioPath (script-provided) or the canonical
    // audio/music-cue-NNN.mp3 next to the episode. When a cue has no
    // resolvable audio, the assembler falls back to the single-bed musicPath.
    const cueAudioPathFor = (spec: { audioPath?: string; startShot: number | string }): string | undefined => {
      if (spec.audioPath) return resolve(opts.project, spec.audioPath);
      const shotId = typeof spec.startShot === 'number'
        ? String(spec.startShot).padStart(3, '0')
        : spec.startShot;
      const candidates = [
        join(audioDir, `music-cue-${shotId}.mp3`),
        join(audioDir, `music-shot-${shotId}.mp3`),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
      return undefined;
    };
    // Hydrate musicCues with resolved audio paths so renderMusicCuesTrack
    // can render directly without re-resolving inside the assembler.
    const hydratedCues = script.musicCues?.map(spec => ({
      ...spec,
      audioPath: spec.audioPath ? resolve(opts.project, spec.audioPath) : cueAudioPathFor(spec),
    }));

    await assembleEpisode({
      videoFiles,
      outputPath,
      srtPath,
      musicPath: hasMusic ? musicPath : undefined,
      musicVolume: 0.15,
      musicCues: hydratedCues,
      shots: script.shots,
      ambientBedPath: hasAmbient ? ambientPath : undefined,
      ambientBedVolume: parseFloat(opts.ambientVolume),
      dialogueDir: useDialogueReplace ? audioDir : undefined,
      nativeAudioVolume: nativeVolume,
      shotTrims,
      endingTitleOverlay: endingTitleShot?.titleOverlay,
      audioMix: script.audioMix,
    });

    const ep = series.episodes.find(e => e.number === opts.episode);
    if (ep) ep.status = 'assembled';
    await saveSeries(series);

    console.log(`\nFinal episode: ${outputPath}`);
    await updateTreatment(series, opts.episode);
  });

// ── export-timeline ─────────────────────────────────
// Builds an XML timeline from the rendered shots + audio in an episode
// directory. Output format selected via --format:
//   fcpxml   — Final Cut Pro X (FCPXML 1.10), the original  path
//   premiere — Adobe Premiere Pro (xmeml v5)
//   davinci  — DaVinci Resolve (tuned FCPXML 1.10; drops colorSpace,
//              raw file:// paths, mono/stereo srcCh hint)
//
// Standard layout assumed:
//   <episodeDir>/scene-001/shot-NNN.mp4         (video segments)
//   <episodeDir>/audio/dialogue-shot-NNN.mp3    (dialogue, lane -1)
//   <episodeDir>/audio/sfx/<*>.mp3               (SFX, lane -2)
//   <episodeDir>/audio/music.mp3                 (music, lane -3)
// Anything missing is dropped silently from the export — the XML still
// imports cleanly, just with fewer connected clips.

type ExportFormat = 'fcpxml' | 'premiere' | 'davinci';

const EXPORT_FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  fcpxml: '.fcpxml',
  premiere: '.premiere.xml',
  davinci: '.resolve.fcpxml',
};

const EXPORT_IMPORT_HINTS: Record<ExportFormat, string> = {
  fcpxml: 'In FCP X: File > Import > XML… and select this file.',
  premiere: 'In Premiere Pro: File > Import… and select this file.',
  davinci: 'In DaVinci Resolve: File > Import > Timeline… and select this file.',
};

async function runTimelineExport(opts: {
  project: string; episode: number; fps: string; width: string; height: string;
  format: ExportFormat;
}): Promise<void> {
  const series = await loadSeries(resolve(opts.project));
  if (!series) { console.error('Series not found.'); process.exit(1); }
  const script = await loadEpisodeScript(series, opts.episode);
  if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

  const episodeDir = getEpisodeDir(series, opts.episode);
  const sceneDir = join(episodeDir, 'scene-001');
  const audioDir = join(episodeDir, 'audio');
  const sfxDir = join(audioDir, 'sfx');
  const videoFiles = await collectShotVideos(sceneDir);
  if (videoFiles.length === 0) {
    console.error('No video clips found. Run generate-videos first.');
    process.exit(1);
  }

  const { exportTimeline } = await import('./timeline-export/index.js');
  const { spawnSync: spawnSyncLocal } = await import('node:child_process');
  function probeDur(path: string): number {
    const r = spawnSyncLocal('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
    ], { encoding: 'utf-8' });
    return parseFloat(String(r.stdout).trim());
  }

  let cursor = 0;
  const segments: Array<{ path: string; label: string; durSec: number; startSec: number }> = [];
  for (const path of videoFiles) {
    const dur = probeDur(path);
    const filename = basename(path, '.mp4');
    segments.push({ path, label: filename, durSec: dur, startSec: cursor });
    cursor += dur;
  }
  const masterDur = cursor;

  // Placement map keyed by shot id ( zero-padded form).
  const placementMap: Record<string, { startSec: number; endSec: number }> = {};
  for (const seg of segments) {
    const m = seg.label.match(/^shot-(\d+)([a-zA-Z]*)/);
    if (!m) continue;
    const key = String(m[1]).padStart(3, '0') + m[2];
    placementMap[key] = { startSec: seg.startSec, endSec: seg.startSec + seg.durSec };
  }

  const audio: Array<{
    path: string; label: string; startSec: number; audioDur: number;
    lane: -1 | -2 | -3; role: 'dialogue.dialogue' | 'effects.effects' | 'music.music';
  }> = [];

  if (existsSync(audioDir)) {
    for (const shot of script.shots) {
      const key = String(shot.shotNumber).padStart(3, '0')
        + ((shot as { shotIdSuffix?: string }).shotIdSuffix ?? '');
      const place = placementMap[key];
      if (!place) continue;
      const path = join(audioDir, `dialogue-shot-${key}.mp3`);
      if (!existsSync(path)) continue;
      audio.push({
        path,
        label: `${key} ${shot.dialogue?.character ?? 'NARRATOR'}`,
        startSec: place.startSec + 0.2,
        audioDur: probeDur(path),
        lane: -1,
        role: 'dialogue.dialogue',
      });
    }
    if (existsSync(sfxDir)) {
      const sfxFiles = readdirSync(sfxDir).filter((f: string) => f.endsWith('.mp3'));
      for (const f of sfxFiles) {
        const m = f.match(/shot-(\d+)([a-zA-Z]*)/);
        if (!m) continue;
        const key = String(m[1]).padStart(3, '0') + m[2];
        const place = placementMap[key];
        if (!place) continue;
        const fullPath = join(sfxDir, f);
        audio.push({
          path: fullPath,
          label: f.replace(/\.mp3$/, ''),
          startSec: place.startSec,
          audioDur: probeDur(fullPath),
          lane: -2,
          role: 'effects.effects',
        });
      }
    }
    const musicPath = join(audioDir, 'music.mp3');
    if (existsSync(musicPath)) {
      audio.push({
        path: musicPath,
        label: 'music',
        startSec: 0,
        audioDur: Math.min(probeDur(musicPath), masterDur),
        lane: -3,
        role: 'music.music',
      });
    }
  }

  const epNum = String(opts.episode).padStart(3, '0');
  const ext = EXPORT_FORMAT_EXTENSIONS[opts.format];
  const outPath = join(episodeDir, `episode-${epNum}${ext}`);
  const finalPath = await exportTimeline(opts.format, {
    outputPath: outPath,
    segments,
    audio,
    totalDurationSec: masterDur,
    fps: parseInt(opts.fps, 10),
    width: parseInt(opts.width, 10),
    height: parseInt(opts.height, 10),
    eventName: script.title,
  });

  console.log(`Timeline (${opts.format}): ${finalPath}`);
  console.log(`  Segments: ${segments.length}`);
  console.log(`  Connected clips: ${audio.length}`);
  console.log(`    dialogue (lane -1): ${audio.filter(a => a.lane === -1).length}`);
  console.log(`    SFX (lane -2):      ${audio.filter(a => a.lane === -2).length}`);
  console.log(`    music (lane -3):    ${audio.filter(a => a.lane === -3).length}`);
  console.log(`\n${EXPORT_IMPORT_HINTS[opts.format]}`);
}

program
  .command('export-timeline')
  .description('Export an XML timeline for FCP X / Premiere / DaVinci Resolve')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--format <fmt>', 'fcpxml | premiere | davinci', 'fcpxml')
  .option('--fps <fps>', 'Frames per second', '24')
  .option('--width <px>', 'Sequence width', '1920')
  .option('--height <px>', 'Sequence height', '1080')
  .action(async (opts: {
    project: string; episode: number; format: string;
    fps: string; width: string; height: string;
  }) => {
    const validFormats: ExportFormat[] = ['fcpxml', 'premiere', 'davinci'];
    if (!validFormats.includes(opts.format as ExportFormat)) {
      console.error(`--format must be one of: ${validFormats.join(' | ')}`);
      process.exit(1);
    }
    await runTimelineExport({ ...opts, format: opts.format as ExportFormat });
  });

// Back-compat alias kept so anyone scripted against 's command name
// still works. Forwards to runTimelineExport with format=fcpxml.
program
  .command('export-fcpxml')
  .description('[Alias of export-timeline --format fcpxml]')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--fps <fps>', 'Frames per second', '24')
  .option('--width <px>', 'Sequence width', '1920')
  .option('--height <px>', 'Sequence height', '1080')
  .action(async (opts: {
    project: string; episode: number; fps: string; width: string; height: string;
  }) => {
    await runTimelineExport({ ...opts, format: 'fcpxml' });
  });

// ── finish / upscale ──────────────────────────────────────────────────
function probeVideoDuration(path: string): number {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
  ], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`ffprobe failed for ${path}: ${result.stderr || result.stdout}`);
  const duration = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(duration)) throw new Error(`Could not read video duration: ${path}`);
  return duration;
}

async function runUpscale(opts: {
  input: string; output?: string; factor: string; segmentSeconds: string;
  concurrency: string; keepWorkDir: boolean; yes: boolean;
}): Promise<void> {
  const inputPath = resolve(opts.input);
  if (!existsSync(inputPath)) throw new Error(`Input video not found: ${inputPath}`);
  const factor = Number.parseInt(opts.factor, 10);
  if (factor !== 2 && factor !== 4) throw new Error('--factor must be 2 or 4');
  const outputPath = opts.output
    ? resolve(opts.output)
    : inputPath.replace(/\.(mp4|mov)$/i, factor === 4 ? '-4k.mp4' : '-2x.mp4');
  if (resolve(outputPath) === inputPath) throw new Error('Output path must differ from input path.');

  const inputSeconds = probeVideoDuration(inputPath);
  const estimate = estimateUpscaleCostUsd(inputSeconds);
  console.log(`Input: ${inputPath} (${inputSeconds.toFixed(1)}s, ${(statSync(inputPath).size / 1e6).toFixed(0)}MB)`);
  console.log(`Output: ${outputPath}`);
  console.log(`Upscale: ${factor}x via topaz-video-upscale`);
  console.log(`Estimated cost: ~$${estimate.toFixed(2)} (~$0.12 per input second)`);
  if (!opts.yes) {
    console.log('\nReview the estimate, then re-run with --yes to start.');
    return;
  }

  const apiKey = await getVeniceApiKey();
  const client = new VeniceClient(apiKey);
  const result = await upscaleVideo(client, {
    inputPath,
    outputPath,
    factor: factor as 2 | 4,
    segmentSeconds: Number.parseInt(opts.segmentSeconds, 10),
    concurrency: Number.parseInt(opts.concurrency, 10),
    keepWorkDir: opts.keepWorkDir,
    onProgress: message => console.log(`  ${message}`),
  });
  console.log(`\nUpscaled master: ${result.path}`);
  console.log(`  ${result.width}x${result.height} · ${(result.sizeBytes / 1e6).toFixed(0)}MB · ${result.chunks} chunks`);
}

program
  .command('upscale')
  .description('Advanced: upscale any finished video 2x or 4x with Topaz')
  .requiredOption('-i, --input <file>', 'Input video')
  .option('-o, --output <file>', 'Output path')
  .option('--factor <n>', '2 or 4; both cost the same', '4')
  .option('--segment-seconds <s>', 'Upload-safe chunk length', '10')
  .option('--concurrency <n>', 'Parallel upscale jobs', '3')
  .option('--keep-work-dir', 'Keep intermediate chunks', false)
  .option('--yes', 'Confirm estimated spend and start', false)
  .action(runUpscale);

program
  .command('finish')
  .description('Create the requested delivery master for an assembled project')
  .requiredOption('-p, --project <dir>', 'Project output directory')
  .option('--part <number>', 'Internal script part number', '1')
  .option('--4k', 'Create a 4K master even if the workshop requests standard delivery', false)
  .option('-i, --input <file>', 'Override the assembled input master')
  .option('-o, --output <file>', 'Override the delivery output path')
  .option('--segment-seconds <s>', 'Upload-safe chunk length', '10')
  .option('--concurrency <n>', 'Parallel upscale jobs', '3')
  .option('--keep-work-dir', 'Keep intermediate chunks', false)
  .option('--yes', 'Confirm estimated spend and start', false)
  .action(async (opts: {
    project: string; part: string; '4k': boolean; input?: string; output?: string;
    segmentSeconds: string; concurrency: string; keepWorkDir: boolean; yes: boolean;
  }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) throw new Error(`Project not found: ${opts.project}`);
    const workshop = await loadWorkshop(series);
    const wants4k = opts['4k'] || workshop?.productionNotes.delivery === '4k';
    const part = Number.parseInt(opts.part, 10);
    const partDir = getEpisodeDir(series, part);
    const partNum = String(part).padStart(3, '0');
    const inputPath = opts.input
      ? resolve(opts.input)
      : join(partDir, `episode-${partNum}-final.mp4`);
    if (!existsSync(inputPath)) {
      throw new Error(`Assembled master not found: ${inputPath}. Run assemble-episode first or pass --input.`);
    }
    if (!wants4k) {
      console.log('Workshop delivery target is Standard master.');
      console.log(`Master ready: ${inputPath}`);
      console.log('Use --4k to create a 4K delivery master anyway.');
      return;
    }

    const mastersDir = join(series.outputDir, 'masters');
    await mkdir(mastersDir, { recursive: true });
    const outputPath = opts.output
      ? resolve(opts.output)
      : join(mastersDir, `${series.slug}-master-4k.mp4`);
    await runUpscale({
      input: inputPath,
      output: outputPath,
      factor: '4',
      segmentSeconds: opts.segmentSeconds,
      concurrency: opts.concurrency,
      keepWorkDir: opts.keepWorkDir,
      yes: opts.yes,
    });
    await updateTreatment(series, part);
  });

// ── produce-episode ───────────────────────────────────────────────────
program
  .command('produce-episode')
  .description('Full pipeline: storyboard -> video -> music -> assembly')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--with-tts', 'Add Venice dialogue replacement for voice consistency across episodes', false)
  .option('--skip-music', 'Skip background music generation', false)
  .option('--resume-after-qa', 'Continue only after qa-approved.json exists', false)
  .action(async (opts: { project: string; episode: number; withTts: boolean; skipMusic: boolean; resumeAfterQa: boolean }) => {
    console.log('=== Full Episode Production Pipeline ===\n');

    const projectDir = resolve(opts.project);
    const series = await loadSeries(projectDir);
    if (!series) throw new Error(`Series not found: ${projectDir}`);
    const episodeDir = getEpisodeDir(series, opts.episode);
    const qaApprovedPath = join(episodeDir, 'qa-approved.json');

    if (!opts.resumeAfterQa) {
      console.log('Step 1: Generating storyboard panels...');
      await program.parseAsync(['', '', 'storyboard-episode', '-p', opts.project, '-e', String(opts.episode)]);
      console.log('\nStep 2: Running standalone vision QA...');
      await program.parseAsync(['', '', 'qa-storyboard', '-p', opts.project, '-e', String(opts.episode)]);
      console.log('\nProduction paused at the QA gate. Review qa-report.json and the panels.');
      console.log(`Approve with: venice-video qa-approve -p "${projectDir}" -e ${opts.episode}`);
      console.log(`Then resume: venice-video produce-episode -p "${projectDir}" -e ${opts.episode} --resume-after-qa`);
      return;
    }

    if (!existsSync(qaApprovedPath)) {
      throw new Error(`QA approval is missing: ${qaApprovedPath}. Run qa-approve before --resume-after-qa.`);
    }

    console.log('Step 3: Generating video clips (dialogue + SFX + ambient via native model audio)...');
    await program.parseAsync(['', '', 'generate-videos', '-p', opts.project, '-e', String(opts.episode)]);

    if (opts.withTts) {
      console.log('\nStep 4: Replacing dialogue with Venice TTS (voice consistency mode)...');
      await program.parseAsync(['', '', 'override-audio', '-p', opts.project, '-e', String(opts.episode), '--dialogue']);
    }

    if (!opts.skipMusic) {
      const stepNum = opts.withTts ? 5 : 4;
      console.log(`\nStep ${stepNum}: Generating background music...`);
      await program.parseAsync(['', '', 'generate-music', '-p', opts.project, '-e', String(opts.episode)]);
    }

    const finalStep = opts.withTts ? (opts.skipMusic ? 5 : 6) : (opts.skipMusic ? 4 : 5);
    console.log(`\nStep ${finalStep}: Assembling final episode (music + subtitles)...`);
    await program.parseAsync(['', '', 'assemble-episode', '-p', opts.project, '-e', String(opts.episode)]);

    console.log('\n=== Production Complete ===');
  });

// ── session: use / status / queue / shell ─────────────────────────────

program
  .command('use')
  .description('Select the project (and episode) that -p / -e default to')
  .argument('[project]', 'Project slug, name, or directory')
  .option('-e, --episode <number>', 'Episode number to select', parseInt)
  .option('--clear', 'Clear the current selection', false)
  .action(async (projectRef: string | undefined, opts: { episode?: number; clear: boolean }) => {
    if (opts.clear) {
      await clearContext();
      console.log('Selection cleared. Commands now require -p / -e again.');
      return;
    }

    if (!projectRef && opts.episode === undefined) {
      const context = await readContext();
      if (!context.project) {
        console.log('Nothing selected. Usage: venice-video use <project> [-e <episode>]');
        const workspace = await getWorkspaceDir(program.opts().workspace);
        const available = await listSeries(workspace);
        if (available.length > 0) {
          console.log('\nAvailable projects:');
          for (const entry of available) console.log(`  ${entry.slug.padEnd(28)} ${entry.name}`);
        }
        return;
      }
      console.log(`Project: ${context.project}`);
      if (context.episode !== undefined) console.log(`Episode: ${context.episode}`);
      return;
    }

    const patch: { project?: string; episode?: number } = {};
    if (projectRef) {
      const projectDir = await resolveProjectRef(projectRef, program.opts().workspace);
      const series = await loadSeries(projectDir);
      if (!series) {
        console.error(`No series.json found at ${projectDir}.`);
        console.error('Run `venice-video list-series` to see what is available.');
        process.exit(1);
      }
      patch.project = projectDir;
    }
    if (opts.episode !== undefined) patch.episode = opts.episode;

    const next = await setContext(patch);
    console.log(`Selected ${next.project}${next.episode !== undefined ? ` · episode ${next.episode}` : ''}`);
  });

program
  .command('unuse')
  .description('Clear the selected project and episode')
  .action(async () => {
    await clearContext();
    console.log('Selection cleared.');
  });

program
  .command('status')
  .description('Show pipeline state for a project and the next command to run')
  .option('-p, --project <dir>', 'Project directory (defaults to the selection)')
  .option('--json', 'Emit the project status as JSON')
  .action(async (opts: { project?: string; json?: boolean }) => {
    const json = wantsJson(opts);
    const context = await readContext();
    const projectRef = opts.project ?? context.project;
    if (!projectRef) {
      // No selection is an error for an agent checking the exit code, not just
      // an informational note — say what to do and exit non-zero.
      failJson(json, 'No project selected. Pass -p <dir> or run `venice-video use <project>`.', {
        hint: 'venice-video use <project>',
      });
      return;
    }
    const projectDir = await resolveProjectRef(projectRef, program.opts().workspace);
    const status = await collectProjectStatus(projectDir);
    if (!status) {
      failJson(json, `No series.json found at ${projectDir}.`, { projectDir });
      return;
    }
    if (json) emitJson({ ok: true, ...status, selectedEpisode: context.episode });
    else console.log(formatProjectStatus(status, context.episode));
  });

program
  .command('queue')
  .description('List Venice renders left in flight by an interrupted run')
  .argument('[action]', 'clear to drop a recorded job, prune to drop stale ones')
  .argument('[target]', 'Output path or queue id to clear')
  .option('--json', 'Emit the in-flight jobs as JSON')
  .action(async (action: string | undefined, target: string | undefined, opts: { json?: boolean }) => {
    const json = wantsJson(opts);
    if (!action && json) {
      const pending = await listPendingJobs();
      emitJson({
        ok: true,
        jobs: pending.map(job => ({ ...job, stale: isStale(job) })),
        note: 'Re-run the command that produced a job to re-attach instead of re-billing.',
      });
      return;
    }
    if (action === 'prune') {
      const removed = await prunePendingJobs();
      console.log(`Pruned ${removed} stale job record(s).`);
      return;
    }

    if (action === 'clear') {
      if (!target) {
        console.error('Usage: venice-video queue clear <output-path|queue-id>');
        process.exit(1);
        return;
      }
      const pending = await listPendingJobs();
      const match = pending.find(job => job.queueId === target)
        ?? pending.find(job => job.outputPath === resolve(target))
        ?? pending.find(job => job.outputPath.endsWith(target));
      if (!match) {
        console.error(`No recorded job matching "${target}".`);
        process.exit(1);
        return;
      }
      await clearPendingJob(match.outputPath);
      console.log(`Dropped ${match.queueId} (${match.outputPath}).`);
      console.log('Note: this only forgets the id locally. Venice already charged for the render.');
      return;
    }

    const pending = await listPendingJobs();
    if (pending.length === 0) {
      console.log('No Venice jobs are recorded as in flight.');
      return;
    }
    console.log(`${pending.length} job(s) recorded as in flight:\n`);
    for (const job of pending) {
      const ageMin = Math.round((Date.now() - Date.parse(job.updatedAt)) / 60_000);
      console.log(`  ${job.kind}  ${job.model}`);
      console.log(`    queue id   ${job.queueId}`);
      console.log(`    output     ${job.outputPath}`);
      console.log(`    last seen  ${ageMin} min ago${isStale(job) ? ' (stale — Venice has likely dropped it)' : ''}`);
      if (job.prompt) console.log(`    prompt     ${job.prompt.slice(0, 70)}…`);
      console.log('');
    }
    console.log('Re-run the command that produced these to re-attach instead of re-billing.');
  });

program
  .command('shell')
  .description('Start an interactive session that keeps the selected project and runs jobs in the background')
  .action(async () => {
    // Imported lazily so the shell (and its readline/job machinery) costs
    // nothing for one-shot invocations, and to avoid an import cycle back
    // into this module.
    const { startShell } = await import('../session/shell.js');
    await startShell(program);
  });

applyContextDefaults(program);

// Only parse when executed directly. The shell imports this module to reuse the
// same command tree, and must not have argv consumed at import time.
if (isMainModule(import.meta.url)) {
  try {
    await program.parseAsync();
  } catch (error) {
    // A missing project/episode selection is ordinary user error, not a crash —
    // report it the way Commander reports a missing required option.
    if (error instanceof MissingContextError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof OperationAbortedError) {
      console.error('Cancelled. Any in-flight Venice job is recorded — re-run to re-attach.');
      process.exit(130);
    }
    // Ordinary failures reach a non-TTY agent as an uncaught exception, which
    // prints a full stack trace and a `Node.js v22.x` footer — it reads as a
    // crash when the actionable part is one line. Report it as a clean error
    // and exit non-zero. Set VENICE_VIDEO_DEBUG=1 to see the stack.
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson()) emitJson({ ok: false, error: message });
    else console.error(`error: ${message}`);
    if (process.env.VENICE_VIDEO_DEBUG === '1' && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

export { program };

// ── Helpers ───────────────────────────────────────────────────────────

function generateCompareHtml(
  styles: { name: string; style: string; palette: string }[],
  seriesName: string,
): string {
  const cards = styles.map(s => `
    <div class="card">
      <img src="${s.name}.png" alt="${s.name}" />
      <h3>${s.name}</h3>
      <p>${s.style}</p>
      <p class="sub">${s.palette}</p>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Aesthetic Comparison - ${seriesName}</title>
  <style>
    body { background: #111; color: #eee; font-family: system-ui; padding: 2rem; }
    h1 { text-align: center; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1.5rem; }
    .card { background: #222; border-radius: 12px; overflow: hidden; }
    .card img { width: 100%; display: block; }
    .card h3 { padding: 0.5rem 1rem 0; margin: 0; }
    .card p { padding: 0 1rem 0.5rem; margin: 0; color: #aaa; font-size: 0.9rem; }
    .card .sub { color: #777; font-size: 0.8rem; padding-bottom: 1rem; }
  </style>
</head>
<body>
  <h1>${seriesName} - Aesthetic Options</h1>
  <div class="grid">${cards}</div>
</body>
</html>`;
}

function normalizeAudioDurationSeconds(rawValue: string, fallbackSeconds: number): number {
  const parsed = parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackSeconds;
  }

  if (parsed > 1_000) {
    return Math.max(1, Math.round(parsed / 1_000));
  }

  return parsed;
}

function parseShotDurationSeconds(duration: string): number {
  const match = duration.match(/(\d+(?:\.\d+)?)\s*s/i);
  if (match) {
    return Math.max(1, Math.round(parseFloat(match[1])));
  }

  const numeric = parseFloat(duration);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.max(1, Math.round(numeric));
  }

  return 5;
}
