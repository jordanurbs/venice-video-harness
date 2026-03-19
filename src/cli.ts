#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { resolve, basename, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { parseFountain } from './parsers/fountain-parser.js';
import { parsePdfToTokens } from './parsers/pdf-parser.js';
import { extractScenes, extractAllCharacters } from './parsers/scene-extractor.js';
import { extractCharacterProfiles } from './characters/extractor.js';
import { buildCharacterDescriptions } from './characters/describer.js';
import { ReferenceManager } from './characters/reference-manager.js';
import { planShots } from './storyboard/shot-planner.js';
import { buildPrompt, buildVideoPrompt } from './storyboard/prompt-builder.js';
import type { AestheticProfile } from './storyboard/prompt-builder.js';
import { StoryboardAssembler } from './storyboard/assembler.js';
import { saveStoryboardHtml } from './output/html-renderer.js';
import { VeniceClient } from './venice/client.js';
import {
  createProject,
  saveProject,
  loadProject,
  getVeniceApiKey,
  createDefaultAesthetic,
  type ProjectState,
} from './config.js';
import { buildManifest } from './assembly/manifest-builder.js';
import { scaffoldRemotionProject } from './assembly/remotion-scaffold.js';

const OUTPUT_BASE = resolve('output');

const program = new Command();
program
  .name('storyboard')
  .description('Screenplay-to-Storyboard generator using Venice AI')
  .version('0.1.0');

// ── ingest-screenplay ──────────────────────────────────────────────
program
  .command('ingest')
  .description('Parse a screenplay file and extract scenes + characters')
  .argument('<path>', 'Path to .fountain or .pdf screenplay file')
  .option('-n, --name <name>', 'Project name (defaults to filename)')
  .action(async (filePath: string, opts: { name?: string }) => {
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) {
      console.error(`File not found: ${absPath}`);
      process.exit(1);
    }

    const ext = extname(absPath).toLowerCase();
    const projectName = opts.name || basename(absPath, ext);
    console.log(`Ingesting screenplay: ${absPath}`);

    // Parse based on file type
    let parsed;
    if (ext === '.fountain') {
      parsed = await parseFountain(absPath);
    } else if (ext === '.pdf') {
      parsed = await parsePdfToTokens(absPath);
    } else {
      console.error(`Unsupported file type: ${ext}. Use .fountain or .pdf`);
      process.exit(1);
    }

    console.log(`Title: ${parsed.title || 'Untitled'}`);
    console.log(`Tokens parsed: ${parsed.tokens.length}`);

    // Extract scenes
    const scenes = extractScenes(parsed);
    console.log(`Scenes extracted: ${scenes.length}`);

    // Extract characters
    const allCharacters = extractAllCharacters(scenes);
    console.log(`Characters found: ${allCharacters.length}`);
    allCharacters.forEach(c => console.log(`  - ${c}`));

    // Extract character profiles
    const profiles = extractCharacterProfiles(scenes);
    const descriptions = buildCharacterDescriptions(profiles);

    // Create project state
    const project = createProject(projectName, absPath, OUTPUT_BASE);
    project.scenes = scenes;
    project.characters = descriptions;
    await saveProject(project);

    console.log(`\nProject saved to: ${project.outputDir}`);
    console.log(`Run 'storyboard lock-characters --project ${project.outputDir}' to generate character references.`);
  });

// ── lock-characters ────────────────────────────────────────────────
program
  .command('lock-characters')
  .description('Generate reference images for character consistency')
  .requiredOption('-p, --project <dir>', 'Project output directory')
  .option('-c, --character <name>', 'Lock a specific character (default: all)')
  .action(async (opts: { project: string; character?: string }) => {
    const project = await loadProject(resolve(opts.project));
    if (!project) {
      console.error('Project not found. Run ingest first.');
      process.exit(1);
    }

    const apiKey = getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const refManager = new ReferenceManager(project.outputDir);

    const toProcess = opts.character
      ? project.characters.filter(c => c.name === opts.character?.toUpperCase())
      : project.characters;

    if (toProcess.length === 0) {
      console.error('No matching characters found.');
      process.exit(1);
    }

    console.log(`Generating reference images for ${toProcess.length} character(s)...`);

    for (const desc of toProcess) {
      // Skip characters that are already locked on disk.
      const existing = await refManager.loadReferences(desc.name);
      if (existing) {
        console.log(`\nSkipping ${desc.name} (already locked, seed: ${existing.seed})`);
        if (!project.characterLocks.find(l => l.name === desc.name)) {
          project.characterLocks.push(existing);
        }
        continue;
      }

      console.log(`\nGenerating references for ${desc.name}...`);
      console.log(`  Description: ${desc.shortDescription}`);

      const lock = await refManager.generateReferences(client, desc, project.aesthetic);
      project.characterLocks.push(lock);
      await refManager.saveReferences(lock);
      console.log(`  Locked: ${desc.name} (seed: ${lock.seed})`);
    }

    await saveProject(project);
    console.log(`\nCharacter locks saved. Run 'storyboard set-aesthetic --project ${project.outputDir}' next.`);
  });

