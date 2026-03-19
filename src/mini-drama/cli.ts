#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { resolve, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';

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
  saveEpisodeScript,
  loadEpisodeScript,
} from '../series/manager.js';
import type {
  SeriesState,
  MiniDramaCharacter,
  EpisodeScript,
  ShotScript,
} from '../series/types.js';
import {
  FEMALE_BASE_TRAITS,
  MALE_BASE_TRAITS,
  DEFAULT_ACTION_MODEL,
  DEFAULT_ATMOSPHERE_MODEL,
  DEFAULT_CHARACTER_CONSISTENCY_MODEL,
} from '../series/types.js';
import type { AestheticProfile } from '../storyboard/prompt-builder.js';
import { VeniceClient } from '../venice/client.js';
import { generateImage } from '../venice/generate.js';
import { getVeniceApiKey } from '../config.js';
import { listVoices, filterVoices, auditionVoices } from '../venice/voices.js';
import { generateDialogueForShots, generateSoundEffect, generateMusic } from '../venice/audio.js';
import type { DialogueLine } from '../venice/audio.js';

import { buildImagePrompt, buildCharacterReferencePrompt } from './prompt-builder.js';
import { generateEpisodeVideos } from './video-generator.js';
import { generateSubtitles, saveSrt } from './subtitle-generator.js';
import { fixPanel, refineWithReferences, refineStyleConsistency } from './panel-fixer.js';
import type { MultiEditModel } from '../venice/types.js';
import { assembleEpisode, collectShotVideos } from './assembler.js';
import { buildGenerationPlan, saveGenerationPlan } from './generation-planner.js';

const program = new Command();
program
  .name('mini-drama')
  .description('Mini-Drama creation pipeline using Venice AI')
  .version('1.0.0');

