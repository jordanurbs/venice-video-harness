#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { resolve, join, basename } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

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
} from '../series/types.js';
import {
  FEMALE_BASE_TRAITS,
  MALE_BASE_TRAITS,
  DEFAULT_ACTION_MODEL,
  DEFAULT_ATMOSPHERE_MODEL,
  DEFAULT_CHARACTER_CONSISTENCY_MODEL,
  DEFAULT_IMAGE_GENERATION_MODEL,
  DEFAULT_IMAGE_EDIT_MODEL,
} from '../series/types.js';
import type { AestheticProfile } from '../storyboard/prompt-builder.js';
import { VeniceClient } from '../venice/client.js';
import { upscaleVideo, estimateUpscaleCostUsd } from '../venice/upscale.js';
import { generateImage, generateWithReferences } from '../venice/generate.js';
import { writeImageBytesSmart } from '../venice/image-bytes.js';
import { appendRecipePass } from '../venice/recipe.js';
import { getVeniceApiKey } from '../config.js';
import { listVoices, filterVoices, auditionVoices } from '../venice/voices.js';
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

const program = new Command();
program
  .name('mini-drama')
  .description('Mini-Drama creation pipeline using Venice AI')
  .version('1.0.0');

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
      ? { ...existing, description: loc.description || existing.description, lightingNotes: loc.lightingNotes ?? existing.lightingNotes }
      : {
          name: loc.name,
          slug,
          description: loc.description,
          ...(loc.lightingNotes ? { lightingNotes: loc.lightingNotes } : {}),
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
  const note = ` Location: ${location.description}${location.lightingNotes ? ` Lighting: ${location.lightingNotes}.` : ''}`;
  return { location, refPath, note };
}

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
    '"native" (model speaks in-frame; default; best for 1-2 lines per character), ' +
    '"lip-sync" (Venice TTS + Wan 2.7 lip-sync; best when characters talk often), ' +
    '"narrator-vo" (NARRATOR voice-over only; auto-mutes the model audio so a competing AI narrator can\'t fight the TTS).',
  )
  .option(
    '--video-family <family>',
    'Preferred video model family: ' +
    'auto (default Seedance 2.0), seedance, happyhorse, grok-imagine, kling-o3. ' +
    'Swaps actionModel/atmosphereModel/characterConsistencyModel to that family. ' +
    'lipSyncModel stays on Wan 2.7 regardless.',
  )
  .action(async (opts: {
    name: string; concept: string; genre: string; setting: string;
    audioStrategy?: string; videoFamily?: string;
  }) => {
    const allowedAudio = new Set(['native', 'lip-sync', 'narrator-vo']);
    if (opts.audioStrategy && !allowedAudio.has(opts.audioStrategy)) {
      console.error(`--audio-strategy must be one of: ${[...allowedAudio].join(', ')}`);
      process.exit(2);
    }
    const allowedFamily = new Set(['auto', 'seedance', 'happyhorse', 'grok-imagine', 'kling-o3']);
    if (opts.videoFamily && !allowedFamily.has(opts.videoFamily)) {
      console.error(`--video-family must be one of: ${[...allowedFamily].join(', ')}`);
      process.exit(2);
    }
    const series = createSeries(opts.name, opts.concept, opts.genre, opts.setting, {
      audioStrategy: opts.audioStrategy as 'native' | 'lip-sync' | 'narrator-vo' | undefined,
      videoFamilyPreference: opts.videoFamily as 'auto' | 'seedance' | 'happyhorse' | 'grok-imagine' | 'kling-o3' | undefined,
    });
    await saveSeries(series);

    console.log(`\nSeries created: ${series.name}`);
    console.log(`  Slug: ${series.slug}`);
    console.log(`  Genre: ${series.genre}`);
    console.log(`  Concept: ${series.concept}`);
    console.log(`  Output: ${series.outputDir}`);
    if (series.videoDefaults.audioStrategy) {
      console.log(`  Audio strategy: ${series.videoDefaults.audioStrategy}`);
    }
    if (series.videoDefaults.videoFamilyPreference) {
      console.log(`  Video family: ${series.videoDefaults.videoFamilyPreference}`);
      console.log(`    actionModel: ${series.videoDefaults.actionModel}`);
      console.log(`    characterConsistencyModel: ${series.videoDefaults.characterConsistencyModel}`);
    }
    console.log(`\nNext: explore-aesthetic -p ${series.outputDir}`);
  });