// ── set-aesthetic ──────────────────────────────────────────────────
program
  .command('set-aesthetic')
  .description('Set the visual style for the storyboard')
  .requiredOption('-p, --project <dir>', 'Project output directory')
  .option('--style <style>', 'Visual style', 'Cinematic photography')
  .option('--palette <palette>', 'Color palette', 'warm natural palette')
  .option('--lighting <lighting>', 'Lighting style', 'natural lighting with subtle film grain')
  .option('--lens <lens>', 'Lens characteristics', 'anamorphic lens characteristics, shallow depth of field')
  .option('--film <film>', 'Film stock', '35mm Kodak Vision3 500T')
  .action(async (opts: {
    project: string;
    style: string;
    palette: string;
    lighting: string;
    lens: string;
    film: string;
  }) => {
    const project = await loadProject(resolve(opts.project));
    if (!project) {
      console.error('Project not found.');
      process.exit(1);
    }

    const aesthetic: AestheticProfile = {
      style: opts.style,
      palette: opts.palette,
      lighting: opts.lighting,
      lensCharacteristics: opts.lens,
      filmStock: opts.film,
    };

    project.aesthetic = aesthetic;
    await saveProject(project);

    console.log('Aesthetic profile set:');
    Object.entries(aesthetic).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
    console.log(`\nRun 'storyboard generate-scene --project ${project.outputDir} --scene 1' to test.`);
  });

// ── generate-scene ─────────────────────────────────────────────────
program
  .command('generate-scene')
  .description('Generate storyboard for a single scene')
  .requiredOption('-p, --project <dir>', 'Project output directory')
  .requiredOption('-s, --scene <number>', 'Scene number', parseInt)
  .action(async (opts: { project: string; scene: number }) => {
    const project = await loadProject(resolve(opts.project));
    if (!project) {
      console.error('Project not found.');
      process.exit(1);
    }

    const scene = project.scenes.find(s => s.number === opts.scene);
    if (!scene) {
      console.error(`Scene ${opts.scene} not found. Available: ${project.scenes.map(s => s.number).join(', ')}`);
      process.exit(1);
    }

    const aesthetic = project.aesthetic || createDefaultAesthetic();
    const apiKey = getVeniceApiKey();
    const client = new VeniceClient(apiKey);

    console.log(`\nGenerating storyboard for Scene ${scene.number}: ${scene.heading}`);
    console.log(`Characters: ${scene.characters.join(', ')}`);

    // Plan shots
    const shots = planShots(scene);
    console.log(`Planned ${shots.length} shots`);

    // Build character maps
    const descMap = new Map(project.characters.map(c => [c.name, c]));

    // Load full character locks from disk (with reference images)
    const refManager = new ReferenceManager(project.outputDir);
    const lockMap = new Map<string, import('./characters/reference-manager.js').CharacterLock>();
    for (const cl of project.characterLocks) {
      const full = await refManager.loadReferences(cl.name);
      if (full) {
        lockMap.set(cl.name, full);
      }
    }

    // Build prompts (image + video)
    const promptResults = shots.map(shot =>
      buildPrompt(shot, scene, aesthetic, descMap, lockMap)
    );
    const videoPrompts = shots.map(shot =>
      buildVideoPrompt(shot, scene, aesthetic)
    );

    // Generate images (with video prompt metadata)
    const assembler = new StoryboardAssembler(project.outputDir);
    const panels = await assembler.generateScene(
      scene.number, scene, shots, promptResults, client, videoPrompts
    );

    console.log(`Generated ${panels.length} panels for Scene ${scene.number}`);

    // Compile and save HTML (use full locks with reference images)
    const storyboard = await assembler.compileStoryboard(
      project.name,
      new Map([[scene.number, panels]]),
      [scene],
      Array.from(lockMap.values()),
      aesthetic,
    );

    const htmlPath = await saveStoryboardHtml(
      storyboard,
      resolve(project.outputDir, `scene-${scene.number}-storyboard.html`),
    );
    console.log(`Storyboard HTML saved to: ${htmlPath}`);

    project.completedScenes.push(scene.number);
    await saveProject(project);
  });