// ── new-series ────────────────────────────────────────────────────────
program
  .command('new-series')
  .description('Create a new mini-drama series')
  .requiredOption('-n, --name <name>', 'Series name')
  .requiredOption('--concept <concept>', 'Series concept/premise')
  .option('-g, --genre <genre>', 'Genre', 'drama')
  .option('--setting <setting>', 'General setting description', '')
  .action(async (opts: { name: string; concept: string; genre: string; setting: string }) => {
    const series = createSeries(opts.name, opts.concept, opts.genre, opts.setting);
    await saveSeries(series);

    console.log(`\nSeries created: ${series.name}`);
    console.log(`  Slug: ${series.slug}`);
    console.log(`  Genre: ${series.genre}`);
    console.log(`  Concept: ${series.concept}`);
    console.log(`  Output: ${series.outputDir}`);
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
          const imgPath = join(samplesDir, `${aes.name}.png`);
          await writeFile(imgPath, imgBuffer);
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
  .option('--skip-images', 'Skip reference image generation', false)
  .action(async (opts: {
    project: string; name: string; gender: string; age: string;
    description?: string; wardrobe: string; voiceDesc?: string; skipImages: boolean;
  }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const baseTraits = opts.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS;
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
      locked: false,
      seed,
    };

    addCharacter(series, character);

    if (!opts.skipImages && series.aesthetic) {
      const apiKey = getVeniceApiKey();
      const client = new VeniceClient(apiKey);
      const charDir = getCharacterDir(series, character.name);
      await mkdir(charDir, { recursive: true });

      const angles: ('front' | 'three-quarter' | 'profile' | 'full-body')[] = ['front', 'three-quarter', 'profile', 'full-body'];
      const filenames = ['front.png', 'three-quarter.png', 'profile.png', 'full-body.png'];

      console.log(`Generating reference images for ${character.name}...`);

      for (let i = 0; i < angles.length; i++) {
        const prompt = buildCharacterReferencePrompt(character, series.aesthetic, angles[i]);

        try {
          const response = await generateImage(client, {
            prompt,
            negative_prompt: 'deformed, blurry, bad anatomy, low quality, multiple people, text, watermark, character reference sheet, annotations, labels, inset panels, detail callouts, multi-view layout, comic panels, panel borders',
            resolution: '1K',
            aspect_ratio: '1:1',
            steps: 30,
            cfg_scale: 7,
            seed,
            safe_mode: false,
            hide_watermark: true,
          });

          if (response.images?.[0]) {
            const imgBuffer = Buffer.from(response.images[0].b64_json, 'base64');
            await writeFile(join(charDir, filenames[i]), imgBuffer);
            console.log(`  ${angles[i]}: saved`);
          }
        } catch (err) {
          console.warn(`  ${angles[i]}: failed - ${err}`);
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
  .action(async (opts: { project: string; character: string; voiceId: string; voiceName?: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const char = getCharacter(series, opts.character);
    if (!char) { console.error(`Character "${opts.character}" not found.`); process.exit(1); }

    char.voiceId = opts.voiceId;
    char.voiceName = opts.voiceName || opts.voiceId;
    char.locked = true;

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
      const baseTraits = c.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS;
      return `${c.name} (${c.gender}, ${c.age}): ${baseTraits}. ${c.fullDescription}. Wardrobe: ${c.wardrobe}. Voice: ${c.voiceDescription}`;
    }).join('\n');

    // Build aesthetic summary
    const aestheticStr = series.aesthetic
      ? `Style: ${series.aesthetic.style}\nPalette: ${series.aesthetic.palette}\nLighting: ${series.aesthetic.lighting}\nLens: ${series.aesthetic.lensCharacteristics}\nFilm: ${series.aesthetic.filmStock}`
      : 'No aesthetic locked yet.';

    const systemPrompt = `You are a scriptwriter for the mini-drama series "${series.name}".

SERIES CONCEPT: ${series.concept}
GENRE: ${series.genre}
SETTING: ${series.setting}

AESTHETIC:
${aestheticStr}

CHARACTERS:
${charSummaries}

PRIOR EPISODES:
${priorEpisodes || 'None yet.'}

SERIES REFERENCE DOCUMENTS:
${referenceContext || 'None available.'}

Your task is to write a complete episode script as a JSON object. Follow the exact format below. The script must:
- Target 58-75 seconds total duration
- Open with a visual hook in the first 3 seconds
- End on a beat that makes viewers want the next episode
- Use one scene, one location, one emotional note
- Include specific delivery cues for all dialogue
- Use the correct videoModel ("action" for movement/dialogue, "atmosphere" for establishing/static)
- End with a title card shot (3s, type "insert", FADE transition)

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
  "shots": [
    {
      "shotNumber": 1,
      "type": "establishing|dialogue|action|reaction|close-up|insert",
      "environment": "DAY_INTERIOR|DAY_EXTERIOR|NIGHT_INTERIOR|NIGHT_EXTERIOR",
      "duration": "3s|5s|8s",
      "videoModel": "action|atmosphere",
      "description": "<full visual description>",
      "panelDescription": "<optional single-frame description if description has sequential action>",
      "characters": ["<CHARACTER_NAME>"],
      "dialogue": {"character": "<NAME>", "line": "<text>", "delivery": "<specific delivery cue>"} or null,
      "sfx": "<sound effects>" or null,
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
  .option('--edit-model <model>', 'Model for multi-edit refinement', 'nano-banana-pro-edit')
  .option('--cfg-scale <number>', 'Prompt adherence (1-10, higher = stricter)', parseFloat)
  .option('--debug', 'Save prompt payloads as shot-NNN.prompt.json for debugging', false)
  .option('--skip-approval', 'Skip script approval check', false)
  .action(async (opts: { project: string; episode: number; refine: boolean; editModel: string; cfgScale?: number; debug: boolean; skipApproval: boolean }) => {
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

      if (existsSync(imgPath)) {
        skippedCount++;
        console.log(`  ${progress} Shot ${shotNum}: already exists, skipping`);
        continue;
      }

      const imagePrompt = buildImagePrompt(shot, series);

      if (opts.debug) {
        const debugPath = join(sceneDir, `shot-${shotNum}.prompt.json`);
        await writeFile(debugPath, JSON.stringify({
          shotNumber: shot.shotNumber,
          type: shot.type,
          characters: shot.characters,
          prompt: imagePrompt.prompt,
          negativePrompt: imagePrompt.negativePrompt,
          seed: imagePrompt.seed,
          cfgScale,
          generatedAt: new Date().toISOString(),
        }, null, 2), 'utf-8');
      }

      const shotStart = Date.now();

      try {
        const response = await generateImage(client, {
          prompt: imagePrompt.prompt,
          negative_prompt: imagePrompt.negativePrompt,
          resolution: '1K',
          aspect_ratio: '9:16',
          steps: 30,
          cfg_scale: cfgScale,
          seed: imagePrompt.seed,
          safe_mode: false,
          hide_watermark: true,
        });

        if (response.images?.[0]) {
          const imgBuffer = Buffer.from(response.images[0].b64_json, 'base64');
          await writeFile(imgPath, imgBuffer);

          // Venice returns WebP internally disguised as PNG -- convert immediately
          try {
            const { execSync } = await import('node:child_process');
            const header = execSync(`file -b "${imgPath}"`).toString().slice(0, 4);
            if (header === 'RIFF') {
              const tmpPath = imgPath.replace(/\.png$/, '-webp-conv.png');
              execSync(`ffmpeg -i "${imgPath}" -y "${tmpPath}" 2>/dev/null`);
              const { renameSync } = await import('node:fs');
              renameSync(tmpPath, imgPath);
            }
          } catch { /* conversion is best-effort */ }

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
          await refineWithReferences(client, series, imgPath, shot, editModel);
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

        if (styleAnchorPath && existsSync(styleAnchorPath)) {
          const refStart = Date.now();
          try {
            const aestheticStr = [
              series.aesthetic!.style,
              series.aesthetic!.palette,
              series.aesthetic!.lighting,
            ].join(', ');
            await refineStyleConsistency(client, imgPath, styleAnchorPath, aestheticStr, editModel, shot.environment);
            const elapsed = ((Date.now() - refStart) / 1000).toFixed(1);
            console.log(`  ${progress} Shot ${shotNum}: style-refined (${elapsed}s)`);
          } catch (err) {
            console.warn(`  ${progress} Shot ${shotNum}: refinement FAILED - ${err}`);
          }
        }
      }

      const pass2Elapsed = ((Date.now() - pass2Start) / 1000).toFixed(0);
      console.log(`\nPass 2 complete (${pass2Elapsed}s total)`);

      // Clean up temporary anchor
      if (styleAnchorPath && existsSync(styleAnchorPath)) {
        await unlink(styleAnchorPath);
      }
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
  .option('--edit-model <model>', 'Multi-edit model', 'nano-banana-pro-edit')
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
  .action(async (opts: { project: string; episode: number; skipQa: boolean }) => {
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

    const apiKey = getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const sceneDir = join(episodeDir, 'scene-001');
    const generationPlan = buildGenerationPlan(script);

    console.log(`Generating videos for Episode ${opts.episode}: ${script.title}`);
    const ccModel = series.videoDefaults.characterConsistencyModel ?? DEFAULT_CHARACTER_CONSISTENCY_MODEL;
    console.log(`Models: action=${series.videoDefaults.actionModel}, atmosphere=${series.videoDefaults.atmosphereModel}, character-consistency=${ccModel}\n`);
    console.log(`Generation units: ${generationPlan.units.length}`);
    const multiUnitCount = generationPlan.units.filter(unit => unit.unitType === 'kling-multishot').length;
    if (multiUnitCount > 0) {
      console.log(`Kling multi-shot units: ${multiUnitCount}\n`);
    }

    const { videoPaths, plan } = await generateEpisodeVideos(client, series, script.shots, sceneDir, generationPlan);
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
  .action(async (opts: { project: string; episode: number; prompt?: string; duration: string }) => {
    const series = await loadSeries(resolve(opts.project));
    if (!series) { console.error('Series not found.'); process.exit(1); }

    const apiKey = getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const episodeDir = getEpisodeDir(series, opts.episode);
    const audioDir = join(episodeDir, 'audio');
    await mkdir(audioDir, { recursive: true });

    const musicPrompt = opts.prompt || `Dramatic ${series.genre} background music, tension and emotion, cinematic`;
    const outputPath = join(audioDir, 'music.mp3');
    const durationSeconds = normalizeAudioDurationSeconds(opts.duration, 60);

    console.log(`Generating music: "${musicPrompt}" (${durationSeconds}s)`);
    await generateMusic(client, {
      prompt: musicPrompt,
      durationSeconds,
    }, outputPath);

    console.log(`Music saved: ${outputPath}`);
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

// ── assemble-episode ──────────────────────────────────────────────────
program
  .command('assemble-episode')
  .description('Stitch video clips + dialogue replacement + music + subtitles')
  .requiredOption('-p, --project <dir>', 'Series output directory')
  .requiredOption('-e, --episode <number>', 'Episode number', parseInt)
  .option('--no-subtitles', 'Skip subtitle burn-in')
  .option('--no-music', 'Skip background music mixing')
  .option('--no-ambient', 'Skip ambient bed mixing')
  .option('--ambient-volume <vol>', 'Ambient bed volume (0-1)', '0.3')
  .option('--no-dialogue-replace', 'Skip Venice dialogue replacement (use native model voices)')
  .option('--native-volume <vol>', 'Native audio volume when dialogue is replaced (0-1)', '0.2')
  .action(async (opts: {
    project: string; episode: number; subtitles: boolean; music: boolean;
    ambient: boolean; ambientVolume: string;
    dialogueReplace: boolean; nativeVolume: string;
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
    const useDialogueReplace = opts.dialogueReplace !== false && hasDialogueFiles;

    if (useDialogueReplace) {
      console.log(`  Dialogue replacement: ON (native audio ducked to ${Math.round(parseFloat(opts.nativeVolume) * 100)}%)`);
    } else if (opts.dialogueReplace !== false && !hasDialogueFiles) {
      console.log(`  Dialogue replacement: OFF (no TTS files found -- run override-audio --dialogue first for voice consistency)`);
    } else {
      console.log(`  Dialogue replacement: OFF (using native model voices)`);
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

    await assembleEpisode({
      videoFiles,
      outputPath,
      srtPath,
      musicPath: hasMusic ? musicPath : undefined,
      musicVolume: 0.15,
      ambientBedPath: hasAmbient ? ambientPath : undefined,
      ambientBedVolume: parseFloat(opts.ambientVolume),
      dialogueDir: useDialogueReplace ? audioDir : undefined,
      nativeAudioVolume: parseFloat(opts.nativeVolume),
      shotTrims,
      endingTitleOverlay: endingTitleShot?.titleOverlay,
    });

    const ep = series.episodes.find(e => e.number === opts.episode);
    if (ep) ep.status = 'assembled';
    await saveSeries(series);

    console.log(`\nFinal episode: ${outputPath}`);
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