// ── new-episode ──────────────────────────────────────────────────────
program
  .command('new-episode')
  .description('Scaffold a new episode directory and register it in series.json')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-t, --title <title>', 'Episode title')
  .action(async (opts: { project: string; title: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

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
      totalDuration: '60s',
      shots: [],
    };
    await writeFile(
      join(episodeDir, 'script.json'),
      JSON.stringify(templateScript, null, 2),
      'utf-8',
    );

    await saveSeries(series);

    console.log(`\nEpisode ${episode.number} created: "${opts.title}"`);
    console.log(`  Directory: ${episodeDir}`);
    console.log(`  Script: ${join(episodeDir, 'script.json')} (empty template -- workshop your shots)`);
    console.log(`\nNext: workshop your shot-by-shot script, then storyboard-episode -p ${series.outputDir} -e ${episode.number}`);
  });

// ── list-series ───────────────────────────────────────────────────────
program
  .command('list-series')
  .description('List all mini-drama series')
  .action(async () => {
    const all = await listSeries();
    if (all.length === 0) {
      console.log('No series found. Create one with: mini-drama new-series');
      return;
    }
    console.log('Mini-Drama Series:');
    for (const s of all) {
      console.log(`  ${s.name} (${s.slug}) -> ${s.dir}`);
    }
  });