// ── generate-all ───────────────────────────────────────────────────
program
  .command('generate-all')
  .description('Generate storyboard for all scenes')
  .requiredOption('-p, --project <dir>', 'Project output directory')
  .option('--skip-completed', 'Skip already completed scenes', false)
  .action(async (opts: { project: string; skipCompleted: boolean }) => {
    const project = await loadProject(resolve(opts.project));
    if (!project) {
      console.error('Project not found.');
      process.exit(1);
    }

    const aesthetic = project.aesthetic || createDefaultAesthetic();
    const apiKey = getVeniceApiKey();
    const client = new VeniceClient(apiKey);
    const assembler = new StoryboardAssembler(project.outputDir);

    const descMap = new Map(project.characters.map(c => [c.name, c]));

    // Load full character locks from disk (with reference images)
    const refManager = new ReferenceManager(project.outputDir);
    const lockMap = new Map<string, import('./characters/reference-manager.js').CharacterLock>();
    for (const cl of project.characterLocks) {
      const full = await refManager.loadReferences(cl.name);
      if (full) {
        lockMap.set(cl.name, full);
      }
    }
    console.log(`Loaded ${lockMap.size} character locks with reference images`);

    const scenesToProcess = opts.skipCompleted
      ? project.scenes.filter(s => !project.completedScenes.includes(s.number))
      : project.scenes;

    console.log(`Generating storyboard for ${scenesToProcess.length} scenes...`);

    const allPanels = new Map<number, import('./storyboard/assembler.js').StoryboardPanel[]>();

    for (const scene of scenesToProcess) {
      console.log(`\n── Scene ${scene.number}: ${scene.heading} ──`);

      const shots = planShots(scene);
      console.log(`  ${shots.length} shots planned`);

      const promptResults = shots.map(shot =>
        buildPrompt(shot, scene, aesthetic, descMap, lockMap)
      );
      const videoPrompts = shots.map(shot =>
        buildVideoPrompt(shot, scene, aesthetic)
      );

      const panels = await assembler.generateScene(
        scene.number, scene, shots, promptResults, client, videoPrompts
      );

      allPanels.set(scene.number, panels);
      project.completedScenes.push(scene.number);
      console.log(`  ${panels.length} panels generated`);
    }

    // Compile full storyboard (use full locks with reference images)
    const storyboard = await assembler.compileStoryboard(
      project.name,
      allPanels,
      project.scenes,
      Array.from(lockMap.values()),
      aesthetic,
    );

    const htmlPath = await saveStoryboardHtml(
      storyboard,
      resolve(project.outputDir, 'storyboard-full.html'),
    );
    console.log(`\nFull storyboard saved to: ${htmlPath}`);
    await saveProject(project);
  });

// ── assemble ──────────────────────────────────────────────────────
program
  .command('assemble')
  .description('Build a Remotion project from generated video clips and render the final film')
  .requiredOption('-p, --project <dir>', 'Project output directory')
  .option('--scaffold-only', 'Only scaffold the Remotion project, skip rendering', false)
  .option('--render-scene <number>', 'Render a single scene instead of the full film', parseInt)
  .action(async (opts: { project: string; scaffoldOnly: boolean; renderScene?: number }) => {
    const project = await loadProject(resolve(opts.project));
    if (!project) {
      console.error('Project not found. Run ingest first.');
      process.exit(1);
    }

    // Step 1: Build manifest from MP4s + video.json + ffprobe
    console.log('Building shot manifest...');
    const manifest = await buildManifest(project);

    if (manifest.totalShots === 0) {
      console.error('No video clips found. Generate videos first.');
      process.exit(1);
    }

    // Step 2: Scaffold the Remotion project
    const { remotionDir, manifestPath, publicDir } = await scaffoldRemotionProject(
      project.outputDir,
      manifest,
    );

    // Step 3: Install dependencies
    console.log('\nInstalling Remotion dependencies...');
    const { execSync } = await import('node:child_process');
    try {
      execSync('npm install', {
        cwd: remotionDir,
        stdio: 'inherit',
        timeout: 120000,
      });
    } catch (err) {
      console.error('Failed to install dependencies. You can install manually:');
      console.error(`  cd ${remotionDir} && npm install`);
      process.exit(1);
    }

    if (opts.scaffoldOnly) {
      console.log(`\nRemotion project scaffolded at: ${remotionDir}`);
      console.log(`Preview: cd ${remotionDir} && npx remotion preview src/index.ts --public-dir="${publicDir}"`);
      console.log(`Render:  cd ${remotionDir} && npx remotion render src/index.ts Film --codec=h264 --crf=18 --public-dir="${publicDir}"`);
      return;
    }

    // Step 4: Render
    const compositionId = opts.renderScene
      ? `Scene${opts.renderScene}`
      : 'Film';
    const outputFile = opts.renderScene
      ? resolve(project.outputDir, `scene-${opts.renderScene}-assembled.mp4`)
      : resolve(project.outputDir, `${project.name}-final.mp4`);

    console.log(`\nRendering ${compositionId} to ${outputFile}...`);
    try {
      execSync(
        `npx remotion render src/index.ts ${compositionId} "${outputFile}" --codec=h264 --crf=18 --public-dir="${publicDir}"`,
        {
          cwd: remotionDir,
          stdio: 'inherit',
          timeout: 600000, // 10 min max
        },
      );
      console.log(`\nRendered: ${outputFile}`);
    } catch (err) {
      console.error('Render failed. You can retry manually:');
      console.error(`  cd ${remotionDir} && npx remotion render src/index.ts ${compositionId} "${outputFile}" --codec=h264 --crf=18 --public-dir="${publicDir}"`);
      process.exit(1);
    }
  });

program.parse();