// ── explore-aesthetic ─────────────────────────────────────────────────
program
  .command('explore-aesthetic')
  .description('Generate aesthetic comparison samples for a series')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .option('--count <n>', 'Number of aesthetic variants', '5')
  .action(async (opts: { project: string; count: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const apiKey = getVeniceApiKey();
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
      const apiKey = getVeniceApiKey();
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

    const apiKey = getVeniceApiKey();
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
      const apiKey = getVeniceApiKey();
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

    const apiKey = getVeniceApiKey();
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
  .option('--model <model>', 'Image-generation model for the reference angles (default nano-banana-pro)')
  .option('--skip-images', 'Skip reference image generation', false)
  .action(async (opts: { project: string; name: string; description: string; lighting?: string; model?: string; skipImages: boolean }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const slug = locationSlugify(opts.name);
    const seed = Math.abs([...opts.name].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)) % 999_999_999;

    const location: Location = {
      name: opts.name,
      slug,
      description: opts.description,
      ...(opts.lighting ? { lightingNotes: opts.lighting } : {}),
      seed,
      ...(opts.model ? { referenceModel: opts.model } : {}),
    };

    addLocation(series, location);

    if (!opts.skipImages && series.aesthetic) {
      const apiKey = getVeniceApiKey();
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

    const apiKey = getVeniceApiKey();
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

    const apiKey = getVeniceApiKey();
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
  .command('workshop-episode')
  .description('Generate an episode script draft using Venice LLM with full series context')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .requiredOption('--concept <text>', 'Episode concept/premise')
  .option('--model <model>', 'Venice chat model', 'llama-3.3-70b')
  .action(async (opts: { project: string; episode: number; concept: string; model: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const apiKey = getVeniceApiKey();
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

    // Gather prior episode summaries for continuity
    let priorEpisodes = '';
    for (const ep of series.episodes) {
      const script = await loadEpisodeScript(series, ep.number);
      if (script && script.shots.length > 0) {
        const dialogueLines = script.shots
          .filter(s => s.dialogue)
          .map(s => `  ${s.dialogue!.character}: "${s.dialogue!.line}"`)
          .join('\n');
        priorEpisodes += `\nEpisode ${ep.number} ("${ep.title}"): ${script.shots.length} shots, ${script.totalDuration}\n`;
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
      ? (series.locations ?? []).map(l => `${l.slug}: ${l.name} — ${l.description}${l.lightingNotes ? ` (lighting: ${l.lightingNotes})` : ''}`).join('\n')
      : 'None defined yet.';

    const systemPrompt = `You are a scriptwriter for the mini-drama series "${series.name}".

SERIES CONCEPT: ${series.concept}
GENRE: ${series.genre}
SETTING: ${series.setting}

AESTHETIC:
${aestheticStr}

CHARACTERS:
${charSummaries}

LOCATIONS (existing, reuse these slugs):
${locationSummaries}

PRIOR EPISODES:
${priorEpisodes || 'None yet.'}

SERIES REFERENCE DOCUMENTS:
${referenceContext || 'None available.'}

DIRECT THE SCENE, DON'T DECORATE IT (CRITICAL):
For every shot, first decide what the beat is DOING — the turn, the point of view, the power, the subtext — and name ONE intention. Then derive camera, lens, light, blocking, performance, and sound from that single intention. Do NOT stack empty "cinematic / epic / beautiful / dramatic / masterpiece / 4k" adjectives — they give the model nothing to serve. A reveal is not framed, lit, blocked, or performed like a goodbye; write the specific answer, not the generic one. Hold ONE directorial voice across every shot of the episode.
- Decorated (reject): "epic cinematic close-up of a woman reading a letter, emotional, beautiful lighting".
- Directed (write like this): "Medium close-up, eye-level; she lowers the letter and her hands go still as a slow push-in arrives; soft window light keeps her face plain; near-silence with one chair scrape — the realization lands in the stilled hands, not a word."
Direct INTENTION / CAMERA / LIGHT / BLOCKING / PERFORMANCE / SOUND only. Do NOT write exhaustive physical character descriptions or reference-image tags into "description" — identity is locked downstream by R2V character references. Name the character and direct what they DO.
When a take is close but wrong, the fix is one variable at a time (camera OR light OR motion OR framing), not a fresh pile of adjectives. When continuing a story, direct the next beat from what actually ended on screen, not from the original plan.

Your task is to write a complete episode script as a JSON object. Follow the exact format below. The script must:
- Target 58-75 seconds total duration
- Open with a visual hook in the first 3 seconds
- End on a beat that makes viewers want the next episode
- Use one scene, one location, one emotional note
- Give each shot ONE intention and derive its craft from it (see DIRECT THE SCENE above)
- Include specific delivery cues for all dialogue (see VOICE DIRECTION below)
- Use the correct videoModel ("action" for movement/dialogue, "atmosphere" for establishing/static)
- End with a title card shot (3s, type "insert", FADE transition)

SHOT DURATION — PREFER FEWER, LONGER SHOTS (CRITICAL):
The video models (Seedance 2.0, HappyHorse 1.1, Wan 2.7) all support up to 15 seconds in a single generation, and 15s is the strong default. For a 60-second episode, prefer 4 shots at ~15s each over 10 shots at ~6s. Reasons:
1. Identity stays locked longer — every new shot is a fresh generation where character likeness can drift.
2. Motion has room to breathe — short shots cut before gestures/expressions complete, which is one of the main "AI video looks twitchy" tells.
3. Cost is lower — fewer generations per episode.
4. Fewer transitions to police for continuity.
Only use shorts (3-8s) for *deliberate* short beats: hard cuts, sight gags, single-frame reactions, the closing title card. Default everything else to 12-15s.
- duration must be one of: "3s","4s","5s","6s","7s","8s","9s","10s","11s","12s","13s","14s","15s" (HappyHorse goes down to 3s; Seedance from 4s).
- Aim for the episode to contain roughly (target_seconds / 13) shots ± 1.

VOICE DIRECTION — NATIVE MODEL DIALOGUE IS PREFERRED:
The recommended pipeline uses the video model's own native dialogue (Seedance / Wan 2.7 / HappyHorse all generate in-character speech). Venice TTS is an exception path, not the default. Therefore every dialogue shot's "delivery" cue must be RICH — direct the voice like you're talking to a voice actor: timbre, accent, pacing, emotional register, breath placement, signature delivery quirks. Two-word "delivery": "angry" cues produce flat results; "delivery": "deliberate, half-volume drawl with a beat before the punchline; warm not bitter; breath audible before 'audacity'" produces in-character results.

NO MUSIC / NO SFX FROM THE VIDEO MODEL:
Every shot "description" MUST end with the literal phrase: "No background music, no sound effects, no soundtrack, dry recording." The harness adds music and ambient/SFX in post via separate Venice audio calls; baked-in music or SFX from the video model fights the assembler's mix. The "sfx" field in the schema below describes what the harness should generate in post — it does NOT instruct the video model to produce sound effects.

LOCATIONS — TAG EVERY SHOT WITH A LOCATION:
Define the physical place(s) this episode happens in as first-class locations, and tag every shot with the location it plays in. Locations anchor the environment across shots (consistent architecture, set dressing, and lighting) the same way character references anchor identity.
- Emit a top-level "locations" array. Each entry: {"name": "<Display Name>", "slug": "<kebab-case-slug>", "description": "<locked prose description of the environment — architecture, materials, set dressing, scale>", "lightingNotes": "<the established lighting for this place>"}.
- REUSE the existing location slugs listed above when the scene is in a place already defined; only introduce a new location entry when the place is genuinely new.
- Give every shot a "location" field set to the slug of the location it plays in.
- Since an episode uses "one scene, one location" by default, you will usually define exactly ONE location and tag all shots with its slug.

IMPORTANT: Every shot MUST include an "environment" field. This controls whether the pipeline uses the series' dark/rainy aesthetic or adapts it for bright daytime scenes. Values:
- "DAY_INTERIOR" -- bright indoor scene (café, office, apartment in daylight)
- "DAY_EXTERIOR" -- bright outdoor scene (street, park in daylight)
- "NIGHT_INTERIOR" -- indoor scene at night (club, bar, dimly lit room)
- "NIGHT_EXTERIOR" -- outdoor nighttime scene (street at night, rooftop at night)

Respond with ONLY valid JSON matching this exact schema (no markdown, no code fences, no explanation):
{
  "episode": <number>,
  "title": "<title>",
  "seriesName": "${series.name}",
  "totalDuration": "<estimated total>",
  "status": "draft",
  "locations": [
    {"name": "<Display Name>", "slug": "<kebab-case-slug>", "description": "<locked environment description>", "lightingNotes": "<established lighting>"}
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
      "panelDescription": "<optional single-frame description if description has sequential action>",
      "characters": ["<CHARACTER_NAME>"],
      "dialogue": {"character": "<NAME>", "line": "<text>", "delivery": "<rich voice-director cue: timbre, accent, pacing, emotion, breath, signature quirks>"} or null,
      "sfx": "<sound effects to GENERATE IN POST via Venice SFX>" or null,
      "cameraMovement": "<camera direction>",
      "transition": "CUT|FADE|DISSOLVE|MATCH CUT|SMASH CUT"
    }
  ]
}`;

    const userPrompt = `Write Episode ${opts.episode} with this concept: ${opts.concept}`;

    console.log(`Workshop: Generating script draft for Episode ${opts.episode}...`);
    console.log(`  Concept: ${opts.concept}`);
    console.log(`  Model: ${opts.model}`);
    console.log(`  Reference docs: ${mdFiles.length} (${mdFiles.join(', ') || 'none'})`);
    console.log(`  Prior episodes: ${series.episodes.length}\n`);

    try {
      const response = await client.post<{
        choices: Array<{ message: { content: string } }>;
      }>('/api/v1/chat/completions', {
        model: opts.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 8000,
        temperature: 0.7,
      });

      const raw = response.choices?.[0]?.message?.content ?? '';
      const jsonStr = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

      let script: EpisodeScript;
      try {
        script = JSON.parse(jsonStr) as EpisodeScript;
      } catch (parseErr) {
        console.error('Failed to parse LLM response as JSON.');
        console.error('Raw response (first 2000 chars):');
        console.error(jsonStr.slice(0, 2000));
        const dumpPath = join(getEpisodeDir(series, opts.episode), 'workshop-raw-response.txt');
        await mkdir(getEpisodeDir(series, opts.episode), { recursive: true });
        await writeFile(dumpPath, raw, 'utf-8');
        console.error(`\nFull response saved to: ${dumpPath}`);
        process.exit(1);
      }

      script.episode = opts.episode;
      script.seriesName = series.name;
      script.status = 'draft';

      if (!script.shots || script.shots.length === 0) {
        console.error('LLM returned a script with no shots. Try again or adjust the concept.');
        process.exit(1);
      }

      // Ensure episode exists in series.json
      if (!series.episodes.find(ep => ep.number === opts.episode)) {
        addEpisode(series, script.title || `Episode ${opts.episode}`);
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
      console.error('Script must be approved before storyboarding.');
      console.error('Review the script, then run: approve-script -p <project> -e <episode>');
      console.error('Or bypass with: storyboard-episode ... --skip-approval');
      process.exit(1);
    }

    const cfgScale = opts.cfgScale ?? 10;
    const apiKey = getVeniceApiKey();
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
    console.log(`\n>> QA REVIEW NEEDED: Run /qa-storyboard to check character/setting consistency before proceeding.`);
    console.log(`   The agent will compare each panel against character references and flag issues.`);
    console.log(`\nAfter QA approval: generate-videos -p ${series.outputDir} -e ${opts.episode}`);
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

    const apiKey = getVeniceApiKey();
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
  .option('--dialogue <line>', 'Dialogue line (omit for action/insert shots)')
  .option('--speaker <name>', 'Dialogue speaker name')
  .option('--transition <name>', 'Transition into the next shot', 'CUT')
  .action(async (opts: {
    project: string; episode: number; after: string; description: string;
    type: string; duration: string; motion: string;
    characters: string; dialogue?: string; speaker?: string; transition: string;
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

    const newShot = {
      shotNumber: afterNumeric,
      shotIdSuffix: candidate,
      type: opts.type as 'establishing' | 'dialogue' | 'action' | 'reaction' | 'insert' | 'close-up',
      duration: opts.duration,
      videoModel: 'action' as const,
      description: opts.description,
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
  });

// ── qa-storyboard ─────────────────────────────────────────────────────
program
  .command('qa-storyboard')
  .description('Analyze storyboard panels for character/setting consistency using vision')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--model <model>', 'Vision model for QA analysis', 'qwen-2.5-vl')
  .option('--shots <range>', 'Specific shots to check (e.g. "3,5,7" or "3-7")')
  .action(async (opts: { project: string; episode: number; model: string; shots?: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    const apiKey = getVeniceApiKey();
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

    console.log(`QA Storyboard: Episode ${opts.episode} (${shotsToCheck.length} shots, model: ${opts.model})\n`);

    type QaVerdict = 'PASS' | 'FLAG-CRITICAL' | 'FLAG-MODERATE' | 'FLAG-LOW';
    interface ShotQaResult {
      shotNumber: number;
      type: string;
      characters: string[];
      verdict: QaVerdict;
      issues: string[];
      notes: string;
    }

    const results: ShotQaResult[] = [];
    const { readFileSync: readFs } = await import('node:fs');
    const toDataUri = (p: string) => `data:image/png;base64,${readFs(p).toString('base64')}`;

    const systemPrompt = `You are a visual QA analyst for an animated mini-drama series. Your job is to compare storyboard panels against character reference images and the series aesthetic to check for consistency issues.

For each panel, evaluate:
1. CHARACTER CONSISTENCY: Do characters match their reference images? Check hair color/style, facial features, body type, wardrobe, skin tone.
2. SETTING CONTINUITY: Does the environment match the shot description? Time of day, weather, location details.
3. COMPOSITION: Does the framing match the intended shot type and camera description?

Respond ONLY in this exact JSON format (no markdown, no code fences):
{"verdict":"PASS|FLAG-CRITICAL|FLAG-MODERATE|FLAG-LOW","issues":["issue 1","issue 2"],"notes":"brief overall assessment"}

Verdict rules:
- PASS: Panel matches references and description well
- FLAG-CRITICAL: Major character identity mismatch (wrong hair color, wrong gender presentation, missing character)
- FLAG-MODERATE: Noticeable wardrobe or feature deviation, wrong composition
- FLAG-LOW: Minor stylistic drift, acceptable for production`;

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

      const charDescs = shot.characters.map(name => {
        const char = series.characters.find(c => c.name.toUpperCase() === name.toUpperCase());
        return char ? `${char.name}: ${char.description}, wearing ${shot.episodeWardrobe?.[name.toUpperCase()] ?? char.wardrobe}` : name;
      });

      const userPrompt = [
        `Analyze this storyboard panel (image 1) for shot ${shot.shotNumber}.`,
        `Shot type: ${shot.type}. Camera: ${shot.cameraMovement}.`,
        `Description: ${shot.panelDescription ?? shot.description}`,
        shot.characters.length > 0
          ? `Characters in shot: ${charDescs.join('; ')}. Reference images follow the panel.`
          : 'No characters expected in this shot. Verify the scene is empty of people.',
      ].join('\n');

      try {
        const raw = await client.chatWithVision(opts.model, systemPrompt, images, userPrompt);
        const jsonStr = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const parsed = JSON.parse(jsonStr) as { verdict: QaVerdict; issues: string[]; notes: string };

        results.push({
          shotNumber: shot.shotNumber, type: shot.type, characters: shot.characters,
          ...parsed,
        });

        const icon = parsed.verdict === 'PASS' ? '✓' : parsed.verdict === 'FLAG-CRITICAL' ? '✗' : '⚠';
        console.log(`  [${i + 1}/${shotsToCheck.length}] Shot ${shotNum}: ${icon} ${parsed.verdict}${parsed.issues.length > 0 ? ' -- ' + parsed.issues[0] : ''}`);
      } catch (err) {
        results.push({
          shotNumber: shot.shotNumber, type: shot.type, characters: shot.characters,
          verdict: 'FLAG-LOW', issues: [`QA analysis failed: ${err}`], notes: 'Vision API error',
        });
        console.warn(`  [${i + 1}/${shotsToCheck.length}] Shot ${shotNum}: QA failed - ${err}`);
      }
    }

    // Persist QA report
    const report = {
      episode: opts.episode,
      model: opts.model,
      analyzedAt: new Date().toISOString(),
      summary: {
        total: results.length,
        pass: results.filter(r => r.verdict === 'PASS').length,
        flagCritical: results.filter(r => r.verdict === 'FLAG-CRITICAL').length,
        flagModerate: results.filter(r => r.verdict === 'FLAG-MODERATE').length,
        flagLow: results.filter(r => r.verdict === 'FLAG-LOW').length,
      },
      results,
    };

    const reportPath = join(episodeDir, 'qa-report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`QA Report: ${report.summary.pass} PASS, ${report.summary.flagCritical} CRITICAL, ${report.summary.flagModerate} MODERATE, ${report.summary.flagLow} LOW`);
    console.log(`Report saved: ${reportPath}`);

    if (report.summary.flagCritical > 0) {
      console.log(`\n${report.summary.flagCritical} critical issue(s) found. Fix panels before proceeding.`);
      const criticalShots = results.filter(r => r.verdict === 'FLAG-CRITICAL');
      for (const r of criticalShots) {
        console.log(`  Shot ${String(r.shotNumber).padStart(3, '0')}: ${r.issues.join(', ')}`);
      }
    } else {
      console.log(`\nNo critical issues. Run: qa-approve -p ${series.outputDir} -e ${opts.episode}`);
    }
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
  });

// ── generate-videos ───────────────────────────────────────────────────
program
  .command('generate-videos')
  .description('Generate video clips from storyboard panels (with native audio)')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--skip-qa', 'Skip QA approval check', false)
  .option('--no-seedance-keyframe', 'Disable the automatic Seedance R2V → Wan 2.7 keyframe pipeline for this run (see AGENTS.md rule 32).')
  .action(async (opts: { project: string; episode: number; skipQa: boolean; seedanceKeyframe: boolean }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const script = await loadEpisodeScript(series, opts.episode);
    if (!script) { console.error(`Episode ${opts.episode} script not found.`); process.exit(1); }

    const episodeDir = getEpisodeDir(series, opts.episode);
    const qaPath = join(episodeDir, 'qa-approved.json');
    if (!opts.skipQa && !existsSync(qaPath)) {
      console.error('QA approval required before video generation.');
      console.error('Run /qa-storyboard to review panels, then: qa-approve -p <project> -e <episode>');
      console.error('Or bypass with: generate-videos ... --skip-qa');
      process.exit(1);
    }

    // commander's --no-<flag> negates the camelCase option. When the user
    // passes --no-seedance-keyframe we flip the series-level default for
    // this run only (no persisted change to series.json).
    if (opts.seedanceKeyframe === false) {
      series.videoDefaults = { ...series.videoDefaults, seedanceKeyframeForWan: false };
      console.log('Seedance R2V → Wan 2.7 keyframe pipeline DISABLED for this run.\n');
    }

    const apiKey = getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const sceneDir = join(episodeDir, 'scene-001');
    const generationPlan = buildGenerationPlan(script, series);

    console.log(`Generating videos for Episode ${opts.episode}: ${script.title}`);
    const ccModel = series.videoDefaults.characterConsistencyModel ?? DEFAULT_CHARACTER_CONSISTENCY_MODEL;
    console.log(`Models: action=${series.videoDefaults.actionModel}, atmosphere=${series.videoDefaults.atmosphereModel}, character-consistency=${ccModel}\n`);
    console.log(`Generation units: ${generationPlan.units.length}`);
    const multiUnitCount = generationPlan.units.filter(unit => unit.unitType === 'kling-multishot').length;
    if (multiUnitCount > 0) {
      console.log(`Kling multi-shot units: ${multiUnitCount}`);
    }
    const seedanceKeyframeCount = generationPlan.units.filter(unit => unit.useSeedanceKeyframe).length;
    if (seedanceKeyframeCount > 0) {
      console.log(`Seedance R2V → Wan 2.7 keyframe units: ${seedanceKeyframeCount} (~$0.85 each; AGENTS.md rule 32)`);
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
    console.log(`Next: assemble-episode -p ${series.outputDir} -e ${opts.episode}`);
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

    const apiKey = getVeniceApiKey();
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

    const apiKey = getVeniceApiKey();
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

    const apiKey = getVeniceApiKey();
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

// ── upscale-episode ───────────────────────────────────────────────────
program
  .command('upscale-episode')
  .description('Upscale a finished render to 4K via topaz-video-upscale (chunks large inputs, remuxes original audio)')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .option('-e, --episode <number>', 'Episode number (uses episode-NNN-final.mp4)', parseInt)
  .option('-i, --input <file>', 'Explicit input video (overrides -e resolution)')
  .option('-o, --output <file>', 'Output path (default: <input>-4k.mp4)')
  .option('--factor <n>', '2 or 4 (same price either way)', '4')
  .option('--segment-seconds <s>', 'Chunk length in seconds', '10')
  .option('--concurrency <n>', 'Parallel upscale jobs', '3')
  .option('--keep-work-dir', 'Keep intermediate chunks for debugging', false)
  .option('--yes', 'Skip the cost-estimate confirmation', false)
  .action(async (opts: {
    project: string; episode?: number; input?: string; output?: string;
    factor: string; segmentSeconds: string; concurrency: string;
    keepWorkDir: boolean; yes: boolean;
  }) => {
    const factor = parseInt(opts.factor, 10);
    if (factor !== 2 && factor !== 4) {
      console.error('--factor must be 2 or 4');
      process.exit(1);
    }

    let inputPath: string;
    if (opts.input) {
      inputPath = resolve(opts.input);
    } else if (opts.episode !== undefined) {
      const series = await loadSeries(resolve(opts.project));
      if (!series) { console.error('Series not found.'); process.exit(1); }
      const episodeDir = getEpisodeDir(series, opts.episode);
      const epNum = String(opts.episode).padStart(3, '0');
      inputPath = join(episodeDir, `episode-${epNum}-final.mp4`);
    } else {
      console.error('Provide -e <episode> or -i <input file>.');
      process.exit(1);
    }
    if (!existsSync(inputPath)) {
      console.error(`Input not found: ${inputPath}\nRun assemble-episode first, or pass -i <file>.`);
      process.exit(1);
    }

    const outputPath = opts.output
      ? resolve(opts.output)
      : inputPath.replace(/\.(mp4|mov)$/i, '-4k.mp4');
    if (resolve(outputPath) === resolve(inputPath)) {
      console.error('Output path must differ from input path.');
      process.exit(1);
    }

    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath], { encoding: 'utf-8' });
    const inputSeconds = parseFloat((probe.stdout || '0').trim()) || 0;
    const estimate = estimateUpscaleCostUsd(inputSeconds);
    console.log(`Input:    ${inputPath} (${inputSeconds.toFixed(1)}s)`);
    console.log(`Output:   ${outputPath}`);
    console.log(`Factor:   ${factor}x`);
    console.log(`Estimate: ~$${estimate.toFixed(2)} (~$0.12 per input second; 2x and 4x cost the same)`);
    if (!opts.yes) {
      console.log('\nRe-run with --yes to confirm and start the upscale.');
      process.exit(0);
    }

    const client = new VeniceClient(getVeniceApiKey());
    const result = await upscaleVideo(client, {
      inputPath,
      outputPath,
      factor: factor as 2 | 4,
      segmentSeconds: parseInt(opts.segmentSeconds, 10),
      concurrency: parseInt(opts.concurrency, 10),
      keepWorkDir: opts.keepWorkDir,
      onProgress: message => console.log(`  ${message}`),
    });
    console.log(`\nUpscaled master: ${result.path}`);
    console.log(`  ${result.width}x${result.height}, ${(result.sizeBytes / 1e6).toFixed(0)}MB, ${result.chunks} chunks`);
  });

// ── produce-episode ───────────────────────────────────────────────────
program
  .command('produce-episode')
  .description('Full pipeline: storyboard -> video -> music -> assembly')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--with-tts', 'Add Venice dialogue replacement for voice consistency across episodes', false)
  .option('--skip-music', 'Skip background music generation', false)
  .action(async (opts: { project: string; episode: number; withTts: boolean; skipMusic: boolean }) => {
    console.log('=== Full Episode Production Pipeline ===\n');

    console.log('Step 1: Generating storyboard panels...');
    await program.parseAsync(['', '', 'storyboard-episode', '-p', opts.project, '-e', String(opts.episode)]);

    console.log('\nStep 2: QA -- Review panels for character/setting consistency');
    console.log('  >> Run /qa-storyboard now to verify before proceeding to video generation.');
    console.log('  >> Delete and regenerate any flagged panels, then continue.\n');

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

program.parse();

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
